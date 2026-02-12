/**
 * RDMnet RPT message helpers.
 * @module rdmnet/rpt
 */
import {decodeRdmResponse, encodeRdmRequest} from '../artnet';
import type {RdmRequest, RdmResponse} from '../artnet';
import {uidFromBuffer, uidToBuffer} from '../artnet';
import {BrokerClientRole} from './broker';

export enum RptVector {
    Status = 0x00000001,
    RdmCommand = 0x00000002,
    RdmResponse = 0x00000003,
    EndpointAdvertisement = 0x00000010,
    EndpointAdvertisementAck = 0x00000011,
}

export type RptStatusMessage = {
    vector: RptVector.Status;
    sequence: number;
    statusCode: number;
    text?: string;
};

export type RptRdmCommandMessage = {
    vector: RptVector.RdmCommand;
    sequence: number;
    endpointId: number;
    request: RdmRequest;
};

export type RptRdmResponseMessage = {
    vector: RptVector.RdmResponse;
    sequence: number;
    endpointId: number;
    response: RdmResponse;
};

export type RptEndpointAdvertisementMessage = {
    vector: RptVector.EndpointAdvertisement;
    sequence: number;
    endpointId: number;
    role: BrokerClientRole;
    profiles: number[];
};

export type RptEndpointAdvertisementAckMessage = {
    vector: RptVector.EndpointAdvertisementAck;
    sequence: number;
    endpointId: number;
    accepted: boolean;
    statusCode: number;
};

export type RptMessage =
    | RptStatusMessage
    | RptRdmCommandMessage
    | RptRdmResponseMessage
    | RptEndpointAdvertisementMessage
    | RptEndpointAdvertisementAckMessage;

function checksum16(buf: Buffer): number {
    let sum = 0;
    for (const byte of buf) sum = (sum + byte) & 0xffff;
    return sum;
}

function encodeRdmResponseFrame(response: RdmResponse): Buffer {
    const pdl = response.parameterData.length;
    const messageLength = 24 + pdl;
    const buf = Buffer.alloc(messageLength + 2);
    buf.writeUInt8(0xcc, 0);
    buf.writeUInt8(0x01, 1);
    buf.writeUInt8(messageLength & 0xff, 2);
    uidToBuffer(response.destinationUid).copy(buf, 3);
    uidToBuffer(response.sourceUid).copy(buf, 9);
    buf.writeUInt8(response.transactionNumber & 0xff, 15);
    buf.writeUInt8(response.responseType & 0xff, 16);
    buf.writeUInt8(response.messageCount & 0xff, 17);
    buf.writeUInt16BE(response.subDevice & 0xffff, 18);
    buf.writeUInt8(response.commandClass & 0xff, 20);
    buf.writeUInt16BE(response.pid & 0xffff, 21);
    buf.writeUInt8(pdl & 0xff, 23);
    response.parameterData.copy(buf, 24);
    buf.writeUInt16BE(checksum16(buf.subarray(0, messageLength)), messageLength);
    return buf;
}

const VALID_BROKER_ROLES = new Set<number>([
    BrokerClientRole.Controller,
    BrokerClientRole.Device,
    BrokerClientRole.Monitor,
]);

function assertOuterUidMirror(rdm: Buffer, outerDestination: Buffer, outerSource: Buffer): void {
    const embeddedDestination = rdm.subarray(3, 9);
    const embeddedSource = rdm.subarray(9, 15);
    if (!embeddedDestination.equals(outerDestination)) {
        throw new RangeError('RPT outer destination UID does not match embedded RDM frame');
    }
    if (!embeddedSource.equals(outerSource)) {
        throw new RangeError('RPT outer source UID does not match embedded RDM frame');
    }
}

/**
 * Build wire payload for one RPT message.
 *
 * NOTE: This is a strict, documented internal RPT framing profile used by this
 * library for controller/device interoperability over RDMnet root vector RPT.
 */
export const encodeRptMessage = (message: RptMessage): Buffer => {
    if (message.vector === RptVector.Status) {
        const textBytes = Buffer.from(message.text ?? '', 'utf8');
        const out = Buffer.alloc(12 + textBytes.length);
        out.writeUInt32BE(RptVector.Status, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.statusCode & 0xffff, 8);
        out.writeUInt16BE(textBytes.length & 0xffff, 10);
        textBytes.copy(out, 12);
        return out;
    }

    if (message.vector === RptVector.RdmCommand) {
        const rdm = encodeRdmRequest(message.request);
        const out = Buffer.alloc(24 + rdm.length);
        out.writeUInt32BE(RptVector.RdmCommand, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.endpointId & 0xffff, 8);
        out.writeUInt16BE(rdm.length & 0xffff, 10);
        uidToBuffer(message.request.destinationUid).copy(out, 12);
        uidToBuffer(message.request.sourceUid).copy(out, 18);
        rdm.copy(out, 24);
        return out;
    }

    if (message.vector === RptVector.EndpointAdvertisement) {
        if (message.profiles.length > 255) {
            throw new RangeError(`RPT endpoint advertisement supports max 255 profiles, got ${message.profiles.length}`);
        }
        const out = Buffer.alloc(12 + message.profiles.length * 2);
        out.writeUInt32BE(RptVector.EndpointAdvertisement, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.endpointId & 0xffff, 8);
        out.writeUInt8(message.role & 0xff, 10);
        out.writeUInt8(message.profiles.length & 0xff, 11);
        for (let i = 0; i < message.profiles.length; i++) {
            out.writeUInt16BE(message.profiles[i]! & 0xffff, 12 + i * 2);
        }
        return out;
    }

    if (message.vector === RptVector.EndpointAdvertisementAck) {
        const out = Buffer.alloc(13);
        out.writeUInt32BE(RptVector.EndpointAdvertisementAck, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.endpointId & 0xffff, 8);
        out.writeUInt8(message.accepted ? 1 : 0, 10);
        out.writeUInt16BE(message.statusCode & 0xffff, 11);
        return out;
    }

    const response = message.response;
    const rawRdm = encodeRdmResponseFrame(response);

    const out = Buffer.alloc(24 + rawRdm.length);
    out.writeUInt32BE(RptVector.RdmResponse, 0);
    out.writeUInt32BE(message.sequence >>> 0, 4);
    out.writeUInt16BE(message.endpointId & 0xffff, 8);
    out.writeUInt16BE(rawRdm.length & 0xffff, 10);
    uidToBuffer(response.destinationUid).copy(out, 12);
    uidToBuffer(response.sourceUid).copy(out, 18);
    rawRdm.copy(out, 24);
    return out;
};

/**
 * Parse one RPT payload message.
 */
export const decodeRptMessage = (buffer: Buffer): RptMessage => {
    if (buffer.length < 12) {
        throw new RangeError(`RPT buffer too short: ${buffer.length}`);
    }
    const vector = buffer.readUInt32BE(0);
    const sequence = buffer.readUInt32BE(4);

    if (vector === RptVector.Status) {
        const statusCode = buffer.readUInt16BE(8);
        const textLength = buffer.readUInt16BE(10);
        if (12 + textLength > buffer.length) {
            throw new RangeError('RPT status text length exceeds packet length');
        }
        if (12 + textLength !== buffer.length) {
            throw new RangeError('RPT status message has trailing bytes');
        }
        return {
            vector: RptVector.Status,
            sequence,
            statusCode,
            text: buffer.toString('utf8', 12, 12 + textLength),
        };
    }

    if (vector === RptVector.RdmCommand) {
        if (buffer.length < 24) throw new RangeError('RPT RDM command too short');
        const endpointId = buffer.readUInt16BE(8);
        const rdmLength = buffer.readUInt16BE(10);
        if (24 + rdmLength > buffer.length) {
            throw new RangeError('RPT RDM command length exceeds packet length');
        }
        if (24 + rdmLength !== buffer.length) {
            throw new RangeError('RPT RDM command has trailing bytes');
        }
        const rdm = Buffer.from(buffer.subarray(24, 24 + rdmLength));
        if (rdm.length < 24) {
            throw new RangeError('RPT embedded RDM request too short');
        }
        if (rdm.readUInt8(0) !== 0xcc || rdm.readUInt8(1) !== 0x01) {
            throw new RangeError('RPT embedded RDM request has invalid start code');
        }
        const messageLength = rdm.readUInt8(2);
        if (messageLength + 2 !== rdm.length) {
            throw new RangeError('RPT embedded RDM request length does not match payload');
        }
        if (rdm.readUInt16BE(messageLength) !== checksum16(rdm.subarray(0, messageLength))) {
            throw new RangeError('RPT embedded RDM request checksum mismatch');
        }
        assertOuterUidMirror(rdm, buffer.subarray(12, 18), buffer.subarray(18, 24));
        const destinationUid = uidFromBuffer(rdm, 3);
        const sourceUid = uidFromBuffer(rdm, 9);
        const transactionNumber = rdm.readUInt8(15);
        const portId = rdm.readUInt8(16);
        const messageCount = rdm.readUInt8(17);
        const subDevice = rdm.readUInt16BE(18);
        const commandClass = rdm.readUInt8(20);
        const pid = rdm.readUInt16BE(21);
        const pdl = rdm.readUInt8(23);
        if (24 + pdl > rdm.length) {
            throw new RangeError('RPT embedded RDM request PDL exceeds message length');
        }
        const parameterData = Buffer.from(rdm.subarray(24, 24 + pdl));

        return {
            vector: RptVector.RdmCommand,
            sequence,
            endpointId,
            request: {
                destinationUid,
                sourceUid,
                transactionNumber,
                portId,
                messageCount,
                subDevice,
                commandClass,
                pid,
                parameterData,
            },
        };
    }

    if (vector === RptVector.RdmResponse) {
        if (buffer.length < 24) throw new RangeError('RPT RDM response too short');
        const endpointId = buffer.readUInt16BE(8);
        const rdmLength = buffer.readUInt16BE(10);
        if (24 + rdmLength > buffer.length) {
            throw new RangeError('RPT RDM response length exceeds packet length');
        }
        if (24 + rdmLength !== buffer.length) {
            throw new RangeError('RPT RDM response has trailing bytes');
        }
        const rdm = Buffer.from(buffer.subarray(24, 24 + rdmLength));
        assertOuterUidMirror(rdm, buffer.subarray(12, 18), buffer.subarray(18, 24));
        const response = decodeRdmResponse(rdm);
        return {
            vector: RptVector.RdmResponse,
            sequence,
            endpointId,
            response,
        };
    }

    if (vector === RptVector.EndpointAdvertisement) {
        if (buffer.length < 12) throw new RangeError('RPT endpoint advertisement too short');
        const endpointId = buffer.readUInt16BE(8);
        const roleRaw = buffer.readUInt8(10);
        if (!VALID_BROKER_ROLES.has(roleRaw)) {
            throw new RangeError(`RPT endpoint advertisement has invalid role ${roleRaw}`);
        }
        const count = buffer.readUInt8(11);
        if (12 + count * 2 > buffer.length) {
            throw new RangeError('RPT endpoint advertisement profiles exceed packet length');
        }
        if (12 + count * 2 !== buffer.length) {
            throw new RangeError('RPT endpoint advertisement has trailing bytes');
        }
        const profiles: number[] = [];
        for (let i = 0; i < count; i++) {
            profiles.push(buffer.readUInt16BE(12 + i * 2));
        }
        return {
            vector: RptVector.EndpointAdvertisement,
            sequence,
            endpointId,
            role: roleRaw as BrokerClientRole,
            profiles,
        };
    }

    if (vector === RptVector.EndpointAdvertisementAck) {
        if (buffer.length < 13) throw new RangeError('RPT endpoint advertisement ack too short');
        if (buffer.length !== 13) throw new RangeError('RPT endpoint advertisement ack has trailing bytes');
        const accepted = buffer.readUInt8(10);
        if (accepted !== 0 && accepted !== 1) {
            throw new RangeError(`RPT endpoint advertisement ack has invalid accepted flag ${accepted}`);
        }
        return {
            vector: RptVector.EndpointAdvertisementAck,
            sequence,
            endpointId: buffer.readUInt16BE(8),
            accepted: accepted === 1,
            statusCode: buffer.readUInt16BE(11),
        };
    }

    throw new Error(`Unsupported RPT vector 0x${vector.toString(16)}`);
};
