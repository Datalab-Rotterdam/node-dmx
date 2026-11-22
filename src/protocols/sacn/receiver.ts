/**
 * sACN (E1.31) receiver.
 * @module sacn/receiver
 */
import { type Socket, createSocket } from 'dgram';
import { EventEmitter } from 'events';
import { AssertionError } from 'assert';

import { Packet } from './packet';
import { multicastGroup } from './util';
import { DISCOVERY_UNIVERSE, RootVector, ExtendedFrameVector } from './constants';
import {
    peekRootVector,
    peekExtendedFrameVector,
    parseSyncPacket,
    parseUniverseDiscoveryPacket,
    type ParsedSyncPacket,
    type ParsedUniverseDiscoveryPacket,
} from './extended';

/** E1.31 §6.7.1 network data loss timeout. */
export const NETWORK_DATA_LOSS_TIMEOUT_MS = 2500;

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
    /**
     * Also join the well-known Universe Discovery multicast group (E1.31 §8)
     * so `universeDiscovery` events fire for active sources.
     * @default false
     */
    discovery?: boolean;
    /**
     * Drop packets with the Preview_Data option bit set (E1.31 §6.2.6).
     * @default false
     */
    ignorePreviewData?: boolean;
    /**
     * Time without packets after which a source is considered lost and
     * `sourceLost` is emitted. Set to `0` to disable.
     * @default 2500 (E1.31 §6.7.1)
     */
    sourceTimeoutMs?: number;
}

/** Identifies one source transmitting one universe. */
export type SacnSourceInfo = {
    /** Source CID (16 bytes). */
    cid: Buffer;
    /** Source CID as lowercase hex, convenient as a map key. */
    cidHex: string;
    /** Universe the source was transmitting. */
    universe: number;
    /** Last seen source name. */
    sourceName: string;
    /** Last seen sender IP address. */
    sourceAddress?: string;
    /** Why the source went away. */
    reason: 'timeout' | 'terminated';
};

/**
 * Events emitted by the Receiver.
 */
export interface ReceiverEvents {
    /**
     * A valid sACN data packet with START Code 0x00 (dimmer levels) was received.
     */
    packet: [Packet];
    /**
     * A valid sACN data packet with a non-zero START Code (e.g. 0xDD per-address
     * priority) was received. These are never emitted as `packet`.
     */
    alternateStartCode: [Packet];
    /**
     * Packet failed validation (e.g., wrong ACN PID, invalid vector, truncated).
     */
    PacketCorruption: [AssertionError];
    /**
     * Packet was discarded as stale/duplicate per E1.31 §6.7.2 sequence rules.
     */
    PacketOutOfOrder: [Error];
    /**
     * A source stopped transmitting a universe (Stream_Terminated or timeout).
     */
    sourceLost: [SacnSourceInfo];
    /**
     * A Synchronization Packet was received (E1.31 §6).
     */
    syncPacket: [ParsedSyncPacket];
    /**
     * A Universe Discovery Packet page was received (E1.31 §8).
     */
    universeDiscovery: [ParsedUniverseDiscoveryPacket];
    /**
     * Low-level socket or system error. Only emitted when a listener is attached.
     */
    error: [Error];
}

type SourceState = {
    cid: Buffer;
    universe: number;
    sourceName: string;
    sourceAddress?: string;
    lastSequence: number;
    lastSeen: number;
    terminated: boolean;
};

/**
 * Receives sACN (E1.31) DMX512 data over UDP multicast or unicast.
 */
export class Receiver extends EventEmitter<ReceiverEvents> {
    private readonly socket: Socket;
    private readonly sources = new Map<string, SourceState>();
    private readonly universeSet: Set<number>;
    private readonly iface?: string;
    private readonly discovery: boolean;
    private readonly ignorePreviewData: boolean;
    private readonly sourceTimeoutMs: number;
    private sweepTimer: NodeJS.Timeout | undefined;
    private bound = false;
    private closed = false;

    /**
     * Create an sACN receiver and subscribe to initial universes.
     * @param props Receiver socket/universe options.
     */
    constructor({
                    universes = [1],
                    port = 5568,
                    iface,
                    reuseAddr = false,
                    discovery = false,
                    ignorePreviewData = false,
                    sourceTimeoutMs = NETWORK_DATA_LOSS_TIMEOUT_MS,
                }: ReceiverProps = {}) {
        super();

        for (const uni of universes) validateUniverse(uni);

        this.universeSet = new Set(universes);
        this.iface = iface;
        this.discovery = discovery;
        this.ignorePreviewData = ignorePreviewData;
        this.sourceTimeoutMs = sourceTimeoutMs;

        this.socket = createSocket({ type: 'udp4', reuseAddr });
        this.socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo.address));
        this.socket.on('error', (err) => this.emitError(err));

        this.socket.bind(port, () => {
            this.bound = true;
            for (const uni of this.universeSet) this.join(uni);
            if (this.discovery) this.join(DISCOVERY_UNIVERSE);
        });

        if (sourceTimeoutMs > 0) {
            this.sweepTimer = setInterval(() => this.sweep(), Math.min(500, sourceTimeoutMs));
            this.sweepTimer.unref();
        }
    }

    /** Universes this receiver is subscribed to. */
    public get universes(): number[] {
        return [...this.universeSet];
    }

    /**
     * Start listening to an additional universe.
     */
    public addUniverse(universe: number): this {
        validateUniverse(universe);
        if (this.universeSet.has(universe)) return this;
        // Before bind completes, the bind callback joins everything in the set.
        if (!this.bound || this.join(universe)) this.universeSet.add(universe);
        return this;
    }

    /**
     * Stop listening to a universe.
     */
    public removeUniverse(universe: number): this {
        if (!this.universeSet.has(universe)) return this;
        if (this.bound) {
            try {
                this.socket.dropMembership(multicastGroup(universe), this.iface);
            } catch (err) {
                this.emitError(err as Error);
                return this;
            }
        }
        this.universeSet.delete(universe);
        for (const [key, source] of this.sources) {
            if (source.universe === universe) this.sources.delete(key);
        }
        return this;
    }

    /**
     * Close the underlying socket. Safe to call more than once.
     */
    public close(callback?: () => void): this {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
        if (this.closed) {
            callback?.();
            return this;
        }
        this.closed = true;
        try {
            this.socket.close(callback);
        } catch {
            callback?.();
        }
        return this;
    }

    private join(universe: number): boolean {
        try {
            this.socket.addMembership(multicastGroup(universe), this.iface);
            return true;
        } catch (err) {
            this.emitError(err as Error);
            return false;
        }
    }

    private handleMessage(msg: Buffer, sourceAddress: string): void {
        let packet: Packet;
        try {
            if (peekRootVector(msg) === RootVector.EXTENDED) {
                const frameVector = peekExtendedFrameVector(msg);
                if (frameVector === ExtendedFrameVector.SYNCHRONIZATION) {
                    this.emit('syncPacket', parseSyncPacket(msg));
                } else if (frameVector === ExtendedFrameVector.DISCOVERY) {
                    this.emit('universeDiscovery', parseUniverseDiscoveryPacket(msg));
                }
                return;
            }
            packet = new Packet(msg, sourceAddress);
        } catch (err) {
            this.emit('PacketCorruption', toAssertionError(err));
            return;
        }

        // Ignore packets for universes we're not subscribed to
        if (!this.universeSet.has(packet.universe)) return;
        if (this.ignorePreviewData && packet.isPreview) return;

        const key = packet.cid.toString('hex') + ':' + packet.universe;
        const source = this.sources.get(key);

        if (source && !source.terminated) {
            // E1.31 §6.7.2: discard if -20 < (new - last) <= 0, using a signed 8-bit delta.
            let diff = packet.sequence - source.lastSequence;
            if (diff > 127) diff -= 256;
            if (diff < -128) diff += 256;
            if (diff <= 0 && diff > -20) {
                this.emit('PacketOutOfOrder', new Error(
                    `Stale/duplicate packet in universe ${packet.universe} ` +
                    `from ${packet.sourceName || 'unknown'} ` +
                    `(last: ${source.lastSequence}, now: ${packet.sequence})`,
                ));
                return;
            }
        }

        if (packet.isTerminated) {
            // E1.31 §6.2.6: treat as source loss immediately; report only once.
            if (source && !source.terminated) {
                source.terminated = true;
                this.emitSourceLost(source, 'terminated');
            }
            if (!source) {
                this.sources.set(key, {...this.stateFrom(packet), terminated: true});
            }
            return;
        }

        this.sources.set(key, this.stateFrom(packet));

        if (packet.startCode === 0x00) this.emit('packet', packet);
        else this.emit('alternateStartCode', packet);
    }

    private stateFrom(packet: Packet): SourceState {
        return {
            cid: packet.cid,
            universe: packet.universe,
            sourceName: packet.sourceName,
            sourceAddress: packet.sourceAddress,
            lastSequence: packet.sequence,
            lastSeen: Date.now(),
            terminated: false,
        };
    }

    private sweep(): void {
        const now = Date.now();
        for (const [key, source] of this.sources) {
            if (now - source.lastSeen < this.sourceTimeoutMs) continue;
            this.sources.delete(key);
            if (!source.terminated) this.emitSourceLost(source, 'timeout');
        }
    }

    private emitSourceLost(source: SourceState, reason: SacnSourceInfo['reason']): void {
        this.emit('sourceLost', {
            cid: source.cid,
            cidHex: source.cid.toString('hex'),
            universe: source.universe,
            sourceName: source.sourceName,
            sourceAddress: source.sourceAddress,
            reason,
        });
    }

    private emitError(err: Error): void {
        if (this.listenerCount('error') > 0) this.emit('error', err);
    }
}

function validateUniverse(universe: number): void {
    if (!Number.isInteger(universe) || universe < 1 || universe > 63999) {
        throw new RangeError(`Invalid universe ${universe}: must be 1–63999.`);
    }
}

function toAssertionError(err: unknown): AssertionError {
    if (err instanceof AssertionError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new AssertionError({ message });
}
