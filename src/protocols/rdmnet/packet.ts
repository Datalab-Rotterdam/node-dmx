/**
 * ANSI E1.33 (RDMnet) packet helpers.
 * @module rdmnet/packet
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
/** Preamble(2) + Postamble(2) + ACN PID(12) + root header(23). */
const PACKET_PREFIX_LENGTH = 16 + ROOT_HEADER_LENGTH;

export const makeCid = (): Buffer => Buffer.from(randomUUID().replaceAll('-', ''), 'hex');

/**
 * Build a single ACN Root Layer packet suitable for RDMnet transport.
 */
export const buildRdmnetPacket = ({vector, data, cid}: RdmnetPacketOptions): Buffer => {
    const payload = data ? Buffer.from(data) : Buffer.alloc(0);
    const packetCid = cid ? Buffer.from(cid) : makeCid();
    if (packetCid.length !== 16) {
        throw new RangeError(`RDMnet CID must be 16 bytes, got ${packetCid.length}`);
    }

    const rootPduLength = ROOT_HEADER_LENGTH + payload.length;
    const buffer = Buffer.alloc(16 + rootPduLength);
    buffer.writeUInt16BE(ACN_PREAMBLE_SIZE, 0);
    buffer.writeUInt16BE(ACN_POSTAMBLE_SIZE, 2);
    ACN_PID.copy(buffer, 4);
    writePduLength(buffer, 16, rootPduLength);
    buffer.writeUInt32BE(vector >>> 0, 19);
    packetCid.copy(buffer, 23);
    payload.copy(buffer, PACKET_PREFIX_LENGTH);
    return buffer;
};

/**
 * Parse one full ACN Root Layer packet into an RDMnet packet model.
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

    const vector = buffer.readUInt32BE(19);
    const cid = Buffer.from(buffer.subarray(23, 39));
    const data = Buffer.from(buffer.subarray(PACKET_PREFIX_LENGTH, totalLength));
    return {
        vector,
        cid,
        data,
        raw: Buffer.from(buffer.subarray(0, totalLength)),
    };
};

/**
 * Extract all full ACN packets from a TCP stream buffer.
 * Returns parsed packets and any remaining incomplete bytes.
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
