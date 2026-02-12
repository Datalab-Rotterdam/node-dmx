/**
 * DMX Universe container (512 channels).
 * @module core/Universe
 */
import {clampByte} from './utils';

/** Mutable 512-channel DMX frame with dirty tracking. */
export class Universe {
    /** Universe number (1-63999 for sACN compatibility). */
    public readonly id: number;
    /** Raw 512-byte DMX frame. Channel 1 maps to index 0. */
    public readonly data: Uint8Array;
    private dirty = false;

    /**
     * Create a universe frame container.
     * @param id Universe identifier.
     */
    constructor(id: number) {
        if (!Number.isInteger(id) || id < 1 || id > 63999) {
            throw new RangeError(`Universe must be 1-63999, got ${id}`);
        }
        this.id = id;
        this.data = new Uint8Array(512);
    }

    /**
     * Set a single DMX channel value.
     * @param address DMX channel address (1-512).
     * @param value DMX value (clamped to 0-255).
     */
    public setChannel(address: number, value: number): void {
        if (!Number.isInteger(address) || address < 1 || address > 512) {
            throw new RangeError(`Channel must be 1-512, got ${address}`);
        }
        this.data[address - 1] = clampByte(value);
        this.dirty = true;
    }

    /**
     * Replace the whole frame with new channel data.
     * Missing channels are filled with `0`.
     * @param frame Frame bytes to copy (up to 512).
     */
    public setFrame(frame: Uint8Array | Buffer): void {
        const length = Math.min(frame.length, 512);
        this.data.fill(0);
        for (let i = 0; i < length; i++) {
            this.data[i] = clampByte(frame[i] ?? 0);
        }
        this.dirty = true;
    }

    /**
     * Fill all 512 channels with one value.
     * @param value DMX value (clamped to 0-255).
     */
    public fill(value: number): void {
        this.data.fill(clampByte(value));
        this.dirty = true;
    }

    /** Set all channels to 0. */
    public clear(): void {
        this.data.fill(0);
        this.dirty = true;
    }

    /** Mark this universe as changed so it will be sent on next flush. */
    public markDirty(): void {
        this.dirty = true;
    }

    /**
     * Read and reset the dirty flag.
     * @returns `true` if data changed since last consume.
     */
    public consumeDirty(): boolean {
        const wasDirty = this.dirty;
        this.dirty = false;
        return wasDirty;
    }

    /** @returns `true` when the frame has unapplied changes. */
    public isDirty(): boolean {
        return this.dirty;
    }
}
