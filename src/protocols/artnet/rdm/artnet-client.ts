/**
 * Art-Net RDM client (OpRdm / OpTodRequest / OpTodData).
 * @module artnet/rdm/artnet-client
 *
 * Spec references:
 * - Art-Net 4 Specification (RDM over Art-Net transport)
 *   https://art-net.org.uk/downloads/art-net.pdf
 * - ANSI E1.20 (RDM framing)
 *   https://getdlight.com/media/kunena/attachments/42/ANSI_E1-20_2010.pdf
 */
import {createSocket, type Socket} from 'dgram';
import {ARTNET_ID, ARTNET_PORT, OpCode} from '../constants';
import {buildArtRdm, buildArtTodRequest, parseArtRdm, parseArtTodData} from './artnet-packets';
import {decodeRdmResponse, encodeRdmRequest} from './codec';
import type {RdmRequest, RdmResponse} from './types';
import {uidCompare, uidToBigInt, type UID} from './uid';

export type ArtNetRdmClientOptions = {
    /** Target Art-Net node IP/hostname. */
    host: string;
    /** Optional local bind address (default: all interfaces). */
    bindAddress?: string;
    /** UDP destination port (defaults to Art-Net 6454). */
    port?: number;
    /** Default receive timeout in milliseconds. */
    timeoutMs?: number;
    /**
     * Local UDP port to bind. Defaults to the Art-Net port 6454, because
     * Art-Net 4 nodes send OpRdm / OpTodData replies to UDP 6454 rather than
     * to the source port of the request. Pass `0` for an ephemeral port
     * (only works with nodes that reply to the request's source port).
     *
     * If binding the requested port fails (e.g. EADDRINUSE because another
     * application holds 6454 exclusively), the client reports the error via
     * {@link ArtNetRdmClientOptions.onError} and falls back to an ephemeral port.
     *
     * Note: with `reuseAddr` several sockets may share 6454; the OS then
     * decides which socket receives a *unicast* reply (broadcasts reach all
     * of them), so avoid running several controllers on one host.
     */
    localPort?: number;
    /** Set SO_REUSEADDR on the local socket (default `true`). */
    reuseAddr?: boolean;
    /**
     * Receives socket errors (bind failures, async socket errors). Errors are
     * never thrown from the socket event handlers, so a missing handler only
     * means errors are silently dropped.
     */
    onError?: (error: Error) => void;
};

/**
 * Request accepted by {@link ArtNetRdmClient.rdmTransaction}. The transaction
 * number is optional: when omitted the client assigns its own auto-incrementing
 * (0-255, wrapping) transaction number.
 */
export type ArtNetRdmTransactionRequest = Omit<RdmRequest, 'transactionNumber'> & {transactionNumber?: number};

type PendingTransaction = {
    request: RdmRequest;
    settle: (response: RdmResponse | null) => void;
};

const BROADCAST_DEVICE_ID = 0xffffffff;

/** Minimal client for ToD and RDM transactions over Art-Net. */
export class ArtNetRdmClient {
    private socket: Socket;
    private readonly options: ArtNetRdmClientOptions;
    /** In-flight RDM transactions keyed by transaction number. */
    private readonly pending = new Map<number, PendingTransaction[]>();
    private readonly todCollectors = new Set<(msg: Buffer) => void>();
    private transactionCounter = 0;
    private bindPromise: Promise<void> | null = null;
    private bindCallback: ((err: Error | null) => void) | null = null;
    private closed = false;

    /**
     * Create an Art-Net RDM client. The UDP socket is bound lazily on first use.
     * @param options Socket and timeout options.
     */
    constructor(options: ArtNetRdmClientOptions) {
        this.options = options;
        this.socket = this.openSocket();
        if (options.bindAddress) {
            void this.ensureBound();
        }
    }

    /**
     * Return the next transaction number of this client (0-255, wrapping).
     */
    public nextTransactionNumber(): number {
        const tn = this.transactionCounter;
        this.transactionCounter = (tn + 1) & 0xff;
        return tn;
    }

    /**
     * Request the Table of Devices (ToD) for a universe. Collects OpTodData
     * replies for `universe` until the timeout expires (several nodes may
     * answer) and returns the de-duplicated UIDs.
     */
    public async getTod(universe: number, timeoutMs?: number): Promise<UID[]> {
        const packet = buildArtTodRequest({universe});
        const uids: UID[] = [];
        const seen = new Set<bigint>();
        const collector = (msg: Buffer) => {
            const tod = parseArtTodData(msg);
            if (!tod || tod.universe !== universe) return;
            for (const uid of tod.uids) {
                const key = uidToBigInt(uid);
                if (seen.has(key)) continue;
                seen.add(key);
                uids.push(uid);
            }
        };
        this.todCollectors.add(collector);
        try {
            await this.send(packet);
            const timeout = timeoutMs ?? this.options.timeoutMs ?? 1000;
            await new Promise((resolve) => setTimeout(resolve, timeout));
        } finally {
            this.todCollectors.delete(collector);
        }
        return uids;
    }

    /**
     * Send a single RDM request and wait for the matching response.
     *
     * A reply is matched by transaction number, source UID (== request
     * destination), destination UID (== request source) and command class
     * (== request command class + 1), so concurrent transactions never receive
     * each other's replies. Resolves as soon as the matching reply arrives, or
     * with `null` on timeout. Requests to a broadcast UID resolve `null`
     * immediately after sending, since E1.20 responders never answer them.
     */
    public async rdmTransaction(
        universe: number,
        request: ArtNetRdmTransactionRequest,
        timeoutMs?: number,
    ): Promise<RdmResponse | null> {
        const fullRequest: RdmRequest = {
            ...request,
            transactionNumber: (request.transactionNumber ?? this.nextTransactionNumber()) & 0xff,
        };
        const rdmPacket = encodeRdmRequest(fullRequest);
        const packet = buildArtRdm({
            universe,
            rdmPacket: rdmPacket.subarray(1),
        });

        if (fullRequest.destinationUid.deviceId === BROADCAST_DEVICE_ID) {
            await this.send(packet);
            return null;
        }

        const timeout = timeoutMs ?? this.options.timeoutMs ?? 1000;
        const key = fullRequest.transactionNumber;
        return new Promise<RdmResponse | null>((resolve, reject) => {
            let done = false;
            const entry: PendingTransaction = {
                request: fullRequest,
                settle: (response) => finish(() => resolve(response)),
            };
            const timer = setTimeout(() => entry.settle(null), timeout);
            const finish = (action: () => void) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                this.removePending(key, entry);
                action();
            };
            const list = this.pending.get(key);
            if (list) list.push(entry);
            else this.pending.set(key, [entry]);

            this.send(packet).catch((err: unknown) => finish(() => reject(err)));
        });
    }

    /**
     * Close the UDP socket. Pending transactions resolve with `null`.
     */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const list of [...this.pending.values()]) {
            for (const entry of [...list]) entry.settle(null);
        }
        this.pending.clear();
        this.todCollectors.clear();
        this.closeSocket(this.socket);
    }

    private openSocket(): Socket {
        const socket = createSocket({type: 'udp4', reuseAddr: this.options.reuseAddr ?? true});
        socket.on('message', (msg: Buffer) => this.handleMessage(msg));
        socket.on('error', (err: Error) => this.handleSocketError(socket, err));
        return socket;
    }

    private closeSocket(socket: Socket): void {
        try {
            socket.close();
        } catch {
            // Already closed.
        }
    }

    private handleSocketError(socket: Socket, err: Error): void {
        if (socket === this.socket && this.bindCallback) {
            const callback = this.bindCallback;
            this.bindCallback = null;
            callback(err);
            return;
        }
        this.reportError(err);
    }

    private reportError(err: Error): void {
        try {
            this.options.onError?.(err);
        } catch {
            // Never let a user callback crash the socket handler.
        }
    }

    private ensureBound(): Promise<void> {
        if (!this.bindPromise) {
            this.bindPromise = this.bindSocket();
        }
        return this.bindPromise;
    }

    private async bindSocket(): Promise<void> {
        const requested = this.options.localPort ?? ARTNET_PORT;
        const err = await this.tryBind(requested);
        if (!err) return;
        this.reportError(err);
        if (requested === 0 || this.closed) return;
        // Fall back to an ephemeral port on a fresh socket.
        this.closeSocket(this.socket);
        this.socket = this.openSocket();
        const fallbackErr = await this.tryBind(0);
        if (fallbackErr) this.reportError(fallbackErr);
    }

    private tryBind(port: number): Promise<Error | null> {
        return new Promise((resolve) => {
            this.bindCallback = resolve;
            try {
                this.socket.bind({port, address: this.options.bindAddress}, () => {
                    this.bindCallback = null;
                    resolve(null);
                });
            } catch (err) {
                this.bindCallback = null;
                resolve(err as Error);
            }
        });
    }

    private async send(packet: Buffer): Promise<void> {
        if (this.closed) throw new Error('ArtNetRdmClient is closed');
        await this.ensureBound();
        const port = this.options.port ?? ARTNET_PORT;
        await new Promise<void>((resolve, reject) => {
            try {
                this.socket.send(packet, port, this.options.host, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            } catch (err) {
                reject(err as Error);
            }
        });
    }

    private handleMessage(msg: Buffer): void {
        try {
            if (msg.length < 10) return;
            if (msg.toString('ascii', 0, 8) !== ARTNET_ID) return;
            const opcode = msg.readUInt16LE(8);
            if (opcode === OpCode.OpRdm) {
                this.handleRdmReply(msg);
            } else if (opcode === OpCode.OpTodData) {
                for (const collector of [...this.todCollectors]) collector(msg);
            }
        } catch {
            // Malformed packet: drop.
        }
    }

    private handleRdmReply(msg: Buffer): void {
        const response = this.extractRdm(msg);
        if (!response) return;
        const list = this.pending.get(response.transactionNumber);
        if (!list) return;
        const entry = list.find((candidate) => ArtNetRdmClient.matches(candidate.request, response));
        entry?.settle(response);
    }

    private removePending(key: number, entry: PendingTransaction): void {
        const list = this.pending.get(key);
        if (!list) return;
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0) this.pending.delete(key);
    }

    private static matches(request: RdmRequest, response: RdmResponse): boolean {
        return (
            response.transactionNumber === (request.transactionNumber & 0xff)
            && response.commandClass === request.commandClass + 1
            && uidCompare(response.sourceUid, request.destinationUid) === 0
            && uidCompare(response.destinationUid, request.sourceUid) === 0
        );
    }

    private extractRdm(buffer: Buffer): RdmResponse | null {
        const parsed = parseArtRdm(buffer);
        if (!parsed) return null;
        try {
            return decodeRdmResponse(parsed.rdmPacket);
        } catch {
            return null;
        }
    }
}
