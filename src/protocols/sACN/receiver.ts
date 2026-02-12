/**
 * sACN (E1.31) receiver.
 * @module sacn/receiver
 */
import { type Socket, createSocket } from 'dgram';
import { EventEmitter } from 'events';

import { Packet } from './packet';
import { multicastGroup } from './util';
import {AssertionError} from "node:assert";

/**
 * Configuration for an sACN (E1.31) receiver.
 */
export interface ReceiverProps {
    /**
     * List of DMX universes to listen to (1–63999).
     * @default [1]
     */
    universes?: number[];
    /**
     * UDP port to listen on.
     * @default 5568
     */
    port?: number;
    /**
     * Local IPv4 address of the network interface to use for multicast.
     */
    iface?: string;
    /**
     * Allow multiple applications to bind to the same port.
     * @default false
     */
    reuseAddr?: boolean;
}

/**
 * Events emitted by the Receiver.
 */
export interface ReceiverEvents {
    /**
     * A valid sACN packet was received.
     */
    packet: [Packet];
    /**
     * Packet failed validation (e.g., wrong ACN PID, invalid vector).
     */
    PacketCorruption: [AssertionError];
    /**
     * Packet sequence jumped unexpectedly (possible network loss or replay).
     */
    PacketOutOfOrder: [Error];
    /**
     * Low-level socket or system error.
     */
    error: [Error];
}

/**
 * Receives sACN (E1.31) DMX512 data over UDP multicast or unicast.
 */
export class Receiver extends EventEmitter<ReceiverEvents> {
    private readonly socket: Socket;
    private readonly lastSequence: Record<string, number>;
    private universes: number[];
    private readonly iface?: string;

    /**
     * Create an sACN receiver and subscribe to initial universes.
     * @param props Receiver socket/universe options.
     */
    constructor({
                    universes = [1],
                    port = 5568,
                    iface,
                    reuseAddr = false,
                }: ReceiverProps = {}) {
        super();

        // Validate universes
        for (const uni of universes) {
            if (uni < 1 || uni > 63999) {
                throw new RangeError(`Invalid universe ${uni}: must be 1–63999.`);
            }
        }

        this.universes = [...universes]; // defensive copy
        this.iface = iface;
        this.lastSequence = {};

        this.socket = createSocket({ type: 'udp4', reuseAddr });

        this.socket.on('message', (msg, rinfo) => {
            try {
                const packet = new Packet(msg, rinfo.address);

                // Ignore packets for universes we're not subscribed to
                if (!this.universes.includes(packet.universe)) {
                    return;
                }

                const key = packet.cid.toString('base64') + packet.universe;
                const lastSeq = this.lastSequence[key];
                const currentSeq = packet.sequence;

                if (lastSeq !== undefined) {
                    // Handle sequence wrap: 255 → 0 is valid
                    const diff = (currentSeq - lastSeq + 256) % 256;
                    // Allow small jumps forward (normal), but not large jumps or backwards
                    // >20 suggests packet loss, replay, or new source
                    if (diff > 20 && diff !== 1) {
                        throw new Error(
                            `Packet significantly out of order in universe ${packet.universe} ` +
                            `from ${packet.sourceName || 'unknown'} ` +
                            `(last: ${lastSeq}, now: ${currentSeq})`,
                        );
                    }
                }

                this.lastSequence[key] = currentSeq;
                this.emit('packet', packet);
            } catch (err) {
                if (err instanceof AssertionError) {
                    this.emit('PacketCorruption', err);
                } else {
                    this.emit('PacketOutOfOrder', err as Error);
                }
            }
        });

        this.socket.on('error', (err) => {
            this.emit('error', err);
        });

        this.socket.bind(port, () => {
            for (const uni of this.universes) {
                try {
                    this.socket.addMembership(multicastGroup(uni), this.iface);
                } catch (err) {
                    this.emit('error', err as Error);
                }
            }
        });
    }

    /**
     * Start listening to an additional universe.
     */
    public addUniverse(universe: number): this {
        if (universe < 1 || universe > 63999) {
            throw new RangeError(`Universe must be 1–63999, got ${universe}`);
        }
        if (this.universes.includes(universe)) return this;

        try {
            this.socket.addMembership(multicastGroup(universe), this.iface);
            this.universes.push(universe);
        } catch (err) {
            this.emit('error', err as Error);
        }
        return this;
    }

    /**
     * Stop listening to a universe.
     */
    public removeUniverse(universe: number): this {
        if (!this.universes.includes(universe)) return this;

        try {
            this.socket.dropMembership(multicastGroup(universe), this.iface);
            this.universes = this.universes.filter((u) => u !== universe);
        } catch (err) {
            this.emit('error', err as Error);
        }
        return this;
    }

    /**
     * Close the underlying socket.
     */
    public close(callback?: () => void): this {
        this.socket.close(callback);
        return this;
    }
}
