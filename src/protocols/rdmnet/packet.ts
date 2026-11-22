/**
 * ANSI E1.33 (RDMnet) packet helpers.
 * @module rdmnet/packet
 *
 * Two different ACN (E1.17) preambles are in play:
 *
 * - **UDP** (LLRP multicast): Preamble Size (u16 = 0x0010) + Post-amble Size
 *   (u16 = 0x0000) + 12-byte ACN Packet Identifier, then one root-layer PDU.
 *   See {@link buildRdmnetPacket} / {@link parseRdmnetPacket}.
 * - **TCP** (Broker/RPT/EPT stream): 12-byte ACN Packet Identifier + u32
 *   PDU Block Size (length of the root-layer PDU block that follows). See
 *   {@link buildRdmnetTcpPacket} / {@link extractRdmnetTcpPackets}.
 */
import assert from 'assert';
import {randomUUID} from 'crypto';

import {ACN_PID, ACN_POSTAMBLE_SIZE, ACN_PREAMBLE_SIZE, RdmnetRootVector} from './constants';
import {assertPduFlags, PDU_FLAGS_NIBBLE, readPduLength, writePduLength} from './pdu';

export type RdmnetPacketOptions = {
    vector: number | RdmnetRootVector;
    data?: Buffer | Uint8Array;
    cid?: Buffer;
};

export type RdmnetPacket = {
    vector: number;
    cid: Buffer;
    data: Buffer;
    raw: Buffer;
};

/** 3-byte flags+length, 4-byte vector, 16-byte CID. */
const ROOT_HEADER_LENGTH = 23;
const ROOT_MIN_LENGTH = ROOT_HEADER_LENGTH;
/** UDP: Preamble(2) + Postamble(2) + ACN PID(12). */
const UDP_PREAMBLE_LENGTH = 16;
/** TCP: ACN PID(12) + PDU Block Size(4). */
export const ACN_TCP_PREAMBLE_LENGTH = 16;
/** UDP preamble + root header. */
const PACKET_PREFIX_LENGTH = UDP_PREAMBLE_LENGTH + ROOT_HEADER_LENGTH;

export const makeCid = (): Buffer => Buffer.from(randomUUID().replaceAll('-', ''), 'hex');

function buildRootPdu({vector, data, cid}: RdmnetPacketOptions): Buffer {
    const payload = data ? Buffer.from(data) : Buffer.alloc(0);
    const packetCid = cid ? Buffer.from(cid) : makeCid();
    if (packetCid.length !== 16) {
        throw new RangeError(`RDMnet CID must be 16 bytes, got ${packetCid.length}`);
    }
    const rootPduLength = ROOT_HEADER_LENGTH + payload.length;
    const buffer = Buffer.alloc(rootPduLength);
    writePduLength(buffer, 0, rootPduLength);
    buffer.writeUInt32BE(vector >>> 0, 3);
    packetCid.copy(buffer, 7);
    payload.copy(buffer, ROOT_HEADER_LENGTH);
    return buffer;
}

/**
 * Parse one root-layer PDU at `offset` within `block` (which must end at
 * `blockEnd`). Returns the parsed PDU fields and its length.
 */
function parseRootPdu(
    block: Buffer,
    offset: number,
    blockEnd: number,
): {vector: number; cid: Buffer; data: Buffer; length: number} {
    if (offset + ROOT_HEADER_LENGTH > blockEnd) {
        throw new RangeError(`RDMnet root PDU truncated at offset ${offset}`);
    }
    const {flagsNibble, length: rootLength} = readPduLength(block, offset);
    assertPduFlags(flagsNibble, 'RDMnet root layer');
    if (rootLength < ROOT_MIN_LENGTH) {
        throw new RangeError(`Invalid RDMnet root length ${rootLength}: must be >= ${ROOT_MIN_LENGTH}`);
    }
    if (offset + rootLength > blockEnd) {
        throw new RangeError(`RDMnet root PDU length ${rootLength} exceeds PDU block`);
    }
    return {
        vector: block.readUInt32BE(offset + 3),
        cid: Buffer.from(block.subarray(offset + 7, offset + 23)),
        data: Buffer.from(block.subarray(offset + ROOT_HEADER_LENGTH, offset + rootLength)),
        length: rootLength,
    };
}

/**
 * Build a single ACN Root Layer packet with the **UDP** preamble (used by
 * LLRP multicast). For the Broker TCP stream use {@link buildRdmnetTcpPacket}.
 */
export const buildRdmnetPacket = (options: RdmnetPacketOptions): Buffer => {
    const rootPdu = buildRootPdu(options);
    const buffer = Buffer.alloc(UDP_PREAMBLE_LENGTH + rootPdu.length);
    buffer.writeUInt16BE(ACN_PREAMBLE_SIZE, 0);
    buffer.writeUInt16BE(ACN_POSTAMBLE_SIZE, 2);
    ACN_PID.copy(buffer, 4);
    rootPdu.copy(buffer, UDP_PREAMBLE_LENGTH);
    return buffer;
};

/**
 * Parse one full **UDP**-framed ACN Root Layer packet into an RDMnet packet
 * model. Bytes after the root PDU are rejected.
 */
export const parseRdmnetPacket = (buffer: Buffer): RdmnetPacket => {
    if (buffer.length < PACKET_PREFIX_LENGTH) {
        throw new RangeError(
            `RDMnet packet too short: expected at least ${PACKET_PREFIX_LENGTH} bytes, got ${buffer.length}`,
        );
    }
    assert.strictEqual(buffer.readUInt16BE(0), ACN_PREAMBLE_SIZE);
    assert.strictEqual(buffer.readUInt16BE(2), ACN_POSTAMBLE_SIZE);
    assert.deepStrictEqual(buffer.subarray(4, 16), ACN_PID);

    const {flagsNibble, length: rootLength} = readPduLength(buffer, 16);
    assertPduFlags(flagsNibble, 'RDMnet root layer');
    if (rootLength < ROOT_MIN_LENGTH) {
        throw new RangeError(`Invalid RDMnet root length ${rootLength}: must be >= ${ROOT_MIN_LENGTH}`);
    }
    const totalLength = 16 + rootLength;
    if (buffer.length < totalLength) {
        throw new RangeError(`RDMnet packet truncated: expected ${totalLength} bytes, got ${buffer.length}`);
    }
    if (buffer.length > totalLength) {
        throw new RangeError(`RDMnet packet has trailing bytes: expected ${totalLength} bytes, got ${buffer.length}`);
    }

    const {vector, cid, data} = parseRootPdu(buffer, 16, totalLength);
    return {
        vector,
        cid,
        data,
        raw: Buffer.from(buffer.subarray(0, totalLength)),
    };
};

/**
 * Extract consecutive **UDP-preamble**-framed packets from a buffer.
 *
 * @deprecated The RDMnet Broker TCP stream uses the E1.17 TCP preamble
 * (PID + u32 PDU Block Size), not this format — use
 * {@link extractRdmnetTcpPackets} for Broker/RPT/EPT connections.
 */
export const extractRdmnetPackets = (
    streamBuffer: Buffer<ArrayBufferLike>,
): {packets: RdmnetPacket[]; remainder: Buffer<ArrayBufferLike>} => {
    const packets: RdmnetPacket[] = [];
    let offset = 0;

    while (offset + PACKET_PREFIX_LENGTH <= streamBuffer.length) {
        const preamble = streamBuffer.readUInt16BE(offset);
        const postamble = streamBuffer.readUInt16BE(offset + 2);
        if (preamble !== ACN_PREAMBLE_SIZE || postamble !== ACN_POSTAMBLE_SIZE) {
            throw new Error(`Invalid ACN framing at offset ${offset}`);
        }
        const {flagsNibble, length: rootLength} = readPduLength(streamBuffer, offset + 16);
        if (flagsNibble !== PDU_FLAGS_NIBBLE) {
            throw new Error(`Invalid RDMnet flags 0x${flagsNibble.toString(16)} at offset ${offset}`);
        }
        if (rootLength < ROOT_MIN_LENGTH) {
            throw new Error(`Invalid RDMnet root length ${rootLength} at offset ${offset}`);
        }
        const totalLength = 16 + rootLength;
        if (offset + totalLength > streamBuffer.length) break;

        packets.push(parseRdmnetPacket(streamBuffer.subarray(offset, offset + totalLength)));
        offset += totalLength;
    }

    return {
        packets,
        remainder: Buffer.from(streamBuffer.subarray(offset)),
    };
};

/**
 * Build one RDMnet TCP message: E1.17 TCP preamble (12-byte ACN Packet
 * Identifier + u32 PDU Block Size) followed by a single root-layer PDU.
 */
export const buildRdmnetTcpPacket = (options: RdmnetPacketOptions): Buffer => {
    const rootPdu = buildRootPdu(options);
    const buffer = Buffer.alloc(ACN_TCP_PREAMBLE_LENGTH + rootPdu.length);
    ACN_PID.copy(buffer, 0);
    buffer.writeUInt32BE(rootPdu.length, 12);
    rootPdu.copy(buffer, ACN_TCP_PREAMBLE_LENGTH);
    return buffer;
};

/**
 * Parse the root-layer PDUs of one complete TCP-framed PDU block (preamble
 * included). A block may carry several root PDUs back to back; each is
 * returned as its own packet. Throws on any malformed framing.
 */
export const parseRdmnetTcpPacket = (buffer: Buffer): RdmnetPacket[] => {
    if (buffer.length < ACN_TCP_PREAMBLE_LENGTH) {
        throw new RangeError(`RDMnet TCP packet too short: ${buffer.length} bytes`);
    }
    if (!buffer.subarray(0, 12).equals(ACN_PID)) {
        throw new Error('Invalid ACN packet identifier');
    }
    const blockSize = buffer.readUInt32BE(12);
    const blockEnd = ACN_TCP_PREAMBLE_LENGTH + blockSize;
    if (buffer.length !== blockEnd) {
        throw new RangeError(`RDMnet TCP packet length mismatch: block size ${blockSize}, got ${buffer.length - ACN_TCP_PREAMBLE_LENGTH} bytes`);
    }
    if (blockSize < ROOT_MIN_LENGTH) {
        throw new RangeError(`Invalid RDMnet PDU block size ${blockSize}`);
    }
    const packets: RdmnetPacket[] = [];
    let offset = ACN_TCP_PREAMBLE_LENGTH;
    while (offset < blockEnd) {
        const pdu = parseRootPdu(buffer, offset, blockEnd);
        packets.push({
            vector: pdu.vector,
            cid: pdu.cid,
            data: pdu.data,
            raw: Buffer.from(buffer.subarray(0, blockEnd)),
        });
        offset += pdu.length;
    }
    return packets;
};

/**
 * Extract all complete RDMnet TCP messages (E1.17 TCP preamble framing)
 * from a stream buffer. Returns parsed root-layer packets plus any trailing
 * incomplete bytes. Throws on unrecoverable framing errors (bad packet
 * identifier, impossible block size, malformed root PDU) — the caller
 * should then drop the connection, since stream sync is lost.
 *
 * @param maxBlockSize Optional upper bound for a declared PDU Block Size;
 *   larger values are treated as framing corruption instead of buffering.
 */
export const extractRdmnetTcpPackets = (
    streamBuffer: Buffer<ArrayBufferLike>,
    maxBlockSize = Number.MAX_SAFE_INTEGER,
): {packets: RdmnetPacket[]; remainder: Buffer<ArrayBufferLike>} => {
    const packets: RdmnetPacket[] = [];
    let offset = 0;

    while (offset + ACN_TCP_PREAMBLE_LENGTH <= streamBuffer.length) {
        if (!streamBuffer.subarray(offset, offset + 12).equals(ACN_PID)) {
            throw new Error(`Invalid ACN packet identifier at offset ${offset}`);
        }
        const blockSize = streamBuffer.readUInt32BE(offset + 12);
        if (blockSize < ROOT_MIN_LENGTH) {
            throw new Error(`Invalid RDMnet PDU block size ${blockSize} at offset ${offset}`);
        }
        if (blockSize > maxBlockSize) {
            throw new Error(`RDMnet PDU block size ${blockSize} exceeds limit ${maxBlockSize} at offset ${offset}`);
        }
        // Validate the first root PDU's flags early so garbage is detected
        // without waiting for a (possibly huge) declared block to arrive.
        if (offset + ACN_TCP_PREAMBLE_LENGTH + 1 <= streamBuffer.length) {
            const flagsNibble = (streamBuffer.readUInt8(offset + ACN_TCP_PREAMBLE_LENGTH) >> 4) & 0x0f;
            if (flagsNibble !== PDU_FLAGS_NIBBLE) {
                throw new Error(`Invalid RDMnet flags 0x${flagsNibble.toString(16)} at offset ${offset}`);
            }
        }
        const totalLength = ACN_TCP_PREAMBLE_LENGTH + blockSize;
        if (offset + totalLength > streamBuffer.length) break;

        packets.push(...parseRdmnetTcpPacket(Buffer.from(streamBuffer.subarray(offset, offset + totalLength))));
        offset += totalLength;
    }

    return {
        packets,
        remainder: Buffer.from(streamBuffer.subarray(offset)),
    };
};
