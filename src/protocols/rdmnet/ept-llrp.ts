/**
 * RDMnet EPT/LLRP message helpers.
 * @module rdmnet/ept-llrp
 *
 * LLRP layout verified against ETCLabs/RDMnet `src/rdmnet/core/llrp_prot.c`
 * / `llrp_prot.h` and `include/rdmnet/defs.h`.
 */
import {assertPduFlags, readPduLength, writePduLength} from './pdu';

export enum EptVector {
    Data = 0x00000001,
    Status = 0x00000002,
}

/** LLRP sub-message vectors. RDM command and response share one vector — direction is implicit from which multicast group the packet arrived on. */
export enum LlrpVector {
    ProbeRequest = 0x00000001,
    ProbeReply = 0x00000002,
    RdmCommand = 0x00000003,
}

/** LLRP Probe Reply Component Type (defs.h). */
export enum LlrpComponentType {
    RptDevice = 0x00,
    RptController = 0x01,
    Broker = 0x02,
    NonRdmnet = 0xff,
}

/** Probe Request filter flags (defs.h). */
export enum LlrpFilter {
    ClientConnInactive = 0x0001,
    BrokersOnly = 0x0002,
}

/** Well-known CID meaning "every LLRP Target" (defs.h `kLlrpBroadcastCid`). */
export const LLRP_BROADCAST_CID = Buffer.from('fbad822cbd0c4d4cbdc87eabebc85aff', 'hex');

export type EptDataMessage = {
    vector: EptVector.Data;
    sequence: number;
    manufacturerId: number;
    protocolId: number;
    payload: Buffer;
};

export type EptStatusMessage = {
    vector: EptVector.Status;
    sequence: number;
    statusCode: number;
    text?: string;
};

export type EptMessage = EptDataMessage | EptStatusMessage;

/** LLRP PDU header: flags+length(3) + vector(4) + destination CID(16) + transaction number(4). */
const LLRP_PDU_HEADER_LENGTH = 27;
const PROBE_REQUEST_SUB_VECTOR = 0x01;
const PROBE_REPLY_SUB_VECTOR = 0x01;
/** Probe Reply Data PDU is fixed-size: header(4) + targetUid(6) + hardwareAddress(6) + componentType(1). */
const PROBE_REPLY_DATA_LENGTH = 17;

export type LlrpProbeRequestMessage = {
    vector: LlrpVector.ProbeRequest;
    /** Target this probe is addressed to — {@link LLRP_BROADCAST_CID} for "every Target". */
    destinationCid: Buffer;
    transactionNumber: number;
    lowerUid: Buffer;
    upperUid: Buffer;
    filter?: number;
    /** UIDs to exclude from replying (already discovered this round). */
    knownUids?: Buffer[];
};

export type LlrpProbeReplyMessage = {
    vector: LlrpVector.ProbeReply;
    destinationCid: Buffer;
    transactionNumber: number;
    targetUid: Buffer;
    /** Target's lowest hardware (MAC) address. */
    hardwareAddress: Buffer;
    componentType: LlrpComponentType;
};

export type LlrpRdmMessage = {
    vector: LlrpVector.RdmCommand;
    destinationCid: Buffer;
    transactionNumber: number;
    /** Raw E1.20 RDM frame, including its own leading 0xCC start code. */
    rdm: Buffer;
};

export type LlrpMessage = LlrpProbeRequestMessage | LlrpProbeReplyMessage | LlrpRdmMessage;

function assertUidLength(uid: Buffer, name: string): void {
    if (uid.length !== 6) {
        throw new RangeError(`${name} must be 6 bytes, got ${uid.length}`);
    }
}

export const encodeEptMessage = (message: EptMessage): Buffer => {
    if (message.vector === EptVector.Data) {
        const out = Buffer.alloc(16 + message.payload.length);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.manufacturerId & 0xffff, 8);
        out.writeUInt16BE(message.protocolId & 0xffff, 10);
        out.writeUInt32BE(message.payload.length >>> 0, 12);
        message.payload.copy(out, 16);
        return out;
    }

    const text = Buffer.from(message.text ?? '', 'utf8');
    const out = Buffer.alloc(12 + text.length);
    out.writeUInt32BE(message.vector, 0);
    out.writeUInt32BE(message.sequence >>> 0, 4);
    out.writeUInt16BE(message.statusCode & 0xffff, 8);
    out.writeUInt16BE(text.length & 0xffff, 10);
    text.copy(out, 12);
    return out;
};

export const decodeEptMessage = (buffer: Buffer): EptMessage => {
    if (buffer.length < 8) throw new RangeError(`EPT message too short: ${buffer.length}`);
    const vector = buffer.readUInt32BE(0);
    const sequence = buffer.readUInt32BE(4);

    if (vector === EptVector.Data) {
        if (buffer.length < 16) throw new RangeError('EPT data message too short');
        const manufacturerId = buffer.readUInt16BE(8);
        const protocolId = buffer.readUInt16BE(10);
        const payloadLength = buffer.readUInt32BE(12);
        if (16 + payloadLength > buffer.length) throw new RangeError('EPT payload length exceeds packet length');
        if (16 + payloadLength !== buffer.length) throw new RangeError('EPT payload has trailing bytes');
        return {
            vector: EptVector.Data,
            sequence,
            manufacturerId,
            protocolId,
            payload: Buffer.from(buffer.subarray(16, 16 + payloadLength)),
        };
    }

    if (vector === EptVector.Status) {
        if (buffer.length < 12) throw new RangeError('EPT status message too short');
        const statusCode = buffer.readUInt16BE(8);
        const textLength = buffer.readUInt16BE(10);
        if (12 + textLength > buffer.length) throw new RangeError('EPT status text exceeds packet length');
        if (12 + textLength !== buffer.length) throw new RangeError('EPT status has trailing bytes');
        return {
            vector: EptVector.Status,
            sequence,
            statusCode,
            text: buffer.toString('utf8', 12, 12 + textLength),
        };
    }

    throw new Error(`Unsupported EPT vector 0x${vector.toString(16)}`);
};

function writeLlrpHeader(
    buf: Buffer,
    vector: LlrpVector,
    destinationCid: Buffer,
    transactionNumber: number,
    totalLength: number,
): void {
    if (destinationCid.length !== 16) {
        throw new RangeError(`LLRP destination CID must be 16 bytes, got ${destinationCid.length}`);
    }
    writePduLength(buf, 0, totalLength);
    buf.writeUInt32BE(vector, 3);
    destinationCid.copy(buf, 7);
    buf.writeUInt32BE(transactionNumber >>> 0, 23);
}

/** Build wire bytes for one LLRP PDU (placed after the 23-byte root layer by the caller). */
export const encodeLlrpMessage = (message: LlrpMessage): Buffer => {
    if (message.vector === LlrpVector.ProbeRequest) {
        assertUidLength(message.lowerUid, 'lowerUid');
        assertUidLength(message.upperUid, 'upperUid');
        const knownUids = message.knownUids ?? [];
        for (const uid of knownUids) assertUidLength(uid, 'knownUid');
        const dataLength = 4 + 6 + 6 + 2 + knownUids.length * 6;
        const totalLength = LLRP_PDU_HEADER_LENGTH + dataLength;
        const buf = Buffer.alloc(totalLength);
        writeLlrpHeader(buf, LlrpVector.ProbeRequest, message.destinationCid, message.transactionNumber, totalLength);
        const dataOffset = LLRP_PDU_HEADER_LENGTH;
        writePduLength(buf, dataOffset, dataLength);
        buf.writeUInt8(PROBE_REQUEST_SUB_VECTOR, dataOffset + 3);
        message.lowerUid.copy(buf, dataOffset + 4);
        message.upperUid.copy(buf, dataOffset + 10);
        buf.writeUInt16BE(message.filter ?? 0, dataOffset + 16);
        let offset = dataOffset + 18;
        for (const uid of knownUids) {
            uid.copy(buf, offset);
            offset += 6;
        }
        return buf;
    }

    if (message.vector === LlrpVector.ProbeReply) {
        assertUidLength(message.targetUid, 'targetUid');
        if (message.hardwareAddress.length !== 6) {
            throw new RangeError(`hardwareAddress must be 6 bytes, got ${message.hardwareAddress.length}`);
        }
        const totalLength = LLRP_PDU_HEADER_LENGTH + PROBE_REPLY_DATA_LENGTH;
        const buf = Buffer.alloc(totalLength);
        writeLlrpHeader(buf, LlrpVector.ProbeReply, message.destinationCid, message.transactionNumber, totalLength);
        const dataOffset = LLRP_PDU_HEADER_LENGTH;
        writePduLength(buf, dataOffset, PROBE_REPLY_DATA_LENGTH);
        buf.writeUInt8(PROBE_REPLY_SUB_VECTOR, dataOffset + 3);
        message.targetUid.copy(buf, dataOffset + 4);
        message.hardwareAddress.copy(buf, dataOffset + 10);
        buf.writeUInt8(message.componentType, dataOffset + 16);
        return buf;
    }

    if (message.rdm.length < 1 || message.rdm[0] !== 0xcc) {
        throw new RangeError('LLRP RDM payload must be a full RDM frame starting with 0xCC');
    }
    const dataLength = 3 + message.rdm.length;
    const totalLength = LLRP_PDU_HEADER_LENGTH + dataLength;
    const buf = Buffer.alloc(totalLength);
    writeLlrpHeader(buf, LlrpVector.RdmCommand, message.destinationCid, message.transactionNumber, totalLength);
    writePduLength(buf, LLRP_PDU_HEADER_LENGTH, dataLength);
    message.rdm.copy(buf, LLRP_PDU_HEADER_LENGTH + 3);
    return buf;
};

/** Parse one LLRP PDU's bytes (as produced by {@link encodeLlrpMessage}). */
export const decodeLlrpMessage = (buffer: Buffer): LlrpMessage => {
    if (buffer.length < LLRP_PDU_HEADER_LENGTH) throw new RangeError(`LLRP PDU too short: ${buffer.length}`);
    const {flagsNibble, length} = readPduLength(buffer, 0);
    assertPduFlags(flagsNibble, 'LLRP PDU');
    if (length > buffer.length) throw new RangeError('LLRP PDU length exceeds buffer');
    const vector = buffer.readUInt32BE(3) as LlrpVector;
    const destinationCid = Buffer.from(buffer.subarray(7, 23));
    const transactionNumber = buffer.readUInt32BE(23);
    const dataOffset = LLRP_PDU_HEADER_LENGTH;

    if (vector === LlrpVector.ProbeRequest) {
        if (dataOffset + 4 > length) throw new RangeError('LLRP probe request too short');
        const {flagsNibble: subFlags, length: dataLength} = readPduLength(buffer, dataOffset);
        assertPduFlags(subFlags, 'LLRP Probe Request data');
        if (dataLength < 18) throw new RangeError('LLRP probe request data too short');
        const lowerUid = Buffer.from(buffer.subarray(dataOffset + 4, dataOffset + 10));
        const upperUid = Buffer.from(buffer.subarray(dataOffset + 10, dataOffset + 16));
        const filter = buffer.readUInt16BE(dataOffset + 16);
        const knownUidsBytes = dataLength - 18;
        if (knownUidsBytes % 6 !== 0) throw new RangeError('LLRP probe request known-UID list is malformed');
        const knownUids: Buffer[] = [];
        for (let o = dataOffset + 18; o < dataOffset + dataLength; o += 6) {
            knownUids.push(Buffer.from(buffer.subarray(o, o + 6)));
        }
        return {vector, destinationCid, transactionNumber, lowerUid, upperUid, filter, knownUids};
    }

    if (vector === LlrpVector.ProbeReply) {
        if (dataOffset + PROBE_REPLY_DATA_LENGTH > length) throw new RangeError('LLRP probe reply too short');
        const {flagsNibble: subFlags} = readPduLength(buffer, dataOffset);
        assertPduFlags(subFlags, 'LLRP Probe Reply data');
        const targetUid = Buffer.from(buffer.subarray(dataOffset + 4, dataOffset + 10));
        const hardwareAddress = Buffer.from(buffer.subarray(dataOffset + 10, dataOffset + 16));
        const componentType = buffer.readUInt8(dataOffset + 16) as LlrpComponentType;
        return {vector, destinationCid, transactionNumber, targetUid, hardwareAddress, componentType};
    }

    if (vector === LlrpVector.RdmCommand) {
        if (dataOffset + 3 > length) throw new RangeError('LLRP RDM message too short');
        const {flagsNibble: subFlags, length: dataLength} = readPduLength(buffer, dataOffset);
        assertPduFlags(subFlags, 'LLRP RDM data');
        const rdm = Buffer.from(buffer.subarray(dataOffset + 3, dataOffset + dataLength));
        return {vector, destinationCid, transactionNumber, rdm};
    }

    throw new Error(`Unsupported LLRP vector 0x${(vector as number).toString(16)}`);
};
