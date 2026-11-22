import {describe, expect, it} from 'vitest';

import {decodeRdmRequest, decodeRdmResponse, encodeRdmRequest, encodeRdmResponse} from '../src/protocols/artnet/rdm/codec';
import {PIDS, RdmCommandClass, RdmResponseType} from '../src/protocols/artnet/rdm/constants';
import {
    buildGetRequest,
    buildSetRequest,
    nextRdmTransactionNumber,
    sendGet,
    sendSet,
} from '../src/protocols/artnet/rdm/helpers';
import type {DiscoveryUniqueBranchResult, RdmTransport, RdmTransportOptions} from '../src/protocols/artnet/rdm/transport';
import type {RdmRequest, RdmResponse} from '../src/protocols/artnet/rdm/types';
import {uidFromString, uidToString} from '../src/protocols/artnet/rdm/uid';

const controllerUid = {manufacturerId: 0x7a70, deviceId: 0x00000001};
const deviceUid = {manufacturerId: 0x1234, deviceId: 0x00000042};

function fixChecksum(frame: Buffer, messageLength: number): void {
    let sum = 0;
    for (let i = 0; i < messageLength; i++) sum += frame[i]!;
    frame.writeUInt16BE(sum & 0xffff, messageLength);
}

describe('RDM codec length validation', () => {
    const request: RdmRequest = {
        destinationUid: deviceUid,
        sourceUid: controllerUid,
        transactionNumber: 5,
        portId: 1,
        commandClass: RdmCommandClass.SET_COMMAND,
        pid: PIDS.DMX_START_ADDRESS,
        parameterData: Buffer.from([0x00, 0x10]),
    };

    it('round-trips a request and tolerates trailing bytes after the checksum', () => {
        const frame = encodeRdmRequest(request);
        expect(decodeRdmRequest(frame).parameterData).toEqual(request.parameterData);
        expect(decodeRdmRequest(Buffer.concat([frame, Buffer.from([0, 0])])).pid).toBe(PIDS.DMX_START_ADDRESS);
    });

    it('rejects a Message Length larger than 24 + PDL even when the checksum is valid', () => {
        const frame = Buffer.concat([encodeRdmRequest(request), Buffer.alloc(2)]);
        frame[2] = 24 + 2 + 2; // claims 2 extra bytes beyond PDL
        fixChecksum(frame, frame[2]!);
        expect(() => decodeRdmRequest(frame)).toThrow(/does not match PDL/);
    });

    it('rejects a PDL that runs past the Message Length', () => {
        const frame = encodeRdmRequest(request);
        frame[23] = 3;
        fixChecksum(frame, frame[2]!);
        expect(() => decodeRdmRequest(frame)).toThrow(RangeError);
    });

    it('rejects truncated, mis-started and corrupted frames', () => {
        const frame = encodeRdmRequest(request);
        expect(() => decodeRdmRequest(frame.subarray(0, 20))).toThrow(RangeError);
        expect(() => decodeRdmRequest(frame.subarray(0, frame.length - 1))).toThrow(RangeError);
        const badStart = Buffer.from(frame);
        badStart[0] = 0x00;
        expect(() => decodeRdmRequest(badStart)).toThrow(/start code/);
        const badSum = Buffer.from(frame);
        badSum[24] = badSum[24]! ^ 0xff;
        expect(() => decodeRdmRequest(badSum)).toThrow(/checksum/);
        const tooShortLength = Buffer.from(frame);
        tooShortLength[2] = 10;
        expect(() => decodeRdmRequest(tooShortLength)).toThrow(RangeError);
    });

    it('round-trips a response', () => {
        const response: RdmResponse = {
            destinationUid: controllerUid,
            sourceUid: deviceUid,
            transactionNumber: 5,
            responseType: RdmResponseType.ACK,
            messageCount: 0,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND_RESPONSE,
            pid: PIDS.DEVICE_LABEL,
            parameterData: Buffer.from('label'),
        };
        expect(decodeRdmResponse(encodeRdmResponse(response))).toEqual(response);
    });
});

describe('uidFromString', () => {
    it('parses mmmm:dddddddd hex UIDs (case-insensitive, short forms allowed)', () => {
        expect(uidFromString('7a70:00000001')).toEqual({manufacturerId: 0x7a70, deviceId: 1});
        expect(uidFromString('FFFF:FFFFFFFF')).toEqual({manufacturerId: 0xffff, deviceId: 0xffffffff});
        expect(uidFromString('1:2')).toEqual({manufacturerId: 1, deviceId: 2});
        expect(uidFromString(uidToString(deviceUid))).toEqual(deviceUid);
    });

    it.each([
        '12zz:00000001',
        '7a70:12zz',
        '7a70:0000000g',
        '17a70:00000001',
        '7a70:100000000',
        '-1:00000001',
        '0x7a:00000001',
        ' 7a70:00000001',
        '7a70:00000001 ',
        ':00000001',
        '7a70:',
        '7a7000000001',
        '7a70:0000:0001',
        '',
    ])('rejects %j', (text) => {
        expect(() => uidFromString(text)).toThrow();
    });
});

class RecordingTransport implements RdmTransport {
    public readonly sent: Array<{request: RdmRequest; options?: RdmTransportOptions}> = [];
    private counter = 40;

    constructor(private readonly withCounter: boolean) {}

    get nextTransactionNumber(): (() => number) | undefined {
        return this.withCounter ? () => this.counter++ : undefined;
    }

    async send(request: RdmRequest, options?: RdmTransportOptions): Promise<RdmResponse | null> {
        this.sent.push({request, options});
        return {
            destinationUid: request.sourceUid,
            sourceUid: request.destinationUid,
            transactionNumber: request.transactionNumber,
            responseType: RdmResponseType.ACK,
            messageCount: 0,
            subDevice: request.subDevice ?? 0,
            commandClass: (request.commandClass + 1) as RdmCommandClass,
            pid: request.pid,
            parameterData: Buffer.alloc(0),
        };
    }

    async sendDiscoveryUniqueBranch(): Promise<DiscoveryUniqueBranchResult> {
        return {responses: []};
    }
}

describe('RDM request helpers', () => {
    it('buildGetRequest/buildSetRequest fill defaults and keep explicit fields', () => {
        const get = buildGetRequest(deviceUid, PIDS.DEVICE_INFO, {sourceUid: controllerUid, transactionNumber: 9});
        expect(get).toMatchObject({
            destinationUid: deviceUid,
            sourceUid: controllerUid,
            transactionNumber: 9,
            portId: 1,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: PIDS.DEVICE_INFO,
        });
        const data = Buffer.from([1]);
        const set = buildSetRequest(deviceUid, PIDS.IDENTIFY_DEVICE, {sourceUid: controllerUid, transactionNumber: 300, portId: 2, subDevice: 3}, data);
        expect(set).toMatchObject({transactionNumber: 300 & 0xff, portId: 2, subDevice: 3, commandClass: RdmCommandClass.SET_COMMAND});
        expect(set.parameterData).toBe(data);
    });

    it('auto-increments the transaction number instead of always using 0', () => {
        const a = buildGetRequest(deviceUid, PIDS.DEVICE_INFO, {sourceUid: controllerUid}).transactionNumber;
        const b = buildGetRequest(deviceUid, PIDS.DEVICE_INFO, {sourceUid: controllerUid}).transactionNumber;
        expect(b).toBe((a + 1) & 0xff);
        const values = Array.from({length: 256}, () => nextRdmTransactionNumber());
        expect(new Set(values).size).toBe(256);
        expect(values.every((v) => v >= 0 && v <= 255)).toBe(true);
    });

    it('sendGet/sendSet use the transport counter and forward payload and options', async () => {
        const transport = new RecordingTransport(true);
        const label = Buffer.from('hello');
        const getResponse = await sendGet(transport, deviceUid, PIDS.DMX_PERSONALITY_DESCRIPTION, {sourceUid: controllerUid}, {timeoutMs: 50}, Buffer.from([1]));
        const setResponse = await sendSet(transport, deviceUid, PIDS.DEVICE_LABEL, {sourceUid: controllerUid}, label, {timeoutMs: 60});

        expect(getResponse!.commandClass).toBe(RdmCommandClass.GET_COMMAND_RESPONSE);
        expect(setResponse!.commandClass).toBe(RdmCommandClass.SET_COMMAND_RESPONSE);
        expect(transport.sent.map((s) => s.request.transactionNumber)).toEqual([40, 41]);
        expect(transport.sent[0]!.request.parameterData).toEqual(Buffer.from([1]));
        expect(transport.sent[0]!.options).toEqual({timeoutMs: 50});
        expect(transport.sent[1]!.request.parameterData).toBe(label);
        expect(transport.sent[1]!.options).toEqual({timeoutMs: 60});
    });

    it('sendGet keeps an explicit transaction number and falls back to the shared counter', async () => {
        const transport = new RecordingTransport(false);
        await sendGet(transport, deviceUid, PIDS.DEVICE_INFO, {sourceUid: controllerUid, transactionNumber: 17});
        await sendGet(transport, deviceUid, PIDS.DEVICE_INFO, {sourceUid: controllerUid});
        await sendGet(transport, deviceUid, PIDS.DEVICE_INFO, {sourceUid: controllerUid});
        const [explicit, first, second] = transport.sent.map((s) => s.request.transactionNumber);
        expect(explicit).toBe(17);
        expect(second).toBe((first! + 1) & 0xff);
    });
});
