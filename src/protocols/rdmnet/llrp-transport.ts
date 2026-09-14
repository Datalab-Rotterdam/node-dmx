/**
 * Real LLRP UDP multicast transport (ANSI E1.33 §6).
 * @module rdmnet/llrp-transport
 *
 * Unlike Broker/RPT (carried over the Broker TCP connection), LLRP is
 * defined to work independently of any Broker session — Managers and
 * Targets exchange UDP multicast datagrams directly. `LlrpManager`
 * implements the discovery algorithm (repeated ranged probing with a
 * known-UID exclusion list, gated by consecutive "clean" rounds) verified
 * against ETCLabs/RDMnet `src/rdmnet/core/llrp_manager.c`; `LlrpTarget`
 * implements the responder side (randomized reply backoff to reduce
 * collisions), verified against `llrp_target.c`.
 */
import {createSocket, type Socket} from 'dgram';

import {
    LLRP_CLEAN_SENDS_TO_ADVANCE,
    LLRP_KNOWN_UID_SIZE,
    LLRP_MAX_BACKOFF_MS,
    LLRP_MULTICAST_PORT,
    LLRP_MULTICAST_REQUEST_GROUP,
    LLRP_MULTICAST_RESPONSE_GROUP,
    LLRP_TIMEOUT_MS,
    RdmnetRootVector,
} from './constants';
import {
    LLRP_BROADCAST_CID,
    LlrpComponentType,
    type LlrpMessage,
    LlrpVector,
    decodeLlrpMessage,
    encodeLlrpMessage,
} from './ept-llrp';
import {buildRdmnetPacket, makeCid, parseRdmnetPacket} from './packet';
import {
    UID_MAX,
    UID_MIN,
    type UID,
    uidCompare,
    uidFromBigInt,
    uidFromBuffer,
    uidToBigInt,
    uidToBuffer,
    uidToString,
} from '../artnet/rdm/uid';

export type LlrpDiscoveredTarget = {
    uid: UID;
    hardwareAddress: Buffer;
    componentType: LlrpComponentType;
};

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function uidListIncludes(list: UID[], uid: UID): boolean {
    return list.some((u) => uidCompare(u, uid) === 0);
}

abstract class LlrpEndpoint {
    protected readonly socket: Socket;
    protected readonly cid: Buffer;
    private readonly iface?: string;
    private bound = false;

    protected constructor(cid: Buffer | undefined, iface: string | undefined) {
        this.cid = cid ? Buffer.from(cid) : makeCid();
        if (this.cid.length !== 16) throw new RangeError(`LLRP CID must be 16 bytes, got ${this.cid.length}`);
        this.iface = iface;
        this.socket = createSocket({type: 'udp4', reuseAddr: true});
    }

    protected async bind(joinGroup: string): Promise<void> {
        if (this.bound) return;
        await new Promise<void>((resolve, reject) => {
            this.socket.once('error', reject);
            this.socket.bind(LLRP_MULTICAST_PORT, () => {
                this.socket.removeListener('error', reject);
                try {
                    this.socket.addMembership(joinGroup, this.iface);
                    resolve();
                } catch (err) {
                    reject(err as Error);
                }
            });
        });
        this.bound = true;
    }

    protected send(message: LlrpMessage, destinationGroup: string): Promise<void> {
        const packet = buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            cid: this.cid,
            data: encodeLlrpMessage(message),
        });
        return new Promise<void>((resolve, reject) => {
            this.socket.send(packet, LLRP_MULTICAST_PORT, destinationGroup, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /** Returns this endpoint's CID. */
    public getCid(): Buffer {
        return Buffer.from(this.cid);
    }

    public close(): void {
        this.socket.close();
    }
}

export type LlrpManagerOptions = {
    cid?: Buffer;
    iface?: string;
};

/** Manager (Controller/Broker) side of LLRP: discovery and RDM command send. */
export class LlrpManager extends LlrpEndpoint {
    private transactionNumber = 0;

    constructor(options: LlrpManagerOptions = {}) {
        super(options.cid, options.iface);
    }

    /** Joins the response multicast group so probe replies can be received. */
    public async start(): Promise<void> {
        await this.bind(LLRP_MULTICAST_RESPONSE_GROUP);
    }

    /**
     * Runs full-range LLRP discovery: repeatedly probes (narrowing/advancing
     * the UID range and excluding already-known UIDs) until three
     * consecutive rounds yield nothing new across the whole 48-bit UID
     * space. Resolves with every Target discovered.
     */
    public async discoverTargets(): Promise<LlrpDiscoveredTarget[]> {
        const discovered = new Map<string, LlrpDiscoveredTarget>();
        let rangeLow = UID_MIN;
        let rangeHigh = UID_MAX;
        let knownInRange: UID[] = [];
        let cleanSends = 0;

        for (;;) {
            const repliesThisRound = await this.probeOnce(rangeLow, rangeHigh, knownInRange);

            let foundNew = false;
            for (const target of repliesThisRound) {
                const key = uidToString(target.uid);
                if (!discovered.has(key)) {
                    discovered.set(key, target);
                    foundNew = true;
                }
                if (!uidListIncludes(knownInRange, target.uid)) {
                    knownInRange.push(target.uid);
                }
            }

            if (knownInRange.length >= LLRP_KNOWN_UID_SIZE) {
                // Capacity fallback (llrp_manager.c): too many targets to list in
                // one Probe Request — shrink the active range to force a split.
                knownInRange.sort(uidCompare);
                const mid = knownInRange[Math.floor(knownInRange.length / 2)]!;
                rangeHigh = mid;
                knownInRange = knownInRange.filter((u) => uidCompare(u, rangeHigh) <= 0);
                cleanSends = 0;
                continue;
            }

            if (foundNew) {
                cleanSends = 0;
                continue;
            }

            cleanSends += 1;
            if (cleanSends < LLRP_CLEAN_SENDS_TO_ADVANCE) continue;

            if (uidCompare(rangeHigh, UID_MAX) >= 0) break;
            rangeLow = uidFromBigInt(uidToBigInt(rangeHigh) + 1n);
            rangeHigh = UID_MAX;
            knownInRange = [];
            cleanSends = 0;
        }

        return Array.from(discovered.values());
    }

    /** Sends one Probe Request for `[lower, upper]` (excluding `knownUids`) and collects replies for {@link LLRP_TIMEOUT_MS}. */
    public async probeOnce(lower: UID, upper: UID, knownUids: UID[] = []): Promise<LlrpDiscoveredTarget[]> {
        const transactionNumber = this.nextTransactionNumber();
        const replies: LlrpDiscoveredTarget[] = [];
        const onMessage = (msg: Buffer): void => {
            try {
                const packet = parseRdmnetPacket(msg);
                if (packet.vector !== RdmnetRootVector.Llrp) return;
                if (packet.cid.equals(this.cid)) return; // ignore multicast loopback of our own send
                const llrp = decodeLlrpMessage(packet.data);
                if (llrp.vector !== LlrpVector.ProbeReply) return;
                if (llrp.transactionNumber !== transactionNumber) return;
                replies.push({
                    uid: uidFromBuffer(llrp.targetUid),
                    hardwareAddress: llrp.hardwareAddress,
                    componentType: llrp.componentType,
                });
            } catch {
                // Ignore malformed/unrelated datagrams sharing this multicast group.
            }
        };

        this.socket.on('message', onMessage);
        try {
            await this.send(
                {
                    vector: LlrpVector.ProbeRequest,
                    destinationCid: LLRP_BROADCAST_CID,
                    transactionNumber,
                    lowerUid: uidToBuffer(lower),
                    upperUid: uidToBuffer(upper),
                    knownUids: knownUids.map(uidToBuffer),
                },
                LLRP_MULTICAST_REQUEST_GROUP,
            );
            await sleep(LLRP_TIMEOUT_MS);
        } finally {
            this.socket.off('message', onMessage);
        }
        return replies;
    }

    /** Sends a raw RDM command (frame starting with 0xCC) to one Target. */
    public async sendRdmCommand(destinationCid: Buffer, rdmFrame: Buffer): Promise<number> {
        const transactionNumber = this.nextTransactionNumber();
        await this.send(
            {vector: LlrpVector.RdmCommand, destinationCid, transactionNumber, rdm: rdmFrame},
            LLRP_MULTICAST_REQUEST_GROUP,
        );
        return transactionNumber;
    }

    /** Waits for one RDM response (frame starting with 0xCC) correlated by transaction number. */
    public waitForRdmResponse(transactionNumber: number, timeoutMs = LLRP_TIMEOUT_MS): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const onMessage = (msg: Buffer): void => {
                try {
                    const packet = parseRdmnetPacket(msg);
                    if (packet.vector !== RdmnetRootVector.Llrp) return;
                    if (packet.cid.equals(this.cid)) return; // ignore multicast loopback of our own send
                    const llrp = decodeLlrpMessage(packet.data);
                    if (llrp.vector !== LlrpVector.RdmCommand) return;
                    if (llrp.transactionNumber !== transactionNumber) return;
                    cleanup();
                    resolve(llrp.rdm);
                } catch {
                    // Ignore malformed/unrelated datagrams.
                }
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`LLRP RDM response timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const cleanup = (): void => {
                clearTimeout(timer);
                this.socket.off('message', onMessage);
            };
            this.socket.on('message', onMessage);
        });
    }

    private nextTransactionNumber(): number {
        this.transactionNumber = (this.transactionNumber + 1) >>> 0;
        return this.transactionNumber;
    }
}

export type LlrpTargetOptions = {
    cid?: Buffer;
    uid: UID;
    /** Target's lowest hardware (MAC) address, 6 bytes. */
    hardwareAddress: Buffer;
    componentType?: LlrpComponentType;
    iface?: string;
    /** Optional handler for inbound RDM commands; return the response frame (with 0xCC) or `null` to ignore. */
    onRdmCommand?: (rdmFrame: Buffer) => Buffer | null | Promise<Buffer | null>;
};

/** Target (Device/Responder) side of LLRP: answers Probe Requests, optionally handles RDM commands. */
export class LlrpTarget extends LlrpEndpoint {
    private readonly uid: UID;
    private readonly hardwareAddress: Buffer;
    private readonly componentType: LlrpComponentType;
    private readonly onRdmCommand?: LlrpTargetOptions['onRdmCommand'];

    constructor(options: LlrpTargetOptions) {
        super(options.cid, options.iface);
        if (options.hardwareAddress.length !== 6) {
            throw new RangeError(`hardwareAddress must be 6 bytes, got ${options.hardwareAddress.length}`);
        }
        this.uid = options.uid;
        this.hardwareAddress = Buffer.from(options.hardwareAddress);
        this.componentType = options.componentType ?? LlrpComponentType.RptDevice;
        this.onRdmCommand = options.onRdmCommand;
    }

    /** Joins the request multicast group and starts answering Probe Requests. */
    public async start(): Promise<void> {
        await this.bind(LLRP_MULTICAST_REQUEST_GROUP);
        this.socket.on('message', (msg) => this.handleMessage(msg));
    }

    private handleMessage(msg: Buffer): void {
        let packet;
        try {
            packet = parseRdmnetPacket(msg);
        } catch {
            return;
        }
        if (packet.vector !== RdmnetRootVector.Llrp) return;
        if (packet.cid.equals(this.cid)) return; // ignore multicast loopback of our own send
        let llrp: LlrpMessage;
        try {
            llrp = decodeLlrpMessage(packet.data);
        } catch {
            return;
        }

        if (llrp.vector === LlrpVector.ProbeRequest) {
            if (!llrp.destinationCid.equals(LLRP_BROADCAST_CID) && !llrp.destinationCid.equals(this.cid)) return;
            const lower = uidFromBuffer(llrp.lowerUid);
            const upper = uidFromBuffer(llrp.upperUid);
            if (uidCompare(this.uid, lower) < 0 || uidCompare(this.uid, upper) > 0) return;
            const known = (llrp.knownUids ?? []).map(uidFromBuffer);
            if (uidListIncludes(known, this.uid)) return;

            const backoffMs = Math.floor(Math.random() * LLRP_MAX_BACKOFF_MS);
            setTimeout(() => {
                this.sendProbeReply(llrp.transactionNumber).catch(() => {
                    // Best-effort reply; a failed send just means this round's probe misses us.
                });
            }, backoffMs);
            return;
        }

        if (llrp.vector === LlrpVector.RdmCommand && this.onRdmCommand) {
            void Promise.resolve(this.onRdmCommand(llrp.rdm)).then((response) => {
                if (!response) return;
                return this.send(
                    {vector: LlrpVector.RdmCommand, destinationCid: llrp.destinationCid, transactionNumber: llrp.transactionNumber, rdm: response},
                    LLRP_MULTICAST_RESPONSE_GROUP,
                );
            }).catch(() => {
                // Best-effort; drop malformed/failed responses rather than crash the listener.
            });
        }
    }

    private async sendProbeReply(transactionNumber: number): Promise<void> {
        await this.send(
            {
                vector: LlrpVector.ProbeReply,
                destinationCid: LLRP_BROADCAST_CID,
                transactionNumber,
                targetUid: uidToBuffer(this.uid),
                hardwareAddress: this.hardwareAddress,
                componentType: this.componentType,
            },
            LLRP_MULTICAST_RESPONSE_GROUP,
        );
    }
}
