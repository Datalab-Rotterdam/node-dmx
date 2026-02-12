/**
 * Art-Net 4 utility helpers.
 * @module artnet/util
 *
 * Spec reference:
 * - Art-Net 4 Specification (Port-Address / Net/SubUni packing)
 *   https://art-net.org.uk/downloads/art-net.pdf
 */
export type ArtNetAddress = {
    /** 7-bit Net field (high universe bits). */
    net: number;
    /** 4-bit Sub-Net field. */
    subNet: number;
    /** 4-bit Universe field (0-15 inside one Sub-Net). */
    universe: number;
    /** Packed SubUni byte (`subNet << 4 | universe`). */
    subUni: number;
};

/**
 * Split a 1-based Art-Net universe number into Net/Sub-Net/Universe fields.
 * @param universe Universe index in range 1-32768.
 */
export const splitUniverseAddress = (universe: number): ArtNetAddress => {
    if (!Number.isInteger(universe) || universe < 1 || universe > 32768) {
        throw new RangeError(`Art-Net universe must be 1-32768, got ${universe}`);
    }
    const address = universe - 1;
    const net = (address >> 8) & 0x7f;
    const subNet = (address >> 4) & 0x0f;
    const uni = address & 0x0f;
    const subUni = (subNet << 4) | uni;
    return {net, subNet, universe: uni, subUni};
};

/**
 * Read an ASCII string field that may contain NUL padding.
 * @param buffer Source buffer.
 * @param offset Field start offset.
 * @param length Maximum field length.
 */
export const readNullTerminatedString = (buffer: Buffer, offset: number, length: number): string => {
    const end = buffer.indexOf(0, offset);
    const limit = end === -1 ? offset + length : Math.min(end, offset + length);
    return buffer.toString('ascii', offset, limit).trim();
};
