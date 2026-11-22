/**
 * RDMnet broker discovery helpers (DNS-SD + mDNS browse).
 * @module rdmnet/discovery
 */
import * as dnsPromises from 'dns/promises';
import * as dgram from 'dgram';

export type RdmnetDiscoveryOptions = {
    serviceName?: string;
    domain?: string;
    timeoutMs?: number;
    iface?: string;
};

export type RdmnetServiceInstance = {
    name: string;
    host: string;
    port: number;
    addresses: string[];
    txt: Record<string, string>;
    source: 'dns-sd' | 'mdns';
};

type ParsedRecord = {
    name: string;
    type: number;
    cls: number;
    ttl: number;
    data: string | Buffer | {priority: number; weight: number; port: number; target: string} | string[];
};

const DNS_TYPE = {
    A: 1,
    PTR: 12,
    TXT: 16,
    AAAA: 28,
    SRV: 33,
};

const DEFAULT_SERVICE = '_rdmnet._tcp';
const DEFAULT_DOMAIN = 'local';

function encodeName(name: string): Buffer {
    const labels = name.split('.').filter(Boolean);
    const parts: Buffer[] = [];
    for (const label of labels) {
        const bytes = Buffer.from(label, 'utf8');
        parts.push(Buffer.from([bytes.length]));
        parts.push(bytes);
    }
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

/** Upper bound on compression-pointer jumps while decoding one name. */
const MAX_NAME_JUMPS = 128;
/** RFC 1035 maximum encoded name length. */
const MAX_NAME_LENGTH = 255;

/**
 * Decode a (possibly compressed) DNS name. Compression pointers must point
 * strictly backwards and at most {@link MAX_NAME_JUMPS} are followed, so a
 * self-referencing or cyclic pointer throws instead of looping forever.
 */
function decodeName(buffer: Buffer, offset: number): {name: string; nextOffset: number} {
    const labels: string[] = [];
    let cursor = offset;
    let consumed = 0;
    let jumped = false;
    let jumps = 0;
    let nameLength = 0;

    while (true) {
        if (cursor >= buffer.length) throw new RangeError('DNS name pointer out of bounds');
        const len = buffer[cursor]!;
        if (len === 0) {
            if (!jumped) consumed += 1;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            if (cursor + 1 >= buffer.length) throw new RangeError('DNS name compression pointer truncated');
            const ptr = ((len & 0x3f) << 8) | buffer[cursor + 1]!;
            if (ptr >= cursor) throw new RangeError('DNS name compression pointer does not point backwards');
            if (++jumps > MAX_NAME_JUMPS) throw new RangeError('DNS name has too many compression pointers');
            if (!jumped) consumed += 2;
            cursor = ptr;
            jumped = true;
            continue;
        }
        if ((len & 0xc0) !== 0) throw new RangeError(`Unsupported DNS label type 0x${len.toString(16)}`);
        const start = cursor + 1;
        const end = start + len;
        if (end > buffer.length) throw new RangeError('DNS label exceeds packet size');
        nameLength += len + 1;
        if (nameLength > MAX_NAME_LENGTH) throw new RangeError('DNS name exceeds 255 bytes');
        labels.push(buffer.toString('utf8', start, end));
        cursor = end;
        if (!jumped) consumed += 1 + len;
    }

    return {
        name: labels.join('.'),
        nextOffset: offset + consumed,
    };
}

function buildPtrQuery(questionName: string): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const qname = encodeName(questionName);
    const qtail = Buffer.alloc(4);
    qtail.writeUInt16BE(DNS_TYPE.PTR, 0);
    qtail.writeUInt16BE(1, 2);
    return Buffer.concat([header, qname, qtail]);
}

function parseTxt(data: Buffer): string[] {
    const out: string[] = [];
    let offset = 0;
    while (offset < data.length) {
        const len = data[offset] ?? 0;
        offset += 1;
        if (len === 0 || offset + len > data.length) break;
        out.push(data.toString('utf8', offset, offset + len));
        offset += len;
    }
    return out;
}

function parseDnsRecords(buffer: Buffer): ParsedRecord[] {
    if (buffer.length < 12) return [];
    const answerCount = buffer.readUInt16BE(6);
    const nsCount = buffer.readUInt16BE(8);
    const arCount = buffer.readUInt16BE(10);
    let offset = 12;

    const qd = buffer.readUInt16BE(4);
    for (let i = 0; i < qd; i++) {
        const question = decodeName(buffer, offset);
        offset = question.nextOffset + 4;
        if (offset > buffer.length) return [];
    }

    const total = answerCount + nsCount + arCount;
    const records: ParsedRecord[] = [];
    for (let i = 0; i < total; i++) {
        const name = decodeName(buffer, offset);
        offset = name.nextOffset;
        if (offset + 10 > buffer.length) break;
        const type = buffer.readUInt16BE(offset);
        const cls = buffer.readUInt16BE(offset + 2);
        const ttl = buffer.readUInt32BE(offset + 4);
        const rdLength = buffer.readUInt16BE(offset + 8);
        offset += 10;
        if (offset + rdLength > buffer.length) break;
        const rdata = buffer.subarray(offset, offset + rdLength);
        offset += rdLength;

        let data: ParsedRecord['data'] = rdata;
        if (type === DNS_TYPE.PTR) {
            data = decodeName(buffer, offset - rdLength).name;
        } else if (type === DNS_TYPE.SRV) {
            if (rdLength >= 7) {
                const priority = rdata.readUInt16BE(0);
                const weight = rdata.readUInt16BE(2);
                const port = rdata.readUInt16BE(4);
                const target = decodeName(buffer, offset - rdLength + 6).name;
                data = {priority, weight, port, target};
            }
        } else if (type === DNS_TYPE.TXT) {
            data = parseTxt(rdata);
        } else if (type === DNS_TYPE.A) {
            if (rdLength !== 4) continue;
            data = `${rdata[0]}.${rdata[1]}.${rdata[2]}.${rdata[3]}`;
        } else if (type === DNS_TYPE.AAAA) {
            if (rdLength !== 16) continue;
            const parts: string[] = [];
            for (let j = 0; j < 16; j += 2) parts.push(rdata.readUInt16BE(j).toString(16));
            data = parts.join(':');
        }

        records.push({name: name.name, type, cls, ttl, data});
    }

    return records;
}

function txtListToMap(values: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const entry of values) {
        const idx = entry.indexOf('=');
        if (idx === -1) result[entry] = '';
        else result[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return result;
}

export class RdmnetDiscovery {
    public static async discoverDnsSd(options: RdmnetDiscoveryOptions = {}): Promise<RdmnetServiceInstance[]> {
        const serviceName = options.serviceName ?? DEFAULT_SERVICE;
        const domain = options.domain ?? DEFAULT_DOMAIN;
        const fqdn = `${serviceName}.${domain}`.replace(/\.$/, '');

        const srv = await dnsPromises.resolveSrv(fqdn).catch(() => []);
        const out: RdmnetServiceInstance[] = [];
        for (const record of srv) {
            const txtRows = await dnsPromises.resolveTxt(record.name).catch(() => []);
            const txt = txtListToMap(txtRows.flat().map((v) => String(v)));
            const v4 = await dnsPromises.resolve4(record.name).catch(() => []);
            const v6 = await dnsPromises.resolve6(record.name).catch(() => []);
            out.push({
                name: fqdn,
                host: record.name,
                port: record.port,
                addresses: [...v4, ...v6],
                txt,
                source: 'dns-sd',
            });
        }
        return out;
    }

    public static async discoverMdns(options: RdmnetDiscoveryOptions = {}): Promise<RdmnetServiceInstance[]> {
        const serviceName = options.serviceName ?? `${DEFAULT_SERVICE}.${DEFAULT_DOMAIN}`;
        const timeoutMs = options.timeoutMs ?? 1200;

        return await new Promise<RdmnetServiceInstance[]>((resolve) => {
            const socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
            const instances = new Map<string, RdmnetServiceInstance>();

            // Without a listener a socket 'error' (bind/send failure) would be
            // thrown as an uncaught exception; discovery is best-effort, so
            // errors are swallowed and the timeout still resolves.
            socket.on('error', () => {});

            socket.on('message', (msg) => {
                try {
                    const records = parseDnsRecords(msg);
                    const ptrTargets = records
                        .filter((r) => r.type === DNS_TYPE.PTR && r.name === serviceName && typeof r.data === 'string')
                        .map((r) => String(r.data));

                    for (const target of ptrTargets) {
                        const srv = records.find((r) => r.type === DNS_TYPE.SRV && r.name === target);
                        if (!srv || typeof srv.data !== 'object' || Buffer.isBuffer(srv.data) || Array.isArray(srv.data)) {
                            continue;
                        }
                        const srvData = srv.data as {priority: number; weight: number; port: number; target: string};
                        const txt = records.find((r) => r.type === DNS_TYPE.TXT && r.name === target);
                        const a = records.filter((r) => (r.type === DNS_TYPE.A || r.type === DNS_TYPE.AAAA) && r.name === srvData.target);
                        const txtValues = txt && Array.isArray(txt.data) ? txt.data : [];
                        instances.set(target, {
                            name: target,
                            host: srvData.target,
                            port: srvData.port,
                            addresses: a.map((v) => String(v.data)),
                            txt: txtListToMap(txtValues),
                            source: 'mdns',
                        });
                    }
                } catch {
                    // Ignore malformed mDNS packets and keep discovery running.
                }
            });

            socket.bind(0, () => {
                try {
                    if (options.iface) socket.setMulticastInterface(options.iface);
                    const query = buildPtrQuery(serviceName);
                    socket.send(query, 5353, '224.0.0.251');
                } catch {
                    // Ignore send/bind errors; timeout handles completion.
                }
            });

            setTimeout(() => {
                try {
                    socket.close();
                } catch {
                    // Already closed (e.g. after an error).
                }
                resolve(Array.from(instances.values()));
            }, timeoutMs);
        });
    }
}

export const __testUtils = {
    buildPtrQuery,
    parseDnsRecords,
};
