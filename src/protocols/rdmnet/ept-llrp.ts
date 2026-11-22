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
    /** CID of the EPT Client this message is addressed to (required on the wire). Decoded messages always carry it. */
    destinationCid?: Buffer;
    /** @deprecated Not part of the E1.33 EPT PDU; ignored when encoding and never set when decoding. */
    sequence?: number;
    /** ESTA manufacturer ID half of the EPT protocol vector. */
    manufacturerId: number;
    /** Manufacturer-assigned protocol ID half of the EPT protocol vector. */
    protocolId: number;
    payload: Buffer;
};

export type EptStatusMessage = {
    vector: EptVector.Status;
    /** CID of the EPT Client this message is addressed to (required on the wire). Decoded messages always carry it. */
    destinationCid?: Buffer;
    /** @deprecated Not part of the E1.33 EPT PDU; ignored when encoding and never set when decoding. */
    sequence?: number;
    statusCode: EptStatusCode | number;
    text?: string;
};

/** EPT Status codes (E1.33 §8, defs.h). */
export enum EptStatusCode {
    UnknownCid = 0x0001,
    UnknownVector = 0x0002,
}

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

/** EPT PDU header: flags+length(3) + vector(4) + destination CID(16). */
const EPT_PDU_HEADER_LENGTH = 23;
/** EPT Data PDU header: flags+length(3) + protocol vector(4) = manufacturer ID(2) + protocol ID(2). */
const EPT_DATA_HEADER_LENGTH = 7;
/** EPT Status PDU header: flags+length(3) + status code(2). */
const EPT_STATUS_HEADER_LENGTH = 5;
/** Maximum EPT status string length (defs.h `EPT_STATUS_STRING_MAXLEN`). */
const EPT_STATUS_STRING_MAXLEN = 1024;

/**
 * Build wire bytes for one EPT PDU (placed after the 23-byte root layer by
 * the caller): flags+length, vector (Data/Status), destination CID, then
 * one EPT Data PDU (protocol vector + opaque data) or EPT Status PDU
 * (status code + optional UTF-8 status string).
 */
export const encodeEptMessage = (message: EptMessage): Buffer => {
    const destinationCid = message.destinationCid;
    if (!destinationCid || destinationCid.length !== 16) {
        throw new RangeError(`EPT destinationCid must be 16 bytes, got ${destinationCid?.length ?? 'none'}`);
    }

    let sub: Buffer;
    if (message.vector === EptVector.Data) {
        sub = Buffer.alloc(EPT_DATA_HEADER_LENGTH + message.payload.length);
        writePduLength(sub, 0, sub.length);
        sub.writeUInt16BE(message.manufacturerId & 0xffff, 3);
        sub.writeUInt16BE(message.protocolId & 0xffff, 5);
        message.payload.copy(sub, EPT_DATA_HEADER_LENGTH);
    } else if (message.vector === EptVector.Status) {
        const text = Buffer.from(message.text ?? '', 'utf8');
        if (text.length > EPT_STATUS_STRING_MAXLEN) {
            throw new RangeError(`EPT status string exceeds ${EPT_STATUS_STRING_MAXLEN} bytes`);
        }
        sub = Buffer.alloc(EPT_STATUS_HEADER_LENGTH + text.length);
        writePduLength(sub, 0, sub.length);
        sub.writeUInt16BE(message.statusCode & 0xffff, 3);
        text.copy(sub, EPT_STATUS_HEADER_LENGTH);
    } else {
        throw new Error('Unsupported EPT message');
    }

    const out = Buffer.alloc(EPT_PDU_HEADER_LENGTH + sub.length);
    writePduLength(out, 0, out.length);
    out.writeUInt32BE(message.vector, 3);
    destinationCid.copy(out, 7);
    sub.copy(out, EPT_PDU_HEADER_LENGTH);
    return out;
};

/** Parse one EPT PDU's bytes (as produced by {@link encodeEptMessage}). Bytes after the PDU are ignored. */
export const decodeEptMessage = (buffer: Buffer): EptMessage => {
    if (buffer.length < EPT_PDU_HEADER_LENGTH) throw new RangeError(`EPT PDU too short: ${buffer.length}`);
    const {flagsNibble, length} = readPduLength(buffer, 0);
    assertPduFlags(flagsNibble, 'EPT PDU');
    if (length < EPT_PDU_HEADER_LENGTH) throw new RangeError(`EPT PDU length ${length} too short`);
    if (length > buffer.length) throw new RangeError('EPT PDU length exceeds buffer');
    const vector = buffer.readUInt32BE(3);
    const destinationCid = Buffer.from(buffer.subarray(7, 23));
    const subOffset = EPT_PDU_HEADER_LENGTH;

    if (vector === EptVector.Data) {
        if (subOffset + EPT_DATA_HEADER_LENGTH > length) throw new RangeError('EPT Data PDU too short');
        const {flagsNibble: subFlags, length: subLength} = readPduLength(buffer, subOffset);
        assertPduFlags(subFlags, 'EPT Data PDU');
        if (subLength < EPT_DATA_HEADER_LENGTH || subOffset + subLength > length) {
            throw new RangeError(`EPT Data PDU length ${subLength} invalid`);
        }
        return {
            vector: EptVector.Data,
            destinationCid,
            manufacturerId: buffer.readUInt16BE(subOffset + 3),
            protocolId: buffer.readUInt16BE(subOffset + 5),
            payload: Buffer.from(buffer.subarray(subOffset + EPT_DATA_HEADER_LENGTH, subOffset + subLength)),
        };
    }

    if (vector === EptVector.Status) {
        if (subOffset + EPT_STATUS_HEADER_LENGTH > length) throw new RangeError('EPT Status PDU too short');
        const {flagsNibble: subFlags, length: subLength} = readPduLength(buffer, subOffset);
        assertPduFlags(subFlags, 'EPT Status PDU');
        if (subLength < EPT_STATUS_HEADER_LENGTH || subOffset + subLength > length) {
            throw new RangeError(`EPT Status PDU length ${subLength} invalid`);
        }
        const textBytes = buffer.subarray(subOffset + EPT_STATUS_HEADER_LENGTH, subOffset + subLength);
        const nul = textBytes.indexOf(0);
        return {
            vector: EptVector.Status,
            destinationCid,
            statusCode: buffer.readUInt16BE(subOffset + 3),
            text: textBytes.toString('utf8', 0, nul === -1 ? textBytes.length : nul),
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

/**
 * Parse one LLRP PDU's bytes (as produced by {@link encodeLlrpMessage}).
 * Every nested length is bounds-checked against both the enclosing PDU and
 * the buffer, so malformed input throws a RangeError/Error rather than
 * producing truncated fields.
 */
export const decodeLlrpMessage = (buffer: Buffer): LlrpMessage => {
    if (buffer.length < LLRP_PDU_HEADER_LENGTH) throw new RangeError(`LLRP PDU too short: ${buffer.length}`);
    const {flagsNibble, length} = readPduLength(buffer, 0);
    assertPduFlags(flagsNibble, 'LLRP PDU');
    if (length < LLRP_PDU_HEADER_LENGTH) throw new RangeError(`LLRP PDU length ${length} too short`);
    if (length > buffer.length) throw new RangeError('LLRP PDU length exceeds buffer');
    const vector = buffer.readUInt32BE(3) as LlrpVector;
    const destinationCid = Buffer.from(buffer.subarray(7, 23));
    const transactionNumber = buffer.readUInt32BE(23);
    const dataOffset = LLRP_PDU_HEADER_LENGTH;

    /** Reads the nested data PDU header and checks it fits inside the LLRP PDU. */
    const readDataPdu = (minLength: number, context: string): number => {
        if (dataOffset + 3 > length) throw new RangeError(`${context} truncated`);
        const {flagsNibble: subFlags, length: dataLength} = readPduLength(buffer, dataOffset);
        assertPduFlags(subFlags, context);
        if (dataLength < minLength) throw new RangeError(`${context} too short: ${dataLength}`);
        if (dataOffset + dataLength > length) throw new RangeError(`${context} length ${dataLength} exceeds LLRP PDU`);
        return dataLength;
    };

    if (vector === LlrpVector.ProbeRequest) {
        const dataLength = readDataPdu(18, 'LLRP Probe Request data');
        const lowerUid = Buffer.from(buffer.subarray(dataOffset + 4, dataOffset + 10));
        const upperUid = Buffer.from(buffer.subarray(dataOffset + 10, dataOffset + 16));
        const filter = buffer.readUInt16BE(dataOffset + 16);
        const knownUidsBytes = dataLength - 18;
        if (knownUidsBytes % 6 !== 0) throw new RangeError('LLRP probe request known-UID list is malformed');
        const knownUids: Buffer[] = [];
        for (let o = dataOffset + 18; o + 6 <= dataOffset + dataLength; o += 6) {
            knownUids.push(Buffer.from(buffer.subarray(o, o + 6)));
        }
        return {vector, destinationCid, transactionNumber, lowerUid, upperUid, filter, knownUids};
    }

    if (vector === LlrpVector.ProbeReply) {
        readDataPdu(PROBE_REPLY_DATA_LENGTH, 'LLRP Probe Reply data');
        const targetUid = Buffer.from(buffer.subarray(dataOffset + 4, dataOffset + 10));
        const hardwareAddress = Buffer.from(buffer.subarray(dataOffset + 10, dataOffset + 16));
        const componentType = buffer.readUInt8(dataOffset + 16) as LlrpComponentType;
        return {vector, destinationCid, transactionNumber, targetUid, hardwareAddress, componentType};
    }

    if (vector === LlrpVector.RdmCommand) {
        const dataLength = readDataPdu(4, 'LLRP RDM data');
        const rdm = Buffer.from(buffer.subarray(dataOffset + 3, dataOffset + dataLength));
        if (rdm[0] !== 0xcc) throw new Error('LLRP RDM data does not start with the 0xCC start code');
        return {vector, destinationCid, transactionNumber, rdm};
    }

    throw new Error(`Unsupported LLRP vector 0x${(vector as number).toString(16)}`);
};
