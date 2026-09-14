/**
 * ANSI E1.33 (RDMnet) RPT PDU (root vector {@link RdmnetRootVector.Rpt}).
 * @module rdmnet/rpt
 *
 * Verified against ETCLabs/RDMnet `src/rdmnet/core/rpt_prot.c` (pack
 * macros/functions read directly from source, not guessed) — including the
 * RDM Command PDU's "steal the leading 0xCC" encoding, a real gotcha: get
 * it wrong and every embedded RDM command/response fails checksum.
 */
import {decodeRdmRequest, decodeRdmResponse, encodeRdmRequest, encodeRdmResponse} from '../artnet/rdm/codec';
import type {RdmRequest, RdmResponse} from '../artnet/rdm/types';
import {uidFromBuffer, uidToBuffer} from '../artnet/rdm/uid';
import type {UID} from '../artnet/rdm/uid';
import {assertPduFlags, readPduLength, writePduLength} from './pdu';

/** RPT PDU vectors (defs.h). */
export enum RptVector {
    Request = 0x00000001,
    Status = 0x00000002,
    Notification = 0x00000003,
}

/** RPT Status codes carried in the Status sub-PDU's vector slot (defs.h). */
export enum RptStatusCode {
    UnknownRptUid = 0x0001,
    RdmTimeout = 0x0002,
    RdmInvalidResponse = 0x0003,
    UnknownRdmUid = 0x0004,
    UnknownEndpoint = 0x0005,
    BroadcastComplete = 0x0006,
    UnknownVector = 0x0007,
    InvalidMessage = 0x0008,
    InvalidCommandClass = 0x0009,
}

export type RptHeader = {
    sourceUid: UID;
    sourceEndpointId: number;
    destUid: UID;
    destEndpointId: number;
    sequenceNumber: number;
};

export type RptRequestMessage = {
    vector: RptVector.Request;
    header: RptHeader;
    /** Single RDM GET/SET/DISCOVERY command (Request always carries exactly one). */
    command: RdmRequest;
};

export type RptNotificationMessage = {
    vector: RptVector.Notification;
    header: RptHeader;
    /** One or more RDM responses, batched (e.g. multiple queued GET responses). */
    commands: RdmResponse[];
};

export type RptStatusMessage = {
    vector: RptVector.Status;
    header: RptHeader;
    statusCode: RptStatusCode;
    text?: string;
};

export type RptMessage = RptRequestMessage | RptNotificationMessage | RptStatusMessage;

const RPT_HEADER_LENGTH = 28;
/** Request/Notification wrapper header: flags+length(3) + vector(4). */
const WRAPPER_HEADER_LENGTH = 7;
const RDM_CMD_WRAPPER_VECTOR = 0x00000001;
/** Status sub-PDU header: flags+length(3) + status code(2). */
const STATUS_HEADER_LENGTH = 5;
/** RDM Command PDU header: flags+length(3) + vector(1, always 0xCC). */
const RDM_CMD_PDU_HEADER_LENGTH = 4;
const RDM_CMD_VECTOR = 0xcc;

function writeRptHeader(buf: Buffer, vector: RptVector, header: RptHeader, totalLength: number): void {
    writePduLength(buf, 0, totalLength);
    buf.writeUInt32BE(vector, 3);
    uidToBuffer(header.sourceUid).copy(buf, 7);
    buf.writeUInt16BE(header.sourceEndpointId & 0xffff, 13);
    uidToBuffer(header.destUid).copy(buf, 15);
    buf.writeUInt16BE(header.destEndpointId & 0xffff, 21);
    buf.writeUInt32BE(header.sequenceNumber >>> 0, 23);
    buf.writeUInt8(0, 27); // reserved
}

function readRptHeader(buf: Buffer): {vector: RptVector; header: RptHeader; length: number} {
    const {flagsNibble, length} = readPduLength(buf, 0);
    assertPduFlags(flagsNibble, 'RPT PDU');
    const vector = buf.readUInt32BE(3) as RptVector;
    const header: RptHeader = {
        sourceUid: uidFromBuffer(buf, 7),
        sourceEndpointId: buf.readUInt16BE(13),
        destUid: uidFromBuffer(buf, 15),
        destEndpointId: buf.readUInt16BE(21),
        sequenceNumber: buf.readUInt32BE(23),
    };
    return {vector, header, length};
}

/**
 * Encode one RDM Command PDU. The wire encoding drops the RDM frame's own
 * leading 0xCC start-code byte, since the PDU's own vector byte (also
 * 0xCC = {@link RDM_CMD_VECTOR}) stands in for it — `rpt_prot.c`'s
 * `PACK_RDM_CMD_PDU` macro copies `rdmFrame[1..]`, not `rdmFrame[0..]`.
 */
function encodeRdmCommandPdu(rdmFrame: Buffer): Buffer {
    if (rdmFrame.length < 1 || rdmFrame[0] !== 0xcc) {
        throw new RangeError('RDM frame must start with the RDM start code 0xCC');
    }
    const length = RDM_CMD_PDU_HEADER_LENGTH + (rdmFrame.length - 1);
    const buf = Buffer.alloc(length);
    writePduLength(buf, 0, length);
    buf.writeUInt8(RDM_CMD_VECTOR, 3);
    rdmFrame.copy(buf, 4, 1);
    return buf;
}

/** Inverse of {@link encodeRdmCommandPdu}: reconstructs the full RDM frame (0xCC prepended). */
function decodeRdmCommandPdu(buf: Buffer, offset: number): {rdmFrame: Buffer; length: number} {
    if (offset + RDM_CMD_PDU_HEADER_LENGTH > buf.length) throw new RangeError('RDM Command PDU truncated');
    const {flagsNibble, length} = readPduLength(buf, offset);
    assertPduFlags(flagsNibble, 'RDM Command PDU');
    if (offset + length > buf.length) throw new RangeError('RDM Command PDU exceeds buffer');
    const vector = buf.readUInt8(offset + 3);
    if (vector !== RDM_CMD_VECTOR) {
        throw new Error(`Unexpected RDM Command PDU vector 0x${vector.toString(16)} (expected 0xcc)`);
    }
    const rdmFrame = Buffer.concat([Buffer.from([0xcc]), buf.subarray(offset + 4, offset + length)]);
    return {rdmFrame, length};
}

/** Build wire bytes for one RPT message (placed after the 23-byte root layer by the caller). */
export const encodeRptMessage = (message: RptMessage): Buffer => {
    switch (message.vector) {
        case RptVector.Request: {
            const cmdPdu = encodeRdmCommandPdu(encodeRdmRequest(message.command));
            const wrapperLength = WRAPPER_HEADER_LENGTH + cmdPdu.length;
            const totalLength = RPT_HEADER_LENGTH + wrapperLength;
            const buf = Buffer.alloc(totalLength);
            writeRptHeader(buf, RptVector.Request, message.header, totalLength);
            writePduLength(buf, RPT_HEADER_LENGTH, wrapperLength);
            buf.writeUInt32BE(RDM_CMD_WRAPPER_VECTOR, RPT_HEADER_LENGTH + 3);
            cmdPdu.copy(buf, RPT_HEADER_LENGTH + WRAPPER_HEADER_LENGTH);
            return buf;
        }
        case RptVector.Notification: {
            if (message.commands.length === 0) {
                throw new RangeError('RPT Notification must carry at least one RDM response');
            }
            const cmdPdus = message.commands.map((response) => encodeRdmCommandPdu(encodeRdmResponse(response)));
            const wrapperLength = WRAPPER_HEADER_LENGTH + cmdPdus.reduce((sum, b) => sum + b.length, 0);
            const totalLength = RPT_HEADER_LENGTH + wrapperLength;
            const buf = Buffer.alloc(totalLength);
            writeRptHeader(buf, RptVector.Notification, message.header, totalLength);
            writePduLength(buf, RPT_HEADER_LENGTH, wrapperLength);
            buf.writeUInt32BE(RDM_CMD_WRAPPER_VECTOR, RPT_HEADER_LENGTH + 3);
            let offset = RPT_HEADER_LENGTH + WRAPPER_HEADER_LENGTH;
            for (const cmdPdu of cmdPdus) {
                cmdPdu.copy(buf, offset);
                offset += cmdPdu.length;
            }
            return buf;
        }
        case RptVector.Status: {
            const textBytes = Buffer.from(message.text ?? '', 'utf8');
            const statusLength = STATUS_HEADER_LENGTH + textBytes.length;
            const totalLength = RPT_HEADER_LENGTH + statusLength;
            const buf = Buffer.alloc(totalLength);
            writeRptHeader(buf, RptVector.Status, message.header, totalLength);
            writePduLength(buf, RPT_HEADER_LENGTH, statusLength);
            buf.writeUInt16BE(message.statusCode, RPT_HEADER_LENGTH + 3);
            textBytes.copy(buf, RPT_HEADER_LENGTH + STATUS_HEADER_LENGTH);
            return buf;
        }
        default:
            throw new Error('Unsupported RPT message');
    }
};

/** Parse one RPT PDU's bytes (as produced by {@link encodeRptMessage}). */
export const decodeRptMessage = (buf: Buffer): RptMessage => {
    if (buf.length < RPT_HEADER_LENGTH) throw new RangeError('RPT PDU too short');
    const {vector, header, length} = readRptHeader(buf);
    if (length > buf.length) throw new RangeError('RPT PDU length exceeds buffer');

    switch (vector) {
        case RptVector.Request: {
            if (RPT_HEADER_LENGTH + WRAPPER_HEADER_LENGTH > length) throw new RangeError('RPT Request PDU too short');
            const {flagsNibble} = readPduLength(buf, RPT_HEADER_LENGTH);
            assertPduFlags(flagsNibble, 'RPT Request wrapper');
            const {rdmFrame} = decodeRdmCommandPdu(buf, RPT_HEADER_LENGTH + WRAPPER_HEADER_LENGTH);
            return {vector, header, command: decodeRdmRequest(rdmFrame)};
        }
        case RptVector.Notification: {
            if (RPT_HEADER_LENGTH + WRAPPER_HEADER_LENGTH > length) {
                throw new RangeError('RPT Notification PDU too short');
            }
            const {flagsNibble, length: wrapperLength} = readPduLength(buf, RPT_HEADER_LENGTH);
            assertPduFlags(flagsNibble, 'RPT Notification wrapper');
            const commands: RdmResponse[] = [];
            let offset = RPT_HEADER_LENGTH + WRAPPER_HEADER_LENGTH;
            const wrapperEnd = RPT_HEADER_LENGTH + wrapperLength;
            while (offset < wrapperEnd) {
                const {rdmFrame, length: cmdLength} = decodeRdmCommandPdu(buf, offset);
                commands.push(decodeRdmResponse(rdmFrame));
                offset += cmdLength;
            }
            if (commands.length === 0) throw new RangeError('RPT Notification carried no RDM responses');
            return {vector, header, commands};
        }
        case RptVector.Status: {
            if (RPT_HEADER_LENGTH + STATUS_HEADER_LENGTH > length) throw new RangeError('RPT Status PDU too short');
            const {flagsNibble, length: statusLength} = readPduLength(buf, RPT_HEADER_LENGTH);
            assertPduFlags(flagsNibble, 'RPT Status');
            const statusCode = buf.readUInt16BE(RPT_HEADER_LENGTH + 3) as RptStatusCode;
            const textEnd = RPT_HEADER_LENGTH + statusLength;
            const text =
                textEnd > RPT_HEADER_LENGTH + STATUS_HEADER_LENGTH
                    ? buf.toString('utf8', RPT_HEADER_LENGTH + STATUS_HEADER_LENGTH, textEnd)
                    : undefined;
            return {vector, header, statusCode, text};
        }
        default:
            throw new Error(`Unsupported RPT vector 0x${(vector as number).toString(16)}`);
    }
};
