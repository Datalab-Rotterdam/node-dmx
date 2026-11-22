/**
 * Small numeric helpers shared across the library.
 * @module core/utils
 */

/**
 * Clamp a number into the 0-255 range and round it.
 * Non-numeric or non-finite input yields `0`.
 */
export const clampByte = (value: number): number => {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 255) return 255;
    return Math.round(value);
};

/**
 * Convert a normalized value (0-1) to a DMX byte (0-255), clamping out-of-range
 * input. Non-numeric or non-finite input yields `0`.
 */
export const unitToByte = (value: number): number => {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    return clampByte(value * 255);
};
