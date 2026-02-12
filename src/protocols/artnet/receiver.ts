/**
 * Art-Net 4 receiver.
 * @module artnet/receiver
 */
import {createSocket, type Socket} from 'dgram';
import {EventEmitter} from 'events';

import {ARTNET_ID, ARTNET_PORT, OpCode} from './constants';
import {parseArtDmx, type ArtDmxPacket} from './packet';

/** Configuration for an Art-Net receiver. */
export type ArtNetReceiverConfiguration = {
    /**
     * Optional list of 1-based universes to accept.
     * When omitted, all ArtDMX universes are emitted.
     */
    universes?: number[];
    /** UDP port to bind to. Defaults to 6454. */
    port?: number;
    /** Local IPv4 address to bind to. Defaults to `0.0.0.0`. */
    iface?: string;
    /** Allow multiple applications to bind to same UDP port. */
    reuseAddr?: boolean;
};

/** Generic metadata for any incoming Art-Net packet. */
export type ArtNetPacketMeta = {
    opcode: number;
    sourceAddress: string;
    sourcePort: number;
    protocolVersion: number;
    raw: Buffer;
};

/** Parsed ArtDMX message with source metadata. */
export type ArtNetDmxMessage = ArtDmxPacket & {
    sourceAddress: string;
    sourcePort: number;
};

/** Events emitted by ArtNetReceiver. */
export interface ArtNetReceiverEvents {
    /** Any valid Art-Net packet. */
    packet: [ArtNetPacketMeta];
    /** Parsed ArtDMX packet (optionally filtered by universe). */
    dmx: [ArtNetDmxMessage];
    /** Parse, validation, bind, or socket errors. */
    error: [Error];
}

/** Receives Art-Net packets over UDP and emits ArtDMX frames. */
export class ArtNetReceiver extends EventEmitter<ArtNetReceiverEvents> {
    private readonly socket: Socket;
    private universeFilter: Set<number> | null;

    /**
     * Create an Art-Net receiver.
     * @param config Socket and universe filter configuration.
     */
    constructor({
                    universes,
                    port = ARTNET_PORT,
                    iface,
                    reuseAddr = false,
                }: ArtNetReceiverConfiguration = {}) {
        super();
        this.universeFilter = universes ? new Set(universes.map((u) => this.validateUniverse(u))) : null;
        this.socket = createSocket({type: 'udp4', reuseAddr});

        this.socket.on('message', (msg, rinfo) => {
            try {
                if (msg.length < 12) return;
                if (msg.toString('ascii', 0, 8) !== ARTNET_ID) return;

                const opcode = msg.readUInt16LE(8);
                const protocolVersion = msg.readUInt16BE(10);
                this.emit('packet', {
                    opcode,
                    sourceAddress: rinfo.address,
                    sourcePort: rinfo.port,
                    protocolVersion,
                    raw: Buffer.from(msg),
                });

                if (opcode !== OpCode.OpDmx) return;
                const parsed = parseArtDmx(msg);
                if (!parsed) return;
                if (this.universeFilter && !this.universeFilter.has(parsed.universe)) return;

                this.emit('dmx', {
                    ...parsed,
                    sourceAddress: rinfo.address,
                    sourcePort: rinfo.port,
                });
            } catch (err) {
                this.emit('error', err as Error);
            }
        });

        this.socket.on('error', (err) => this.emit('error', err));
        this.socket.bind({port, address: iface ?? '0.0.0.0'});
    }

    /**
     * Add a universe to the active filter.
     * If no filter existed, one is created with only this universe.
     */
    public addUniverse(universe: number): this {
        const validated = this.validateUniverse(universe);
        if (!this.universeFilter) {
            this.universeFilter = new Set([validated]);
            return this;
        }
        this.universeFilter.add(validated);
        return this;
    }

    /** Remove a universe from the active filter. */
    public removeUniverse(universe: number): this {
        const validated = this.validateUniverse(universe);
        this.universeFilter?.delete(validated);
        return this;
    }

    /** Close the underlying UDP socket. */
    public close(callback?: () => void): this {
        this.socket.close(callback);
        return this;
    }

    private validateUniverse(universe: number): number {
        if (!Number.isInteger(universe) || universe < 1 || universe > 32768) {
            throw new RangeError(`Art-Net universe must be 1-32768, got ${universe}`);
        }
        return universe;
    }
}
