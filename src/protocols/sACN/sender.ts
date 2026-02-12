/**
 * sACN (E1.31) sender.
 * @module sacn/sender
 */
import {type Socket, createSocket} from 'dgram';
import {EventEmitter} from 'events';
import {multicastGroup} from './util';
import {type Options, Packet} from './packet';

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
        this.defaultPacketOptions = defaultPacketOptions;
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

    private sendBuffer(buffer: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.send(buffer, this.port, this.destinationIp, (err) => {
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
        this.socket.close();
        return this;
    }
}
