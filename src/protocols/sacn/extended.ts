/**
 * E1.31 "extended" (root vector {@link RootVector.EXTENDED}) packets:
 * Synchronization Packet (§6) and Universe Discovery Packet (§8).
 * @module sacn/extended
 */
import assert from 'assert';
import {
    ACN_PID,
    ExtendedFrameVector,
    MAX_UNIVERSES_PER_DISCOVERY_PAGE,
    RootVector,
    UniverseDiscoveryVector,
} from './constants';

const PREAMBLE_SIZE = 0x0010;
const POSTAMBLE_SIZE = 0x0000;
/** Preamble(2) + Postamble(2) + ACN PID(12) + root flags&length(2) + root vector(4) + CID(16). */
const ROOT_HEADER_LENGTH = 38;

function writeRootHeader(buffer: Buffer, cid: Buffer, rootPduLength: number): void {
    buffer.writeUInt16BE(PREAMBLE_SIZE, 0);
    buffer.writeUInt16BE(POSTAMBLE_SIZE, 2);
    ACN_PID.copy(buffer, 4);
    buffer.writeUInt16BE(0x7000 | rootPduLength, 16);
    buffer.writeUInt32BE(RootVector.EXTENDED, 18);
    cid.copy(buffer, 22);
}

function validateCid(cid: Buffer): void {
    if (cid.length !== 16) throw new RangeError(`CID must be 16 bytes, got ${cid.length}`);
}

export type SyncPacketOptions = {
    /** 16-byte CID of the sending source. */
    cid: Buffer;
    /** Sequence number for this sync stream (0-255, independent of data-packet sequencing). */
    sequence: number;
    /** Synchronization Address — the universe number receivers wait on (1-63999). */
    syncAddress: number;
};

/**
 * Build a Synchronization Packet (E1.31 §6). Sources with synchronized
 * universes send this to the sync address's multicast group so receivers
 * can apply all buffered data packets simultaneously.
 */
export const buildSyncPacket = ({cid, sequence, syncAddress}: SyncPacketOptions): Buffer => {
    validateCid(cid);
    if (!Number.isInteger(syncAddress) || syncAddress < 1 || syncAddress > 63999) {
        throw new RangeError(`Sync address must be 1-63999, got ${syncAddress}`);
    }

    // Sync framing layer: flags&length(2) + vector(4) + sequence(1) + syncAddress(2) + reserved(2) = 11 bytes.
    const framingLength = 11;
    const rootPduLength = 22 + framingLength;
    const buffer = Buffer.alloc(ROOT_HEADER_LENGTH + framingLength);

    writeRootHeader(buffer, cid, rootPduLength);
    buffer.writeUInt16BE(0x7000 | framingLength, 38);
    buffer.writeUInt32BE(ExtendedFrameVector.SYNCHRONIZATION, 40);
    buffer.writeUInt8(sequence & 0xff, 44);
    buffer.writeUInt16BE(syncAddress, 45);
    buffer.writeUInt16BE(0, 47);
    return buffer;
};

export type UniverseDiscoveryPacketOptions = {
    cid: Buffer;
    /** Source name (max 64 ASCII chars in wire format). */
    sourceName?: string;
    /** This page's index (0-based). */
    page: number;
    /** Index of the last page in this discovery burst. */
    lastPage: number;
    /** Universe numbers advertised on this page (ascending, max 512). */
    universes: number[];
};

/**
 * Build one page of a Universe Discovery Packet (E1.31 §8). A compliant
 * source periodically advertises every universe it is currently
 * transmitting, so controllers can enumerate active sources without
 * joining every possible universe's multicast group.
 */
export const buildUniverseDiscoveryPacket = ({
    cid,
    sourceName,
    page,
    lastPage,
    universes,
}: UniverseDiscoveryPacketOptions): Buffer => {
    validateCid(cid);
    if (universes.length > MAX_UNIVERSES_PER_DISCOVERY_PAGE) {
        throw new RangeError(`At most ${MAX_UNIVERSES_PER_DISCOVERY_PAGE} universes per page, got ${universes.length}`);
    }
    for (const universe of universes) {
        if (!Number.isInteger(universe) || universe < 1 || universe > 63999) {
            throw new RangeError(`Universe must be 1-63999, got ${universe}`);
        }
    }

    const n = universes.length;
    // Universe Discovery layer: flags&length(2) + vector(4) + page(1) + lastPage(1) + list(2*n).
    const discoveryLength = 8 + 2 * n;
    // Discovery framing layer: flags&length(2) + vector(4) + sourceName(64) + reserved(4), then nested layer.
    const framingHeaderLength = 74;
    const framingLength = framingHeaderLength + discoveryLength;
    const rootPduLength = 22 + framingLength;

    const buffer = Buffer.alloc(ROOT_HEADER_LENGTH + framingLength);
    writeRootHeader(buffer, cid, rootPduLength);

    buffer.writeUInt16BE(0x7000 | framingLength, 38);
    buffer.writeUInt32BE(ExtendedFrameVector.DISCOVERY, 40);
    if (sourceName) {
        Buffer.from(sourceName.substring(0, 64), 'ascii').copy(buffer, 44);
    }
    // Reserved(4) at 108-111 already zero.

    buffer.writeUInt16BE(0x7000 | discoveryLength, 112);
    buffer.writeUInt32BE(UniverseDiscoveryVector.UNIVERSE_LIST, 114);
    buffer.writeUInt8(page & 0xff, 118);
    buffer.writeUInt8(lastPage & 0xff, 119);
    for (let i = 0; i < n; i++) {
        buffer.writeUInt16BE(universes[i]!, 120 + i * 2);
    }
    return buffer;
};

/** Root vector found in a buffer, without fully parsing it — used to route inbound packets. */
export const peekRootVector = (buffer: Buffer): number => {
    if (buffer.length < 22) throw new RangeError('Buffer too short to contain an sACN root layer');
    return buffer.readUInt32BE(18);
};

/** Framing-layer vector found in an "extended" (root vector EXTENDED) buffer. */
export const peekExtendedFrameVector = (buffer: Buffer): number => {
    if (buffer.length < 44) throw new RangeError('Buffer too short to contain an sACN extended framing layer');
    return buffer.readUInt32BE(40);
};

export type ParsedSyncPacket = {
    cid: Buffer;
    sequence: number;
    syncAddress: number;
};

/** Parse a Synchronization Packet built by {@link buildSyncPacket}. */
export const parseSyncPacket = (buffer: Buffer): ParsedSyncPacket => {
    if (buffer.length < ROOT_HEADER_LENGTH + 11) throw new RangeError('Buffer too short for a Synchronization Packet');
    assert.strictEqual(buffer.readUInt16BE(0), PREAMBLE_SIZE);
    assert.strictEqual(buffer.readUInt16BE(2), POSTAMBLE_SIZE);
    assert.deepStrictEqual(buffer.subarray(4, 16), ACN_PID);
    assert.strictEqual(buffer.readUInt32BE(18), RootVector.EXTENDED);
    assert.strictEqual(buffer.readUInt32BE(40), ExtendedFrameVector.SYNCHRONIZATION);

    return {
        cid: Buffer.from(buffer.subarray(22, 38)),
        sequence: buffer.readUInt8(44),
        syncAddress: buffer.readUInt16BE(45),
    };
};

export type ParsedUniverseDiscoveryPacket = {
    cid: Buffer;
    sourceName: string;
    page: number;
    lastPage: number;
    universes: number[];
};

/** Parse one page of a Universe Discovery Packet built by {@link buildUniverseDiscoveryPacket}. */
export const parseUniverseDiscoveryPacket = (buffer: Buffer): ParsedUniverseDiscoveryPacket => {
    if (buffer.length < ROOT_HEADER_LENGTH + 74 + 8) {
        throw new RangeError('Buffer too short for a Universe Discovery Packet');
    }
    assert.strictEqual(buffer.readUInt16BE(0), PREAMBLE_SIZE);
    assert.strictEqual(buffer.readUInt16BE(2), POSTAMBLE_SIZE);
    assert.deepStrictEqual(buffer.subarray(4, 16), ACN_PID);
    assert.strictEqual(buffer.readUInt32BE(18), RootVector.EXTENDED);
    assert.strictEqual(buffer.readUInt32BE(40), ExtendedFrameVector.DISCOVERY);
    assert.strictEqual(buffer.readUInt32BE(114), UniverseDiscoveryVector.UNIVERSE_LIST);

    const cid = Buffer.from(buffer.subarray(22, 38));
    const sourceName = buffer.toString('ascii', 44, 108).replace(/\0/g, '');
    const page = buffer.readUInt8(118);
    const lastPage = buffer.readUInt8(119);
    const universes: number[] = [];
    for (let offset = 120; offset + 2 <= buffer.length; offset += 2) {
        universes.push(buffer.readUInt16BE(offset));
    }
    return {cid, sourceName, page, lastPage, universes};
};
