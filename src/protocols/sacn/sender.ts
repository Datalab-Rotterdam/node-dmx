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
    /** UDP port (default 5568). */
    port?: number;
    /** Enable socket address reuse. */
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
};

export interface SenderEvents {
    /** Emitted when periodic resend health toggles between success/failure. */
    changedResendStatus: [success: boolean];
    /** Emitted when resend loop encounters an error. */
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
        } = config;

        if (universe < 1 || universe > 63999) {
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

        this.socket.bind(port, () => {
            if (iface) {
                try {
                    this.socket.setMulticastInterface(iface);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    console.warn(`Failed to set multicast interface "${iface}":`, message);
                }
            }
        });

        if (refreshRate > 0) {
            const interval = 1000 / refreshRate;
            this.loopId = setInterval(() => this.reSend(), interval);
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
        await this.sendBuffer(buffer, multicastGroup(syncAddress));
    }

    private async reSend(): Promise<void> {
        if (!this.latestPacketOptions) return;

        try {
            await this.send(this.latestPacketOptions);
            this.updateResendStatus(true);
        } catch (err) {
            this.updateResendStatus(false);
            this.emit('error', err as Error);
        }
    }

    private sendBuffer(buffer: Buffer, destinationIp: string = this.destinationIp): Promise<void> {
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

    public close(): this {
        if (this.loopId) {
            clearInterval(this.loopId);
            this.loopId = undefined;
        }
        void this.terminateAndClose();
        return this;
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
                    await this.send({
                        ...this.latestPacketOptions,
                        options: FrameOptions.STREAM_TERMINATED,
                    });
                }
            }
        } catch {
            // Best-effort termination; still close the socket below.
        } finally {
            this.socket.close();
        }
    }
}
