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

export type ArtNetSenderConfiguration = {
    /** 1-based universe number sent in OpDmx packet Port-Address fields. */
    universe: number;
    /** Destination node IP/hostname. Defaults to broadcast. */
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
    private sequence = 0;

    /**
     * Create an Art-Net sender.
     * @param config Art-Net transport configuration.
     */
    constructor(config: ArtNetSenderConfiguration) {
        super();
        this.config = config;
        this.socket = createSocket('udp4');
        this.socket.on('error', (err) => this.emit('error', err));
        if (config.broadcast) {
            this.socket.setBroadcast(true);
        }
        if (config.bindAddress) {
            this.socket.bind({address: config.bindAddress});
        }
    }

    /**
     * Send a raw DMX frame as ArtDMX.
     */
    public async sendRaw(data: Uint8Array | Buffer, options?: Partial<ArtDmxOptions>): Promise<void> {
        const payload = Buffer.from(data);
        if (payload.length < 2) {
            throw new RangeError('ArtDMX payload must be at least 2 bytes');
        }
        const sequence = this.config.sequence ? this.nextSequence() : 0;
        const packet = buildArtDmx({
            universe: this.config.universe,
            sequence,
            physical: this.config.physical,
            data: payload,
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
     * Close the UDP socket.
     */
    public close(): void {
        this.socket.close();
    }

    private nextSequence(): number {
        this.sequence = (this.sequence + 1) & 0xff;
        if (this.sequence === 0) this.sequence = 1;
        return this.sequence;
    }

    private async sendPacket(packet: Buffer): Promise<void> {
        const host = this.config.host ?? '255.255.255.255';
        const port = this.config.port ?? ARTNET_PORT;
        await new Promise<void>((resolve, reject) => {
            this.socket.send(packet, port, host, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}
