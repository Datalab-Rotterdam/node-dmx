import {EventEmitter} from 'events';
import type {RemoteInfo} from 'dgram';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

class MockSocket extends EventEmitter {
    public writes: Buffer[] = [];
    public ended = false;
    public destroyed = false;
    /** When set, write callbacks receive this error. */
    public writeError: Error | null = null;
    /** When set, write callbacks are queued here instead of being called. */
    public pendingWriteCallbacks: Array<(err?: Error | null) => void> | null = null;
    /** When set, end() emits 'close' asynchronously (like a real socket). */
    public asyncClose = false;

    public write(chunk: Buffer | Uint8Array, cb?: (err?: Error | null) => void): boolean {
        this.writes.push(Buffer.from(chunk));
        if (this.pendingWriteCallbacks && cb) this.pendingWriteCallbacks.push(cb);
        else cb?.(this.writeError);
        return true;
    }

    public end(): void {
        this.ended = true;
        this.destroyed = true;
        if (this.asyncClose) setImmediate(() => this.emit('close', false));
        else this.emit('close', false);
    }

    public destroy(error?: Error): this {
        if (this.destroyed) return this;
        this.destroyed = true;
        if (error) this.emit('error', error);
        this.emit('close', !!error);
        return this;
    }
}

const sockets: MockSocket[] = [];

vi.mock('net', () => ({
    createConnection: vi.fn(() => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
    }),
}));

vi.mock('tls', () => ({
    connect: vi.fn(() => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
    }),
}));

import {
    __testUtils,
    BrokerSessionState,
    BrokerVector,
    buildRdmnetPacket,
    buildRdmnetTcpPacket,
    ConnectionStatusCode,
    decodeBrokerMessage,
    decodeLlrpMessage,
    decodeRptMessage,
    encodeBrokerMessage,
    encodeLlrpMessage,
    encodeRptMessage,
    LLRP_BROADCAST_CID,
    LlrpComponentType,
    LlrpManager,
    LlrpTarget,
    LlrpVector,
    parseRdmnetPacket,
    parseRdmnetTcpPacket,
    PIDS,
    RdmCommandClass,
    RdmnetClient,
    RdmnetRootVector,
    RdmResponder,
    RdmResponseType,
    RptVector,
    UID_MAX,
    UID_MIN,
    type RdmRequest,
    type RdmResponse,
    type RptHeader,
} from '../src';

const uid = {manufacturerId: 0x7a70, deviceId: 0x00000001};
const deviceUid = {manufacturerId: 0x1234, deviceId: 0x01020304};
const rinfo: RemoteInfo = {address: '127.0.0.1', family: 'IPv4', port: 5569, size: 0};
const parseWrite = (buf: Buffer | undefined) => parseRdmnetTcpPacket(buf!)[0]!;

const request: RdmRequest = {
    destinationUid: deviceUid,
    sourceUid: uid,
    transactionNumber: 1,
    portId: 1,
    subDevice: 0,
    commandClass: RdmCommandClass.GET_COMMAND,
    pid: 0x0060,
    parameterData: Buffer.alloc(0),
};
const response: RdmResponse = {
    destinationUid: uid,
    sourceUid: deviceUid,
    transactionNumber: 1,
    responseType: RdmResponseType.ACK,
    messageCount: 0,
    subDevice: 0,
    commandClass: RdmCommandClass.GET_COMMAND_RESPONSE,
    pid: 0x0060,
    parameterData: Buffer.from([1, 2, 3, 4]),
};

/** Deterministic PRNG so fuzz failures are reproducible. */
function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

/** Mutates random bytes / truncates / extends `input`. */
function mutate(input: Buffer, rand: () => number): Buffer {
    const out = Buffer.from(input);
    const flips = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < flips; i++) out[Math.floor(rand() * out.length)] = Math.floor(rand() * 256);
    const mode = rand();
    if (mode < 0.2) return out.subarray(0, Math.floor(rand() * out.length));
    if (mode < 0.3) return Buffer.concat([out, Buffer.alloc(Math.floor(rand() * 8), 0xff)]);
    return out;
}

async function connectedClient(options: Partial<ConstructorParameters<typeof RdmnetClient>[0]> = {}) {
    const client = new RdmnetClient({host: '127.0.0.1', uid, ...options});
    const connectPromise = client.connect();
    const socket = sockets[sockets.length - 1]!;
    socket.emit('connect');
    await connectPromise;
    return {client, socket};
}

function connectReply(): Buffer {
    return buildRdmnetTcpPacket({
        vector: RdmnetRootVector.Broker,
        data: encodeBrokerMessage({
            vector: BrokerVector.ConnectReply,
            connectionStatus: ConnectionStatusCode.Ok,
            e133Version: 1,
            brokerUid: {manufacturerId: 0x0001, deviceId: 1},
            clientUid: uid,
        }),
    });
}

beforeEach(() => {
    sockets.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('LLRP decode hardening', () => {
    const probe = encodeLlrpMessage({
        vector: LlrpVector.ProbeRequest,
        destinationCid: LLRP_BROADCAST_CID,
        transactionNumber: 1,
        lowerUid: Buffer.alloc(6, 0),
        upperUid: Buffer.alloc(6, 0xff),
        knownUids: [Buffer.alloc(6, 1)],
    });

    it('rejects a Probe Request whose data PDU length runs past the LLRP PDU', () => {
        const bad = Buffer.from(probe);
        bad.writeUInt16BE(18 + 6 * 50, 28); // claims 50 known UIDs
        expect(() => decodeLlrpMessage(bad)).toThrow(/exceeds LLRP PDU/);
        const truncated = probe.subarray(0, 27 + 10);
        truncated.writeUInt16BE(truncated.length, 1);
        expect(() => decodeLlrpMessage(Buffer.from(truncated))).toThrow(RangeError);
    });

    it('rejects an LLRP PDU length smaller than its header', () => {
        const bad = Buffer.from(probe);
        bad.writeUInt16BE(5, 1);
        expect(() => decodeLlrpMessage(bad)).toThrow(/too short/);
    });

    it('fuzzed LLRP PDUs either throw or decode to well-formed fields', () => {
        const rand = prng(1234);
        const reply = encodeLlrpMessage({
            vector: LlrpVector.ProbeReply,
            destinationCid: Buffer.alloc(16, 3),
            transactionNumber: 2,
            targetUid: Buffer.alloc(6, 2),
            hardwareAddress: Buffer.alloc(6, 4),
            componentType: LlrpComponentType.RptDevice,
        });
        const rdm = encodeLlrpMessage({
            vector: LlrpVector.RdmCommand,
            destinationCid: Buffer.alloc(16, 3),
            transactionNumber: 3,
            rdm: Buffer.from([0xcc, 1, 2, 3]),
        });
        for (let i = 0; i < 3000; i++) {
            const base = [probe, reply, rdm][i % 3]!;
            let decoded;
            try {
                decoded = decodeLlrpMessage(mutate(base, rand));
            } catch (err) {
                expect(err).toBeInstanceOf(Error);
                continue;
            }
            expect(decoded.destinationCid.length).toBe(16);
            if (decoded.vector === LlrpVector.ProbeRequest) {
                expect(decoded.lowerUid.length).toBe(6);
                expect(decoded.upperUid.length).toBe(6);
                for (const known of decoded.knownUids ?? []) expect(known.length).toBe(6);
            } else if (decoded.vector === LlrpVector.ProbeReply) {
                expect(decoded.targetUid.length).toBe(6);
                expect(decoded.hardwareAddress.length).toBe(6);
            } else {
                expect(decoded.rdm[0]).toBe(0xcc);
            }
        }
    });
});

describe('LLRP transport addressing and robustness', () => {
    const targetUid = {manufacturerId: 0x7a70, deviceId: 0x42};
    const managerCid = Buffer.alloc(16, 0xaa);
    const targetCid = Buffer.alloc(16, 0xbb);
    let target: LlrpTarget | undefined;
    let manager: LlrpManager | undefined;

    afterEach(() => {
        target?.close();
        manager?.close();
        target = undefined;
        manager = undefined;
    });

    const llrpDatagram = (sourceCid: Buffer, message: Parameters<typeof encodeLlrpMessage>[0]): Buffer =>
        buildRdmnetPacket({vector: RdmnetRootVector.Llrp, cid: sourceCid, data: encodeLlrpMessage(message)});

    function startedTarget(onRdmCommand?: (frame: Buffer) => Buffer | null) {
        target = new LlrpTarget({
            cid: targetCid,
            uid: targetUid,
            hardwareAddress: Buffer.from([1, 2, 3, 4, 5, 6]),
            onRdmCommand,
        });
        const sendSpy = vi.spyOn(target as unknown as {send: () => Promise<void>}, 'send').mockResolvedValue();
        // Attach the message handler without binding a real socket.
        target.on('llrpMessage', (target as unknown as {onLlrpMessage: (...a: unknown[]) => void}).onLlrpMessage);
        const socket = (target as unknown as {socket: EventEmitter}).socket;
        return {sendSpy, socket};
    }

    it('drops a malformed probe (data length past buffer) without throwing from the socket handler', () => {
        const {socket, sendSpy} = startedTarget();
        const malformed: Error[] = [];
        target!.on('malformedPacket', (err) => malformed.push(err));
        const probe = encodeLlrpMessage({
            vector: LlrpVector.ProbeRequest,
            destinationCid: LLRP_BROADCAST_CID,
            transactionNumber: 1,
            lowerUid: Buffer.alloc(6, 0),
            upperUid: Buffer.alloc(6, 0xff),
        });
        // Data PDU claims a known-UID list that isn't in the packet.
        probe.writeUInt16BE(18 + 6, 28);
        const datagram = buildRdmnetPacket({vector: RdmnetRootVector.Llrp, cid: managerCid, data: probe});
        expect(() => socket.emit('message', datagram, rinfo)).not.toThrow();
        expect(() => socket.emit('message', Buffer.from('garbage'), rinfo)).not.toThrow();
        expect(malformed).toHaveLength(2);
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('survives a fuzzed datagram stream', () => {
        const {socket} = startedTarget(() => Buffer.from([0xcc, 1]));
        const rand = prng(99);
        const base = llrpDatagram(managerCid, {
            vector: LlrpVector.ProbeRequest,
            destinationCid: LLRP_BROADCAST_CID,
            transactionNumber: 1,
            lowerUid: Buffer.alloc(6, 0),
            upperUid: Buffer.alloc(6, 0xff),
            knownUids: [Buffer.alloc(6, 9)],
        });
        for (let i = 0; i < 2000; i++) {
            expect(() => socket.emit('message', mutate(base, rand), rinfo)).not.toThrow();
        }
    });

    it('answers Probe Requests with a Probe Reply addressed to the Manager CID', async () => {
        vi.useFakeTimers();
        const {socket, sendSpy} = startedTarget();
        socket.emit('message', llrpDatagram(managerCid, {
            vector: LlrpVector.ProbeRequest,
            destinationCid: LLRP_BROADCAST_CID,
            transactionNumber: 77,
            lowerUid: Buffer.alloc(6, 0),
            upperUid: Buffer.alloc(6, 0xff),
        }), rinfo);
        await vi.advanceTimersByTimeAsync(2000);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        const [reply] = sendSpy.mock.calls[0] as unknown as [{vector: number; destinationCid: Buffer; transactionNumber: number}];
        expect(reply.vector).toBe(LlrpVector.ProbeReply);
        expect(reply.destinationCid).toEqual(managerCid);
        expect(reply.transactionNumber).toBe(77);
    });

    it('only handles RDM commands addressed to its own CID and replies to the Manager CID', async () => {
        const handler = vi.fn(() => Buffer.from([0xcc, 0x01, 0x02]));
        const {socket, sendSpy} = startedTarget(handler);
        const rdm = Buffer.from([0xcc, 0x01, 0x03]);
        socket.emit('message', llrpDatagram(managerCid, {
            vector: LlrpVector.RdmCommand,
            destinationCid: Buffer.alloc(16, 0xcd), // some other target
            transactionNumber: 5,
            rdm,
        }), rinfo);
        socket.emit('message', llrpDatagram(managerCid, {
            vector: LlrpVector.RdmCommand,
            destinationCid: LLRP_BROADCAST_CID, // RDM commands are never broadcast
            transactionNumber: 6,
            rdm,
        }), rinfo);
        await new Promise((resolve) => setImmediate(resolve));
        expect(handler).not.toHaveBeenCalled();

        socket.emit('message', llrpDatagram(managerCid, {
            vector: LlrpVector.RdmCommand,
            destinationCid: targetCid,
            transactionNumber: 7,
            rdm,
        }), rinfo);
        await new Promise((resolve) => setImmediate(resolve));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledTimes(1);
        const [reply] = sendSpy.mock.calls[0] as unknown as [{destinationCid: Buffer; transactionNumber: number}];
        expect(reply.destinationCid).toEqual(managerCid);
        expect(reply.transactionNumber).toBe(7);
    });

    it('Manager ignores Probe Replies not addressed to its CID', async () => {
        vi.useFakeTimers();
        manager = new LlrpManager({cid: managerCid});
        vi.spyOn(manager as unknown as {send: () => Promise<void>}, 'send').mockResolvedValue();
        const socket = (manager as unknown as {socket: EventEmitter}).socket;
        const probe = manager.probeOnce(UID_MIN, UID_MAX);
        const reply = (destinationCid: Buffer, id: number) => llrpDatagram(targetCid, {
            vector: LlrpVector.ProbeReply,
            destinationCid,
            transactionNumber: 1,
            targetUid: Buffer.from([0x7a, 0x70, 0, 0, 0, id]),
            hardwareAddress: Buffer.alloc(6, 1),
            componentType: LlrpComponentType.RptDevice,
        });
        socket.emit('message', reply(Buffer.alloc(16, 0x11), 1), rinfo); // someone else's
        socket.emit('message', reply(LLRP_BROADCAST_CID, 2), rinfo);
        socket.emit('message', reply(managerCid, 3), rinfo);
        await vi.advanceTimersByTimeAsync(2100);
        const replies = await probe;
        expect(replies.map((r) => r.uid.deviceId)).toEqual([3]);
    });

    it('start() is idempotent and the socket has an error listener', async () => {
        target = new LlrpTarget({uid: targetUid, hardwareAddress: Buffer.alloc(6, 1)});
        const socket = (target as unknown as {socket: EventEmitter}).socket;
        expect(socket.listenerCount('error')).toBeGreaterThan(0);
        // No user 'error' listener: a socket error must not throw.
        expect(() => socket.emit('error', new Error('boom'))).not.toThrow();
        await target.start();
        await target.start();
        expect(target.listenerCount('llrpMessage')).toBe(1);
        target.close();
        expect(() => target!.close()).not.toThrow();
    });
});

describe('mDNS parsing hardening', () => {
    const {parseDnsRecords} = __testUtils;

    function header(qd: number, an: number): Buffer {
        const h = Buffer.alloc(12);
        h.writeUInt16BE(qd, 4);
        h.writeUInt16BE(an, 6);
        return h;
    }

    it('rejects a self-referencing compression pointer instead of looping forever', () => {
        // Question name at offset 12 is a pointer to itself.
        const packet = Buffer.concat([header(1, 0), Buffer.from([0xc0, 12, 0, 12, 0, 1])]);
        expect(() => parseDnsRecords(packet)).toThrow(/compression pointer/);
    });

    it('rejects a two-pointer cycle', () => {
        // offset 12: label "a" then pointer to 16; offset 16: pointer back to 12.
        const body = Buffer.from([1, 0x61, 0xc0, 16, 0xc0, 12]);
        const packet = Buffer.concat([header(0, 1), body, Buffer.alloc(10)]);
        expect(() => parseDnsRecords(packet)).toThrow(RangeError);
    });

    it('still decodes valid compressed PTR/SRV/TXT/A records', () => {
        const parts: Buffer[] = [header(0, 4)];
        // PTR: _rdmnet._tcp.local -> b._rdmnet._tcp.local
        const svc = Buffer.from([7, ...Buffer.from('_rdmnet'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0]);
        const svcOffset = 12;
        parts.push(svc);
        const rr = (type: number, rdata: Buffer) => {
            const fixed = Buffer.alloc(10);
            fixed.writeUInt16BE(type, 0);
            fixed.writeUInt16BE(1, 2);
            fixed.writeUInt32BE(120, 4);
            fixed.writeUInt16BE(rdata.length, 8);
            return Buffer.concat([fixed, rdata]);
        };
        let offset = 12 + svc.length;
        const instanceOffset = offset + 10; // rdata of the PTR record
        const ptrRdata = Buffer.from([1, 0x62, 0xc0, svcOffset]);
        parts.push(rr(12, ptrRdata));
        offset += 10 + ptrRdata.length;
        const instPtr = Buffer.from([0xc0, instanceOffset]);
        const srvRdata = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x22, 0xb8]), Buffer.from([4, ...Buffer.from('host'), 0xc0, svcOffset + 13])]);
        parts.push(instPtr, rr(33, srvRdata));
        offset += 2 + 10 + srvRdata.length;
        parts.push(instPtr, rr(16, Buffer.from([7, ...Buffer.from('scope=x')])));
        parts.push(Buffer.from([4, ...Buffer.from('host'), 0xc0, svcOffset + 13]), rr(1, Buffer.from([10, 0, 0, 1])));
        const records = parseDnsRecords(Buffer.concat(parts));
        expect(records.map((r) => r.type)).toEqual([12, 33, 16, 1]);
        expect(records[0]!.data).toBe('b._rdmnet._tcp.local');
        expect(records[1]!.data).toMatchObject({port: 8888, target: 'host.local'});
        expect(records[2]!.data).toEqual(['scope=x']);
        expect(records[3]).toMatchObject({name: 'host.local', data: '10.0.0.1'});
    });

    it('fuzzed DNS packets never hang or throw non-Errors', () => {
        const rand = prng(7);
        const base = Buffer.concat([header(1, 1), Buffer.from([1, 0x61, 0, 0, 12, 0, 1, 0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 1, 2, 3, 4])]);
        for (let i = 0; i < 3000; i++) {
            try {
                parseDnsRecords(mutate(base, rand));
            } catch (err) {
                expect(err).toBeInstanceOf(Error);
            }
        }
    });
});

describe('RPT decode hardening', () => {
    const header: RptHeader = {sourceUid: uid, sourceEndpointId: 0, destUid: deviceUid, destEndpointId: 0, sequenceNumber: 3};

    it('rejects a zero-length RDM Command PDU instead of looping forever', () => {
        const encoded = encodeRptMessage({vector: RptVector.Notification, header, commands: [response]});
        // First RDM Command PDU starts after RPT header(28) + wrapper header(7).
        encoded.writeUInt8(0xf0, 35);
        encoded.writeUInt16BE(0, 36);
        expect(() => decodeRptMessage(encoded)).toThrow(/too short/);
    });

    it('fuzzed RPT PDUs either throw or decode', () => {
        const rand = prng(42);
        const bases = [
            encodeRptMessage({vector: RptVector.Notification, header, originalCommand: request, commands: [response, response]}),
            encodeRptMessage({vector: RptVector.Request, header, command: request}),
            encodeRptMessage({vector: RptVector.Status, header, statusCode: 1, text: 'x'}),
        ];
        for (let i = 0; i < 3000; i++) {
            try {
                decodeRptMessage(mutate(bases[i % 3]!, rand));
            } catch (err) {
                expect(err).toBeInstanceOf(Error);
            }
        }
    });

    it('carries the original command first in a Notification and splits it out on decode', () => {
        const encoded = encodeRptMessage({vector: RptVector.Notification, header, originalCommand: request, commands: [response]});
        const decoded = decodeRptMessage(encoded);
        if (decoded.vector !== RptVector.Notification) throw new Error('expected notification');
        expect(decoded.originalCommand).toMatchObject({commandClass: RdmCommandClass.GET_COMMAND, pid: 0x0060});
        expect(decoded.commands).toHaveLength(1);
        expect(decoded.commands[0]).toMatchObject({commandClass: RdmCommandClass.GET_COMMAND_RESPONSE});
    });
});

describe('RdmnetClient robustness', () => {
    it('rdmTransaction picks the RDM response when the Notification echoes the original command first', async () => {
        const {client, socket} = await connectedClient();
        const transaction = client.rdmTransaction(deviceUid, request, {timeoutMs: 1000});
        await Promise.resolve();
        const sent = decodeRptMessage(parseWrite(socket.writes[0]).data);
        socket.emit('data', buildRdmnetTcpPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.Notification,
                header: {...client.replyHeader(sent.header)},
                originalCommand: request,
                commands: [response],
            }),
        }));
        await expect(transaction).resolves.toMatchObject({commandClass: RdmCommandClass.GET_COMMAND_RESPONSE, pid: 0x0060});
    });

    it('useRdmResponder includes the original command ahead of the response', async () => {
        const {client, socket} = await connectedClient();
        client.useRdmResponder(new RdmResponder({uid, manufacturerLabel: 'Acme'}));
        const controllerUid = deviceUid;
        socket.emit('data', buildRdmnetTcpPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.Request,
                header: {sourceUid: controllerUid, sourceEndpointId: 0, destUid: uid, destEndpointId: 0, sequenceNumber: 9},
                command: {...request, destinationUid: uid, sourceUid: controllerUid, pid: PIDS.MANUFACTURER_LABEL},
            }),
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const sent = decodeRptMessage(parseWrite(socket.writes[0]).data);
        if (sent.vector !== RptVector.Notification) throw new Error('expected notification');
        // Raw wire: two RDM Command PDUs, request first.
        expect(sent.originalCommand).toMatchObject({pid: PIDS.MANUFACTURER_LABEL, commandClass: RdmCommandClass.GET_COMMAND});
        expect(sent.commands[0]!.parameterData.toString('ascii')).toBe('Acme');
    });

    it('rejects rdmTransaction cleanly while disconnected and leaves no waiter behind', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid, autoReconnect: false});
        await expect(client.rdmTransaction(deviceUid, request, {timeoutMs: 50})).rejects.toThrow(/not connected/);
        expect((client as unknown as {waiters: unknown[]}).waiters).toHaveLength(0);
    });

    it('rejects with the send error (no orphaned waiter) when the socket write fails', async () => {
        const {client, socket} = await connectedClient();
        socket.writeError = new Error('EPIPE');
        await expect(client.rdmTransaction(deviceUid, request, {timeoutMs: 50})).rejects.toThrow('EPIPE');
        await expect(client.sendRequest({vector: 1}, () => true, 50)).rejects.toThrow('EPIPE');
        await expect(client.requestClientList(50)).rejects.toThrow('EPIPE');
        await expect(client.startBrokerSession({timeoutMs: 50})).rejects.toThrow('EPIPE');
        // Session must not be stuck in "connecting" after a failed send.
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Error);
        expect((client as unknown as {waiters: unknown[]}).waiters).toHaveLength(0);
        // Let any stray timers fire: an orphaned waiter would now reject unhandled.
        await new Promise((resolve) => setTimeout(resolve, 80));
    });

    it('rejects (without an unhandled rejection) when the socket closes while a send is pending', async () => {
        const {client, socket} = await connectedClient({autoReconnect: false});
        socket.pendingWriteCallbacks = [];
        const transaction = client.rdmTransaction(deviceUid, request, {timeoutMs: 1000});
        socket.emit('close', true);
        // Give the event loop a turn while the waiter is rejected but not yet awaited.
        await new Promise((resolve) => setImmediate(resolve));
        socket.pendingWriteCallbacks[0]!(null);
        await expect(transaction).rejects.toThrow(/socket closed/);
    });

    it('connect() rejects on socket error even without an error listener', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0]!;
        expect(() => socket.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
        await expect(connectPromise).rejects.toThrow('ECONNREFUSED');
        socket.emit('close', true);
        // A failed initial connect does not start the background reconnect loop.
        expect((client as unknown as {reconnectTimer: unknown}).reconnectTimer).toBeNull();
        expect(client.isConnected()).toBe(false);
    });

    it('connect() rejects when the socket closes before connecting', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        sockets[0]!.emit('close', false);
        await expect(connectPromise).rejects.toThrow(/closed before connect/);
    });

    it('drops the connection and resets the stream buffer on a framing error', async () => {
        const {client, socket} = await connectedClient({autoReconnect: false});
        const errors: Error[] = [];
        client.on('error', (err) => errors.push(err));
        socket.emit('data', Buffer.from('this is definitely not an ACN stream'));
        expect(errors[0]).toMatchObject({code: 'STREAM_FRAMING_ERROR'});
        expect(socket.destroyed).toBe(true);
        expect(client.isConnected()).toBe(false);
        expect((client as unknown as {streamBuffer: Buffer}).streamBuffer.length).toBe(0);
    });

    it('does not crash on a framing error when nobody listens for errors', async () => {
        const {client, socket} = await connectedClient({autoReconnect: false});
        expect(() => socket.emit('data', Buffer.alloc(64, 0x41))).not.toThrow();
        expect(client.isConnected()).toBe(false);
    });

    it('a late close from the old socket does not clobber a new connection', async () => {
        const {client, socket: oldSocket} = await connectedClient();
        oldSocket.asyncClose = true;
        client.disconnect();

        const reconnect = client.connect();
        const newSocket = sockets[1]!;
        newSocket.emit('connect');
        await reconnect;
        const waiter = client.waitForMessage((packet) => packet.vector === RdmnetRootVector.Broker, 1000);

        // Old socket's 'close' arrives now, after the new connection is up.
        await new Promise((resolve) => setImmediate(resolve));
        expect(oldSocket.ended).toBe(true);
        expect(client.isConnected()).toBe(true);
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.TcpConnected);
        expect(sockets).toHaveLength(2); // no reconnect was scheduled

        newSocket.emit('data', connectReply());
        await expect(waiter).resolves.toMatchObject({vector: RdmnetRootVector.Broker});
        client.disconnect();
    });

    it('restores the Broker session after an automatic reconnect', async () => {
        vi.useFakeTimers();
        const {client, socket: first} = await connectedClient({reconnectDelayMs: 100, reconnectMaxDelayMs: 100});
        const session = client.startBrokerSession({scope: 'studio', timeoutMs: 1000});
        await vi.advanceTimersByTimeAsync(0);
        first.emit('data', connectReply());
        await session;
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Connected);

        const restored = new Promise<void>((resolve) => client.once('sessionRestored', () => resolve()));
        first.emit('close', true);
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Disconnected);
        await vi.advanceTimersByTimeAsync(101);
        expect(sockets).toHaveLength(2);
        const second = sockets[1]!;
        second.emit('connect');
        await vi.advanceTimersByTimeAsync(0);

        const connectMsg = decodeBrokerMessage(parseWrite(second.writes[0]).data);
        expect(connectMsg).toMatchObject({vector: BrokerVector.Connect, scope: 'studio'});
        second.emit('data', connectReply());
        await restored;
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Connected);
        client.disconnect();
    });

    it('drops the connection when the Broker goes silent past the heartbeat timeout', async () => {
        vi.useFakeTimers();
        const {client, socket} = await connectedClient({
            autoReconnect: false,
            heartbeatIntervalMs: 0,
            heartbeatTimeoutMs: 1000,
        });
        const errors: Error[] = [];
        client.on('error', (err) => errors.push(err));
        const session = client.startBrokerSession({timeoutMs: 500});
        await vi.advanceTimersByTimeAsync(0);
        socket.emit('data', connectReply());
        await session;

        await vi.advanceTimersByTimeAsync(900);
        socket.emit('data', buildRdmnetTcpPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({vector: BrokerVector.Null}),
        }));
        await vi.advanceTimersByTimeAsync(900);
        expect(socket.destroyed).toBe(false);

        await vi.advanceTimersByTimeAsync(200);
        expect(socket.destroyed).toBe(true);
        expect(errors[0]).toMatchObject({code: 'HEARTBEAT_TIMEOUT', domain: 'timeout'});
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Disconnected);
    });

    it('writes TCP-framed packets (not the UDP preamble) on the Broker stream', async () => {
        const {client, socket} = await connectedClient();
        await client.sendPacket({vector: RdmnetRootVector.Broker, data: Buffer.from([9])});
        const raw = socket.writes[0]!;
        expect(raw.subarray(0, 12).toString('latin1')).toBe('ASC-E1.17\u0000\u0000\u0000');
        expect(raw.readUInt32BE(12)).toBe(raw.length - 16);
        expect(() => parseRdmnetPacket(raw)).toThrow();
    });
});
