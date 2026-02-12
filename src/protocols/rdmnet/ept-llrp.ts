/**
 * RDMnet EPT/LLRP message helpers.
 * @module rdmnet/ept-llrp
 */

export enum EptVector {
    Data = 0x00000001,
    Status = 0x00000002,
}

export enum LlrpVector {
    ProbeRequest = 0x00000001,
    ProbeReply = 0x00000002,
    RdmCommand = 0x00000003,
    RdmResponse = 0x00000004,
}

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

export type LlrpProbeRequestMessage = {
    vector: LlrpVector.ProbeRequest;
    sequence: number;
    lowerUid: Buffer;
    upperUid: Buffer;
};

export type LlrpProbeReplyMessage = {
    vector: LlrpVector.ProbeReply;
    sequence: number;
    targetUid: Buffer;
};

export type LlrpRdmMessage = {
    vector: LlrpVector.RdmCommand | LlrpVector.RdmResponse;
    sequence: number;
    targetUid: Buffer;
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

export const encodeLlrpMessage = (message: LlrpMessage): Buffer => {
    if (message.vector === LlrpVector.ProbeRequest) {
        assertUidLength(message.lowerUid, 'lowerUid');
        assertUidLength(message.upperUid, 'upperUid');
        const out = Buffer.alloc(20);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        message.lowerUid.copy(out, 8);
        message.upperUid.copy(out, 14);
        return out;
    }

    if (message.vector === LlrpVector.ProbeReply) {
        assertUidLength(message.targetUid, 'targetUid');
        const out = Buffer.alloc(14);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        message.targetUid.copy(out, 8);
        return out;
    }

    assertUidLength(message.targetUid, 'targetUid');
    const out = Buffer.alloc(16 + message.rdm.length);
    out.writeUInt32BE(message.vector, 0);
    out.writeUInt32BE(message.sequence >>> 0, 4);
    message.targetUid.copy(out, 8);
    out.writeUInt16BE(message.rdm.length & 0xffff, 14);
    message.rdm.copy(out, 16);
    return out;
};

export const decodeLlrpMessage = (buffer: Buffer): LlrpMessage => {
    if (buffer.length < 8) throw new RangeError(`LLRP message too short: ${buffer.length}`);
    const vector = buffer.readUInt32BE(0);
    const sequence = buffer.readUInt32BE(4);

    if (vector === LlrpVector.ProbeRequest) {
        if (buffer.length < 20) throw new RangeError('LLRP probe request too short');
        if (buffer.length !== 20) throw new RangeError('LLRP probe request has trailing bytes');
        return {
            vector: LlrpVector.ProbeRequest,
            sequence,
            lowerUid: Buffer.from(buffer.subarray(8, 14)),
            upperUid: Buffer.from(buffer.subarray(14, 20)),
        };
    }

    if (vector === LlrpVector.ProbeReply) {
        if (buffer.length < 14) throw new RangeError('LLRP probe reply too short');
        if (buffer.length !== 14) throw new RangeError('LLRP probe reply has trailing bytes');
        return {
            vector: LlrpVector.ProbeReply,
            sequence,
            targetUid: Buffer.from(buffer.subarray(8, 14)),
        };
    }

    if (vector === LlrpVector.RdmCommand || vector === LlrpVector.RdmResponse) {
        if (buffer.length < 16) throw new RangeError('LLRP RDM message too short');
        const rdmLength = buffer.readUInt16BE(14);
        if (16 + rdmLength > buffer.length) throw new RangeError('LLRP RDM length exceeds packet length');
        if (16 + rdmLength !== buffer.length) throw new RangeError('LLRP RDM message has trailing bytes');
        return {
            vector,
            sequence,
            targetUid: Buffer.from(buffer.subarray(8, 14)),
            rdm: Buffer.from(buffer.subarray(16, 16 + rdmLength)),
        };
    }

    throw new Error(`Unsupported LLRP vector 0x${vector.toString(16)}`);
};
