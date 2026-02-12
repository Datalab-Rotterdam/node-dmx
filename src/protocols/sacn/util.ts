/**
 * Utility functions for the sACN (E1.31) DMX512 implementation.
 * @module sACN/util
 */

/**
 * Represents DMX channel data.
 *
 * - Keys are **channel numbers** (1 to 512).
 * - Values are **percentages** in the range `0–100` (inclusive).
 *
 * Note: Channel 0 does not exist in DMX512. The first channel is 1.
 */
export type Payload = { [channel: number]: number };

/**
 * Converts a universe number (1–63999) to its corresponding
 * sACN multicast IP address.
 *
 * Also supports the special test universe 64214 (E1.31 Annex A).
 *
 * @param universe - DMX universe (1–63999, or 64214 for testing)
 * @returns Multicast IP address (e.g., `"239.255.0.1"` for universe 1)
 * @throws {RangeError} If universe is outside valid range
 */
export function multicastGroup(universe: number): string {
    if (!Number.isInteger(universe)) {
        throw new TypeError('Universe must be an integer');
    }
    if ((universe >= 1 && universe <= 63999) || universe === 64214) {
        const high = (universe >> 8) & 0xff;
        const low = universe & 0xff;
        return `239.255.${high}.${low}`;
    }
    throw new RangeError('Universe must be between 1 and 63999 (or 64214 for test)');
}

/**
 * Rounds a number to a specified number of decimal places.
 *
 * @param value - The number to round
 * @param decimals - Number of decimal places (default: 2)
 * @returns Rounded number
 */
export const dp = (value: number, decimals = 2): number => {
    if (!isFinite(value)) return 0;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

/**
 * Converts a raw DMX buffer (0–255) into a sparse {@link Payload} object (0–100).
 *
 * - Only channels with non-zero values are included (sparse representation).
 * - Channel 1 corresponds to `buffer[0]`.
 * - Values are scaled from 0–255 → 0–100 and rounded to 2 decimal places.
 *
 * @param buffer - Buffer of length up to 512 containing DMX values (0–255)
 * @returns Sparse payload object
 */
export function objectify(buffer: Buffer): Payload {
    const payload: Payload = {};
    const length = Math.min(buffer.length, 512); // DMX max is 512 channels
    for (let i = 0; i < length; i++) {
        const rawValue = buffer[i];
        if (rawValue > 0) {
            // Scale 0-255 → 0-100, round to 2 decimals
            payload[i + 1] = dp(rawValue / 2.55, 2);
        }
    }
    return payload;
}

/**
 * Clamps and rounds a number to the valid DMX byte range (0–255).
 *
 * @param value - Input number
 * @returns Integer between 0 and 255 (inclusive)
 */
export const inRange = (value: number): number => {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    return Math.min(255, Math.max(0, Math.round(value)));
};

/**
 * Splits an unsigned integer into big-endian bytes.
 *
 * @param bitWidth - Must be 8, 16, 24, or 32
 * @param num - Non-negative integer to split
 * @returns Array of bytes in big-endian order
 * @example
 * bit(16, 0x1234) → [0x12, 0x34]
 */
export function bit(bitWidth: 8 | 16 | 24 | 32, num: number): number[] {
    if (!Number.isInteger(num) || num < 0) {
        throw new RangeError('num must be a non-negative integer');
    }
    if (![8, 16, 24, 32].includes(bitWidth)) {
        throw new RangeError('bitWidth must be 8, 16, 24, or 32');
    }

    const bytes: number[] = [];
    const byteCount = bitWidth / 8;
    for (let i = byteCount - 1; i >= 0; i--) {
        bytes.push((num >> (i * 8)) & 0xff);
    }
    return bytes;
}

/**
 * Creates an array of zeros of the given length.
 *
 * @param length - Number of zeros to generate
 * @returns Array of `length` zeros
 */
export const empty = (length: number): number[] => {
    if (length < 0) throw new RangeError('Length must be non-negative');
    return new Array(length).fill(0);
};
