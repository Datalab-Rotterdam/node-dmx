/**
 * RDM encoder/decoder utilities.
 * @module artnet/rdm/codec
 *
 * Spec reference:
 * - ANSI E1.20 RDM (framing, checksum)
 *   https://getdlight.com/media/kunena/attachments/42/ANSI_E1-20_2010.pdf
 */
import {
    RDM_MAX_PDL,
    RDM_MIN_BYTES,
    RDM_MIN_MESSAGE_LENGTH,
    RDM_START_CODE,
    RDM_SUB_START_CODE,
    RdmCommandClass,
    RdmResponseType,
} from './constants';
import {uidFromBuffer, uidToBuffer} from './uid';
import type {RdmRequest, RdmResponse} from './types';

function checksum16(buf: Buffer, length: number): number {
    let sum = 0;
    for (let i = 0; i < length; i++) {
        sum += buf[i]!;
    }
    return sum & 0xffff;
}

/**
 * Encode an RDM request into raw wire bytes including checksum.
 * @param request Request fields.
 */
export function encodeRdmRequest(request: RdmRequest): Buffer {
    const parameterData = request.parameterData ?? Buffer.alloc(0);
    if (parameterData.length > RDM_MAX_PDL) {
        throw new RangeError(`Parameter data too long (${parameterData.length})`);
    }

    const messageLength = RDM_MIN_MESSAGE_LENGTH + parameterData.length;
    const buf = Buffer.alloc(messageLength + 2);
    buf.writeUInt8(RDM_START_CODE, 0);
    buf.writeUInt8(RDM_SUB_START_CODE, 1);
    buf.writeUInt8(messageLength, 2);
    uidToBuffer(request.destinationUid).copy(buf, 3);
    uidToBuffer(request.sourceUid).copy(buf, 9);
    buf.writeUInt8(request.transactionNumber & 0xff, 15);
    buf.writeUInt8(request.portId & 0xff, 16);
    buf.writeUInt8(request.messageCount ?? 0, 17);
    buf.writeUInt16BE(request.subDevice ?? 0, 18);
    buf.writeUInt8(request.commandClass, 20);
    buf.writeUInt16BE(request.pid & 0xffff, 21);
    buf.writeUInt8(parameterData.length & 0xff, 23);
    if (parameterData.length > 0) {
        parameterData.copy(buf, 24);
    }
    const checksum = checksum16(buf, messageLength);
    buf.writeUInt16BE(checksum, messageLength);
    return buf;
}

/**
 * Decode and validate an RDM response frame.
 * @param buf Raw RDM bytes including checksum.
 * @throws Error when start code, length, or checksum is invalid.
 */
export function decodeRdmResponse(buf: Buffer): RdmResponse {
    if (buf.length < RDM_MIN_BYTES) {
        throw new RangeError('RDM buffer too short');
    }
    if (buf.readUInt8(0) !== RDM_START_CODE || buf.readUInt8(1) !== RDM_SUB_START_CODE) {
        throw new Error('Invalid RDM start code');
    }
    const messageLength = buf.readUInt8(2);
    if (messageLength < RDM_MIN_MESSAGE_LENGTH || messageLength + 2 > buf.length) {
        throw new RangeError(`Invalid RDM message length ${messageLength}`);
    }
    const checksum = buf.readUInt16BE(messageLength);
    const expected = checksum16(buf, messageLength);
    if (checksum !== expected) {
        throw new Error('RDM checksum mismatch');
    }

    const destinationUid = uidFromBuffer(buf, 3);
    const sourceUid = uidFromBuffer(buf, 9);
    const transactionNumber = buf.readUInt8(15);
    const responseType = buf.readUInt8(16) as RdmResponseType;
    const messageCount = buf.readUInt8(17);
    const subDevice = buf.readUInt16BE(18);
    const commandClass = buf.readUInt8(20) as RdmCommandClass;
    const pid = buf.readUInt16BE(21);
    const pdl = buf.readUInt8(23);
    const dataEnd = 24 + pdl;
    if (dataEnd > messageLength) {
        throw new RangeError('Invalid PDL');
    }
    const parameterData = Buffer.from(buf.subarray(24, dataEnd));

    return {
        destinationUid,
        sourceUid,
        transactionNumber,
        responseType,
        messageCount,
        subDevice,
        commandClass,
        pid,
        parameterData,
    };
}
