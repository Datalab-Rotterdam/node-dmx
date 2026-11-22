/**
 * sACN (E1.31) sender.
 * @module sacn/sender
 */
import {type Socket, createSocket} from 'dgram';
import {EventEmitter} from 'events';
import {multicastGroup, randomCid} from './util';
import {type Options, Packet} from './packet';
import {FrameOptions} from './constants';
import {buildSyncPacket} from './extended';

export type SenderConfiguration = {
    /** Universe id (1-63999). */
    universe: number;
    /** Destination UDP port (default 5568). The sender binds an ephemeral local port. */
    port?: number;
    /** Enable socket address reuse (only relevant together with `bindPort`). */
    reuseAddr?: boolean;
    /** Optional periodic resend rate (packets/sec). */
    refreshRate?: number;
    /** Default packet metadata merged into every send. */
    defaultPacketOptions?: Partial<
        Pick<Options, 'cid' | 'sourceName' | 'priority' | 'useRawDmxValues'>
    >;
    /** Local multicast interface address. */
    iface?: string;
    /** Send unicast to this host instead of multicast group. */
    useUnicastDestination?: string;
    /** Local UDP port to bind. Defaults to `0` (ephemeral), so many senders can coexist. */
    bindPort?: number;
};

export interface SenderEvents {
    /** Emitted when periodic resend health toggles between success/failure. */
    changedResendStatus: [success: boolean];
    /** Emitted when the socket or resend loop encounters an error. Only emitted when a listener is attached. */
    error: [error: Error];
}

/** Sends E1.31 (sACN) packets for one universe over UDP. */
export class Sender extends EventEmitter<SenderEvents> {
    private readonly socket: Socket;
    private readonly port: number;
    public readonly universe: number;
    private readonly destinationIp: string;
    private readonly defaultPacketOptions: Partial<Options>;
    public readonly refreshRate: number;

    private sequence = 0;
    private syncSequence = 0;
    public resendStatus = false;
    private loopId: NodeJS.Timeout | undefined;
    private readonly ready: Promise<void>;
    private closed = false;
    private closing: Promise<void> | undefined;

    private latestPacketOptions: Omit<Options, 'sequence' | 'universe'> | undefined;

    /**
     * Create an sACN sender for one universe.
     * @param config Network and packet defaults.
     */
    constructor(config: SenderConfiguration) {
        super();

        const {
            universe,
            port = 5568,
            reuseAddr = false,
            refreshRate = 0,
            defaultPacketOptions = {},
            iface,
            useUnicastDestination,
            bindPort = 0,
        } = config;

        if (!Number.isInteger(universe) || universe < 1 || universe > 63999) {
            throw new RangeError('Universe must be between 1 and 63999 (inclusive).');
        }

        this.universe = universe;
        this.port = port;
        this.destinationIp = useUnicastDestination || multicastGroup(universe);
        // E1.31 §6.2.2: CID must uniquely identify this component for its
        // lifetime. Generate one unless the caller supplied their own.
        this.defaultPacketOptions = {
            cid: randomCid(),
            ...defaultPacketOptions,
        };
        this.refreshRate = refreshRate;

        this.socket = createSocket({ type: 'udp4', reuseAddr });
        this.socket.on('error', (err) => this.emitError(err));

        // Senders don't need the well-known port: binding 5568 would collide
        // with other senders/receivers on the same host (EADDRINUSE).
        this.ready = new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            this.socket.once('error', onError);
            this.socket.bind(bindPort, () => {
                this.socket.off('error', onError);
                if (iface) {
                    try {
                        this.socket.setMulticastInterface(iface);
                    } catch (err) {
                        this.emitError(err as Error);
                    }
                }
                resolve();
            });
        });
        this.ready.catch(() => undefined);

        if (refreshRate > 0) {
            const interval = 1000 / refreshRate;
            this.loopId = setInterval(() => void this.reSend(), interval);
        }
    }

    /**
     * Send a high-level payload/options object.
     * @param packet Packet fields except sequence/universe (filled automatically).
     */
    public async send(packet: Omit<Options, 'sequence' | 'universe'>): Promise<void> {
        const finalPacket: Options = {
            ...this.defaultPacketOptions,
            ...packet,
            universe: this.universe,
            sequence: this.sequence,
        };

        this.latestPacketOptions = {...packet};
        this.sequence = (this.sequence + 1) % 256;

        const {buffer} = new Packet(finalPacket);
        await this.sendBuffer(buffer);
    }

    /**
     * Send raw DMX bytes as E1.31 payload.
     * @param payload Raw DMX bytes (up to 512 used).
     * @param overrides Optional metadata overrides for this send.
     */
    public async sendRaw(
        payload: Buffer | Uint8Array,
        overrides: Omit<Options, 'sequence' | 'universe' | 'payload'> = {},
    ): Promise<void> {
        const finalPacket: Options = {
            ...this.defaultPacketOptions,
            ...overrides,
            universe: this.universe,
            sequence: this.sequence,
            payload,
        };

        this.latestPacketOptions = {payload, ...overrides};
        this.sequence = (this.sequence + 1) % 256;

        const {buffer} = new Packet(finalPacket);
        await this.sendBuffer(buffer);
    }

    /**
     * Send a Synchronization Packet (E1.31 §6) for `syncAddress` (defaults
     * to this sender's own universe). Receivers that were told to wait for
     * sync (via a data packet's `syncUniverse` field) apply their buffered
     * frame when this arrives.
     */
    public async sendSync(syncAddress: number = this.universe): Promise<void> {
        const cid = this.defaultPacketOptions.cid ?? randomCid();
        const buffer = buildSyncPacket({cid, sequence: this.syncSequence, syncAddress});
        this.syncSequence = (this.syncSequence + 1) % 256;
        await this.sendBuffer(buffer, this.unicast ? this.destinationIp : multicastGroup(syncAddress));
    }

    private async reSend(): Promise<void> {
        if (!this.latestPacketOptions || this.closed) return;

        try {
            await this.send(this.latestPacketOptions);
            this.updateResendStatus(true);
        } catch (err) {
            this.updateResendStatus(false);
            this.emitError(err as Error);
        }
    }

    private async sendBuffer(buffer: Buffer, destinationIp: string = this.destinationIp, force = false): Promise<void> {
        if (this.closed && !force) throw new Error('sACN Sender is closed');
        await this.ready;
        return new Promise((resolve, reject) => {
            this.socket.send(buffer, this.port, destinationIp, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    private updateResendStatus(success: boolean): void {
        if (success !== this.resendStatus) {
            this.resendStatus = success;
            this.emit('changedResendStatus', success);
        }
    }

    /**
     * Stop the resend loop, send Stream_Terminated packets and close the
     * socket. Returns immediately; use {@link closeAsync} to await completion.
     * Safe to call more than once.
     */
    public close(): this {
        void this.closeAsync();
        return this;
    }

    /** Like {@link close}, but resolves once termination packets are sent and the socket is closed. */
    public closeAsync(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        if (this.loopId) {
            clearInterval(this.loopId);
            this.loopId = undefined;
        }
        this.closing = this.terminateAndClose();
        return this.closing;
    }

    private get unicast(): boolean {
        return this.destinationIp !== multicastGroup(this.universe);
    }

    private emitError(err: Error): void {
        if (this.listenerCount('error') > 0) this.emit('error', err);
    }

    /**
     * E1.31 §6.2.6: a source should send at least 3 packets with
     * Stream_Terminated set before it stops, so receivers drop the
     * universe immediately instead of waiting out the source-loss timeout.
     */
    private async terminateAndClose(): Promise<void> {
        try {
            if (this.latestPacketOptions) {
                for (let i = 0; i < 3; i++) {
                    const finalPacket: Options = {
                        ...this.defaultPacketOptions,
                        ...this.latestPacketOptions,
                        options: FrameOptions.STREAM_TERMINATED,
                        universe: this.universe,
                        sequence: this.sequence,
                    };
                    this.sequence = (this.sequence + 1) % 256;
                    await this.sendBuffer(new Packet(finalPacket).buffer, this.destinationIp, true);
                }
            }
        } catch {
            // Best-effort termination; still close the socket below.
        } finally {
            await new Promise<void>((resolve) => {
                try {
                    this.socket.close(() => resolve());
                } catch {
                    resolve();
                }
            });
        }
    }
}
