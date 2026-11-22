/**
 * Multi-source merging for received sACN data.
 * @module sacn/merger
 *
 * E1.31 §6.2.3: when several sources transmit the same universe, the highest
 * priority source wins. Sources sharing the top priority are combined; this
 * merger uses HTP (highest takes precedence) per slot, the common default.
 */
import {EventEmitter} from 'events';
import type {Packet} from './packet';
import type {Receiver, SacnSourceInfo} from './receiver';

/** Merged output for one universe. */
export type MergedUniverse = {
    universe: number;
    /** 512 merged DMX levels. */
    data: Uint8Array;
    /** Priority of the winning source(s). */
    priority: number;
    /** CIDs (hex) of the sources that contributed to `data`. */
    sources: string[];
};

export interface MergerEvents {
    /** Emitted every time a universe's merged output is recomputed. */
    merged: [MergedUniverse];
}

type SourceFrame = {priority: number; data: Uint8Array};

/**
 * Combines `packet`/`sourceLost` events from a {@link Receiver} into one
 * merged frame per universe.
 *
 * ```ts
 * const merger = new Merger(receiver);
 * merger.on('merged', ({universe, data}) => render(universe, data));
 * ```
 */
export class Merger extends EventEmitter<MergerEvents> {
    private readonly universes = new Map<number, Map<string, SourceFrame>>();
    private readonly onPacket = (packet: Packet) => this.update(packet);
    private readonly onLost = (source: SacnSourceInfo) => this.remove(source.universe, source.cidHex);

    /**
     * @param receiver Optional receiver to attach to. You can also feed
     *   packets manually with {@link update} / {@link remove}.
     */
    constructor(private readonly receiver?: Receiver) {
        super();
        receiver?.on('packet', this.onPacket);
        receiver?.on('sourceLost', this.onLost);
    }

    /** Feed one data packet (START Code 0x00) into the merger. */
    public update(packet: Packet): MergedUniverse {
        let sources = this.universes.get(packet.universe);
        if (!sources) {
            sources = new Map();
            this.universes.set(packet.universe, sources);
        }
        const data = new Uint8Array(512);
        const raw = packet.payloadAsBuffer;
        if (raw) data.set(raw.subarray(0, 512));
        sources.set(packet.cid.toString('hex'), {priority: packet.priority, data});
        return this.recompute(packet.universe);
    }

    /** Remove a source (e.g. after it timed out or terminated). */
    public remove(universe: number, cidHex: string): MergedUniverse | undefined {
        const sources = this.universes.get(universe);
        if (!sources?.delete(cidHex)) return undefined;
        return this.recompute(universe);
    }

    /** Current merged output for a universe, if any source is active. */
    public get(universe: number): MergedUniverse | undefined {
        return this.universes.has(universe) ? this.compute(universe) : undefined;
    }

    /** Detach from the receiver. */
    public dispose(): void {
        this.receiver?.off('packet', this.onPacket);
        this.receiver?.off('sourceLost', this.onLost);
        this.universes.clear();
    }

    private recompute(universe: number): MergedUniverse {
        const merged = this.compute(universe);
        this.emit('merged', merged);
        return merged;
    }

    private compute(universe: number): MergedUniverse {
        const sources = this.universes.get(universe) ?? new Map<string, SourceFrame>();
        let top = -1;
        for (const frame of sources.values()) top = Math.max(top, frame.priority);

        const data = new Uint8Array(512);
        const winners: string[] = [];
        for (const [cid, frame] of sources) {
            if (frame.priority !== top) continue;
            winners.push(cid);
            for (let i = 0; i < 512; i++) {
                if (frame.data[i]! > data[i]!) data[i] = frame.data[i]!;
            }
        }
        return {universe, data, priority: Math.max(top, 0), sources: winners};
    }
}
