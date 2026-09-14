/**
 * Shared ACN "PDU using extended (3-byte) Flags & Length" helpers.
 * @module rdmnet/pdu
 *
 * Every nested PDU in RDMnet (root layer, Broker PDU, Client Entry, RPT PDU,
 * Request/Notification/Status/RDM-Command PDUs, LLRP PDU) uses the same
 * mandatory extended form: a 4-bit flags nibble (Length|Vector|Header|Data,
 * all set -> 0xF) followed by a 20-bit length, for a 3-byte field. The
 * length value counts from this field itself (inclusive) through the end
 * of that PDU's content.
 */

export const PDU_FLAGS_NIBBLE = 0xf;
export const PDU_LENGTH_MASK = 0xfffff;

/** Write the 3-byte extended flags+length field at `offset`. */
export function writePduLength(buffer: Buffer, offset: number, length: number): void {
    if (!Number.isInteger(length) || length < 0 || length > PDU_LENGTH_MASK) {
        throw new RangeError(`PDU length must be 0-${PDU_LENGTH_MASK}, got ${length}`);
    }
    buffer.writeUInt8((PDU_FLAGS_NIBBLE << 4) | ((length >>> 16) & 0x0f), offset);
    buffer.writeUInt16BE(length & 0xffff, offset + 1);
}

/** Read the 3-byte extended flags+length field at `offset`. */
export function readPduLength(buffer: Buffer, offset: number): {flagsNibble: number; length: number} {
    const first = buffer.readUInt8(offset);
    return {
        flagsNibble: (first >> 4) & 0x0f,
        length: ((first & 0x0f) << 16) | buffer.readUInt16BE(offset + 1),
    };
}

/** Throw if a parsed PDU's flags nibble isn't the mandatory 0xF. */
export function assertPduFlags(flagsNibble: number, context: string): void {
    if (flagsNibble !== PDU_FLAGS_NIBBLE) {
        throw new RangeError(
            `Invalid ${context} flags 0x${flagsNibble.toString(16)} (expected 0x${PDU_FLAGS_NIBBLE.toString(16)})`,
        );
    }
}

/** Write a fixed-width, null-padded UTF-8 string field. Throws if it doesn't fit. */
export function writeFixedString(buffer: Buffer, offset: number, width: number, text: string): void {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > width) {
        throw new RangeError(`String exceeds ${width} bytes: "${text}"`);
    }
    buffer.fill(0, offset, offset + width);
    bytes.copy(buffer, offset);
}

/** Read a fixed-width, null-padded/terminated UTF-8 string field. */
export function readFixedString(buffer: Buffer, offset: number, width: number): string {
    const raw = buffer.subarray(offset, offset + width);
    const nullIndex = raw.indexOf(0);
    return raw.toString('utf8', 0, nullIndex === -1 ? raw.length : nullIndex);
}
