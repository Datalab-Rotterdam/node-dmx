/**
 * Art-Net 4 sender (ArtDMX + auxiliary opcodes).
 * @module artnet/sender
 *
 * Spec reference:
 * - Art-Net 4 Specification (OpDmx, OpSync, OpPoll, OpDiagData, OpTimeCode, OpTrigger)
 *   https://art-net.org.uk/downloads/art-net.pdf
 */
import {createSocket, type Socket} from 'dgram';
import {EventEmitter} from 'events';
import {ARTNET_PORT} from './constants';
import {
    buildArtCommand,
    buildArtDiagData,
    buildArtDmx,
    buildArtPoll,
    buildArtSync,
    buildArtTimeCode,
    buildArtTrigger,
    type ArtDiagDataOptions,
    type ArtDmxOptions,
    type ArtPollOptions,
    type ArtTimeCode,
    type ArtTrigger,
} from './packet';
import {directedBroadcastAddress} from './util';

export type ArtNetSenderConfiguration = {
    /**
     * 1-based universe number sent in OpDmx packet Port-Address fields
     * (universe 1 = Port-Address 0). Ignored when `portAddress` is set.
     */
    universe?: number;
    /** Raw 15-bit Port-Address (0-32767). Takes precedence over `universe`. */
    portAddress?: number;
    /**
     * Destination node IP/hostname. Defaults to the directed broadcast address
     * of `bindAddress`'s subnet, or `255.255.255.255` when that is unknown.
     */
    host?: string;
    /** Destination UDP port. Defaults to 6454. */
    port?: number;
    /** Local interface/bind address. */
    bindAddress?: string;
    /** Enable socket broadcast mode. */
    broadcast?: boolean;
    /** Physical output port metadata in OpDmx. */
    physical?: number;
    /** Auto-increment Art-Net sequence byte when true. */
    sequence?: boolean;
};

export interface ArtNetSenderEvents {
    /** Low-level socket send/bind errors. */
    error: [Error];
}

/** Sends Art-Net packets (OpDmx and optional auxiliary opcodes). */
export class ArtNetSender extends EventEmitter<ArtNetSenderEvents> {
    private readonly socket: Socket;
    private readonly config: ArtNetSenderConfiguration;
    private readonly ready: Promise<void>;
    private readonly host: string;
    private sequence = 0;
    private closed = false;

    /**
     * Create an Art-Net sender.
     * @param config Art-Net transport configuration.
     */
    constructor(config: ArtNetSenderConfiguration) {
        super();
        if (config.universe === undefined && config.portAddress === undefined) {
            throw new RangeError('ArtNetSender requires either `universe` or `portAddress`');
        }
        // Validate addressing eagerly so misconfiguration fails at construction.
        buildArtDmx({universe: config.universe, portAddress: config.portAddress, sequence: 0, data: new Uint8Array(2)});

        this.config = config;
        this.host = config.host
            ?? (config.bindAddress ? directedBroadcastAddress(config.bindAddress) : undefined)
            ?? '255.255.255.255';
        this.socket = createSocket('udp4');
        this.socket.on('error', (err) => {
            // Never let a socket error crash the process when nobody listens.
            if (this.listenerCount('error') > 0) this.emit('error', err);
        });
        // setBroadcast() throws EBADF until the socket is bound, so bind first
        // (ephemeral port unless an explicit address is requested) and gate
        // every send on that.
        this.ready = new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            this.socket.once('error', onError);
            this.socket.bind(config.bindAddress ? {address: config.bindAddress, port: 0} : {port: 0}, () => {
                this.socket.off('error', onError);
                try {
                    if (config.broadcast) this.socket.setBroadcast(true);
                    resolve();
                } catch (err) {
                    reject(err as Error);
                }
            });
        });
        // Surface the failure on the first send instead of as an unhandled rejection.
        this.ready.catch(() => undefined);
    }

    /**
     * Send a raw DMX frame as ArtDMX. Frames shorter than 2 bytes or of odd
     * length are zero-padded, as Art-Net requires an even length of 2-512.
     */
    public async sendRaw(data: Uint8Array | Buffer, options?: Partial<ArtDmxOptions>): Promise<void> {
        const sequence = this.config.sequence ? this.nextSequence() : 0;
        const packet = buildArtDmx({
            universe: this.config.universe,
            portAddress: this.config.portAddress,
            sequence,
            physical: this.config.physical,
            data,
            length: options?.length,
        });
        await this.sendPacket(packet);
    }

    /**
     * Send an ArtSync pulse (used to synchronize multiple universes).
     */
    public async sendSync(): Promise<void> {
        await this.sendPacket(buildArtSync());
    }

    /**
     * Broadcast an ArtPoll request.
     */
    public async sendPoll(options?: ArtPollOptions): Promise<void> {
        await this.sendPacket(buildArtPoll(options));
    }

    /**
     * Send a diagnostic message (OpDiagData).
     */
    public async sendDiagnostics(options: ArtDiagDataOptions): Promise<void> {
        await this.sendPacket(buildArtDiagData(options));
    }

    /**
     * Send timecode to Art-Net nodes.
     */
    public async sendTimeCode(timeCode: ArtTimeCode): Promise<void> {
        await this.sendPacket(buildArtTimeCode(timeCode));
    }

    /**
     * Send a textual ArtCommand.
     */
    public async sendCommand(command: string): Promise<void> {
        await this.sendPacket(buildArtCommand(command));
    }

    /**
     * Send an ArtTrigger event.
     */
    public async sendTrigger(trigger: ArtTrigger): Promise<void> {
        await this.sendPacket(buildArtTrigger(trigger));
    }

    /**
     * Close the UDP socket. Safe to call more than once.
     */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.socket.close();
        } catch {
            // Already closed.
        }
    }

    private nextSequence(): number {
        this.sequence = (this.sequence + 1) & 0xff;
        if (this.sequence === 0) this.sequence = 1;
        return this.sequence;
    }

    private async sendPacket(packet: Buffer): Promise<void> {
        if (this.closed) throw new Error('ArtNetSender is closed');
        await this.ready;
        const port = this.config.port ?? ARTNET_PORT;
        await new Promise<void>((resolve, reject) => {
            this.socket.send(packet, port, this.host, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}
