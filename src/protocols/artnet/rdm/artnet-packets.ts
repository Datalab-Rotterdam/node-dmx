/**
 * Art-Net RDM and ToD packet wrappers.
 * @module artnet/rdm/artnet-packets
 *
 * Spec references:
 * - Art-Net 4 Specification (OpRdm, OpTodRequest, OpTodData, OpTodControl)
 *   https://art-net.org.uk/downloads/art-net.pdf
 * - ANSI E1.20 (RDM framing; for inner RDM packet content)
 *   https://getdlight.com/media/kunena/attachments/42/ANSI_E1-20_2010.pdf
 */
import {ARTNET_ID, ARTNET_PROTOCOL_VERSION, OpCode} from '../constants';
import {splitUniverseAddress} from '../util';
import type {UID} from './uid';
import {uidFromBuffer} from './uid';

export type ArtTodRequestOptions = {
    /** 1-based universe number. */
    universe: number;
    /** ToD command (implementation-specific; usually 0x00). */
    command?: number;
    /** Optional explicit list of Port-Address values to query. */
    portAddresses?: number[];
};

export type ArtTodControlOptions = {
    /** 1-based universe number. */
    universe: number;
    /** ToD control command byte. */
    command?: number;
};

export type ArtTodData = {
    /** Reconstructed 1-based universe number. */
    universe: number;
    /** Art-Net Net field. */
    net: number;
    /** Sub-Uni address byte. */
    address: number;
    /** Total UID count reported by node. */
    uidTotal: number;
    /** Block index for segmented responses. */
    blockCount: number;
    /** Number of UIDs in this packet block. */
    uidCount: number;
    /** Parsed UID entries. */
    uids: UID[];
};

export type ArtRdmPacket = {
    /** 1-based universe number. */
    universe: number;
    /** RDM command field for OpRdm wrapper. */
    command?: number;
    /** Inner RDM packet bytes (without Art-Net header). */
    rdmPacket: Buffer;
};

/** Write common Art-Net header fields into a packet buffer. */
const writeHeader = (buffer: Buffer, opcode: OpCode): void => {
    buffer.write(ARTNET_ID, 0, 'ascii');
    buffer.writeUInt16LE(opcode, 8);
    buffer.writeUInt16BE(ARTNET_PROTOCOL_VERSION, 10);
};

/** Build OpTodRequest packet. */
export const buildArtTodRequest = (options: ArtTodRequestOptions): Buffer => {
    const address = splitUniverseAddress(options.universe);
    const portAddresses = options.portAddresses ?? [address.subUni];
    // Filler1(12), Filler2(13), Spare1-7(14-20), Net(21), Command(22), AddCount(23), Address[](24+).
    const buffer = Buffer.alloc(24 + portAddresses.length);
    writeHeader(buffer, OpCode.OpTodRequest);
    buffer.writeUInt8(0, 12); // Filler1
    buffer.writeUInt8(0, 13); // Filler2
    for (let i = 14; i <= 20; i++) buffer.writeUInt8(0, i); // Spare1-7
    buffer.writeUInt8(address.net, 21);
    buffer.writeUInt8(options.command ?? 0x00, 22);
    buffer.writeUInt8(portAddresses.length, 23);
    for (let i = 0; i < portAddresses.length; i++) {
        buffer.writeUInt8(portAddresses[i] ?? 0, 24 + i);
    }
    return buffer;
};

/** Build OpTodControl packet. */
export const buildArtTodControl = (options: ArtTodControlOptions): Buffer => {
    const address = splitUniverseAddress(options.universe);
    // Filler1(12), Filler2(13), Spare1-7(14-20), Net(21), Command(22), Address(23).
    const buffer = Buffer.alloc(24);
    writeHeader(buffer, OpCode.OpTodControl);
    buffer.writeUInt8(0, 12); // Filler1
    buffer.writeUInt8(0, 13); // Filler2
    for (let i = 14; i <= 20; i++) buffer.writeUInt8(0, i); // Spare1-7
    buffer.writeUInt8(address.net, 21);
    buffer.writeUInt8(options.command ?? 0x00, 22);
    buffer.writeUInt8(address.subUni, 23);
    return buffer;
};

/** Build OpRdm wrapper packet with embedded RDM payload. */
export const buildArtRdm = (options: ArtRdmPacket): Buffer => {
    const address = splitUniverseAddress(options.universe);
    const rdmPacket = options.rdmPacket;
    // RdmVer(12), Filler2(13), Spare1-5(14-18), FifoAvail(19,Int8), FifoMax(20,Int8),
    // Net(21), Command(22), Address(23), RdmPacket(24+).
    const buffer = Buffer.alloc(24 + rdmPacket.length);
    writeHeader(buffer, OpCode.OpRdm);
    buffer.writeUInt8(1, 12); // RdmVer
    buffer.writeUInt8(0, 13); // Filler2
    buffer.writeUInt8(0, 14); // Spare1
    buffer.writeUInt8(0, 15); // Spare2
    buffer.writeUInt8(0, 16); // Spare3
    buffer.writeUInt8(0, 17); // Spare4
    buffer.writeUInt8(0, 18); // Spare5
    buffer.writeUInt8(0, 19); // FifoAvail
    buffer.writeUInt8(0, 20); // FifoMax
    buffer.writeUInt8(address.net, 21);
    buffer.writeUInt8(options.command ?? 0x00, 22);
    buffer.writeUInt8(address.subUni, 23);
    rdmPacket.copy(buffer, 24);
    return buffer;
};

/**
 * Parse OpTodData into strongly-typed fields.
 * @returns Parsed data or `null` when payload is not OpTodData.
 */
export const parseArtTodData = (buffer: Buffer): ArtTodData | null => {
    if (buffer.length < 28) return null;
    const id = buffer.toString('ascii', 0, 8);
    if (id !== ARTNET_ID) return null;
    const opcode = buffer.readUInt16LE(8);
    if (opcode !== OpCode.OpTodData) return null;
    // RdmVer(12), Port(13), Spare1-6(14-19), BindIndex(20), Net(21),
    // CommandResponse(22), Address(23), UidTotal(24-25), BlockCount(26), UidCount(27), ToD[](28+).
    const net = buffer.readUInt8(21);
    const address = buffer.readUInt8(23);
    const uidTotal = buffer.readUInt16BE(24);
    const blockCount = buffer.readUInt8(26);
    const uidCount = buffer.readUInt8(27);
    const uids: UID[] = [];
    let offset = 28;
    for (let i = 0; i < uidCount; i++) {
        if (offset + 6 > buffer.length) break;
        uids.push(uidFromBuffer(buffer, offset));
        offset += 6;
    }
    const universe = ((net & 0x7f) << 8) | address;
    return {universe: universe + 1, net, address, uidTotal, blockCount, uidCount, uids};
};
