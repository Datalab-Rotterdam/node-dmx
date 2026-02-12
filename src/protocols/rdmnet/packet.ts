/**
 * ANSI E1.33 (RDMnet) packet helpers.
 * @module rdmnet/packet
 */
import assert from 'assert';
import {randomUUID} from 'crypto';

import {ACN_PID, ACN_POSTAMBLE_SIZE, ACN_PREAMBLE_SIZE, RdmnetRootVector} from './constants';

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

const FLAGS_MASK = 0x7000;
const LENGTH_MASK = 0x0fff;
const ROOT_MIN_LENGTH = 22;

const withLengthFlags = (length: number): number => {
    if (!Number.isInteger(length) || length < 0 || length > LENGTH_MASK) {
        throw new RangeError(`PDU length must be 0-${LENGTH_MASK}, got ${length}`);
    }
    return FLAGS_MASK | length;
};

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

    const rootPduLength = 22 + payload.length;
    const buffer = Buffer.alloc(38 + payload.length);
    buffer.writeUInt16BE(ACN_PREAMBLE_SIZE, 0);
    buffer.writeUInt16BE(ACN_POSTAMBLE_SIZE, 2);
    ACN_PID.copy(buffer, 4);
    buffer.writeUInt16BE(withLengthFlags(rootPduLength), 16);
    buffer.writeUInt32BE(vector >>> 0, 18);
    packetCid.copy(buffer, 22);
    payload.copy(buffer, 38);
    return buffer;
};

/**
 * Parse one full ACN Root Layer packet into an RDMnet packet model.
 */
export const parseRdmnetPacket = (buffer: Buffer): RdmnetPacket => {
    if (buffer.length < 38) {
        throw new RangeError(`RDMnet packet too short: expected at least 38 bytes, got ${buffer.length}`);
    }
    assert.strictEqual(buffer.readUInt16BE(0), ACN_PREAMBLE_SIZE);
    assert.strictEqual(buffer.readUInt16BE(2), ACN_POSTAMBLE_SIZE);
    assert.deepStrictEqual(buffer.subarray(4, 16), ACN_PID);

    const rootFl = buffer.readUInt16BE(16);
    const flags = rootFl & FLAGS_MASK;
    if (flags !== FLAGS_MASK) {
        throw new RangeError(`Invalid RDMnet flags 0x${flags.toString(16)} (expected 0x7000)`);
    }
    const rootLength = rootFl & LENGTH_MASK;
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

    const vector = buffer.readUInt32BE(18);
    const cid = Buffer.from(buffer.subarray(22, 38));
    const data = Buffer.from(buffer.subarray(38, totalLength));
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

    while (offset + 38 <= streamBuffer.length) {
        const preamble = streamBuffer.readUInt16BE(offset);
        const postamble = streamBuffer.readUInt16BE(offset + 2);
        if (preamble !== ACN_PREAMBLE_SIZE || postamble !== ACN_POSTAMBLE_SIZE) {
            throw new Error(`Invalid ACN framing at offset ${offset}`);
        }
        const rootFl = streamBuffer.readUInt16BE(offset + 16);
        const flags = rootFl & FLAGS_MASK;
        if (flags !== FLAGS_MASK) {
            throw new Error(`Invalid RDMnet flags 0x${flags.toString(16)} at offset ${offset}`);
        }
        const rootLength = rootFl & LENGTH_MASK;
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
