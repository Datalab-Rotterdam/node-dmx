import {createSocket, type Socket} from 'dgram';
import {afterEach, describe, expect, it} from 'vitest';

import {ArtNetRdmClient} from '../src/protocols/artnet/rdm/artnet-client';
import {ARTNET_ID, OpCode} from '../src/protocols/artnet';
import {RdmCommandClass, RdmResponseType} from '../src/protocols/artnet/rdm/constants';
import {uidToBuffer} from '../src/protocols/artnet/rdm/uid';
import type {RdmRequest} from '../src/protocols/artnet/rdm/types';

function writeHeader(buffer: Buffer, opcode: OpCode): void {
    buffer.write(ARTNET_ID, 0, 'ascii');
    buffer.writeUInt16LE(opcode, 8);
    buffer.writeUInt16BE(14, 10);
}

/** Build a spec-shaped ArtRdm response wrapping a raw RDM ACK frame. */
function buildFakeArtRdmResponse(rdmFrame: Buffer): Buffer {
    // Header layout must match buildArtRdm in artnet-packets.ts: RdmPacket at offset 24.
    const buffer = Buffer.alloc(24 + rdmFrame.length);
    writeHeader(buffer, OpCode.OpRdm);
    buffer.writeUInt8(1, 12); // RdmVer
    buffer.writeUInt8(0, 21); // Net
    buffer.writeUInt8(0, 22); // Command
    buffer.writeUInt8(0, 23); // Address
    rdmFrame.copy(buffer, 24);
    return buffer;
}

function checksum16(buf: Buffer, length: number): number {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += buf[i]!;
    return sum & 0xffff;
}

function buildRdmAckFrame(request: RdmRequest, parameterData: Buffer): Buffer {
    const messageLength = 24 + parameterData.length;
    const buf = Buffer.alloc(messageLength + 2);
    buf.writeUInt8(0xcc, 0);
    buf.writeUInt8(0x01, 1);
    buf.writeUInt8(messageLength, 2);
    uidToBuffer(request.sourceUid).copy(buf, 3); // response destination = original source
    uidToBuffer(request.destinationUid).copy(buf, 9); // response source = original destination
    buf.writeUInt8(request.transactionNumber & 0xff, 15);
    buf.writeUInt8(RdmResponseType.ACK, 16);
    buf.writeUInt8(0, 17);
    buf.writeUInt16BE(0, 18);
    buf.writeUInt8(RdmCommandClass.GET_COMMAND_RESPONSE, 20);
    buf.writeUInt16BE(request.pid, 21);
    buf.writeUInt8(parameterData.length, 23);
    parameterData.copy(buf, 24);
    buf.writeUInt16BE(checksum16(buf, messageLength), messageLength);
    // First byte after RdmPacket-embedding strips the 0xCC start code
    // per buildArtRdm's convention (see artnet-client.ts rdmTransaction).
    return buf.subarray(1);
}

describe('ArtNetRdmClient (loopback UDP)', () => {
    let fakeDevice: Socket | undefined;
    let client: ArtNetRdmClient | undefined;

    afterEach(() => {
        client?.close();
        fakeDevice?.close();
        client = undefined;
        fakeDevice = undefined;
    });

    it('sends an RDM GET request and decodes the device ACK response at the correct offset', async () => {
        fakeDevice = createSocket('udp4');
        await new Promise<void>((resolve) => fakeDevice!.bind(0, '127.0.0.1', resolve));
        const devicePort = (fakeDevice.address() as {port: number}).port;

        const request: RdmRequest = {
            destinationUid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
            sourceUid: {manufacturerId: 0x7a70, deviceId: 0x00000002},
            transactionNumber: 1,
            portId: 1,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: 0x0060,
        };

        fakeDevice.on('message', (msg, rinfo) => {
            expect(msg.toString('ascii', 0, 8)).toBe(ARTNET_ID);
            expect(msg.readUInt16LE(8)).toBe(OpCode.OpRdm);
            const embeddedRdm = msg.subarray(24);
            expect(embeddedRdm[0]).toBe(0x01); // sub-start code (0xCC stripped before embedding)

            const parameterData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
            const ackFrame = buildRdmAckFrame(request, parameterData);
            const response = buildFakeArtRdmResponse(ackFrame);
            fakeDevice!.send(response, rinfo.port, rinfo.address);
        });

        client = new ArtNetRdmClient({host: '127.0.0.1', port: devicePort, timeoutMs: 300});
        const response = await client.rdmTransaction(1, request);

        expect(response).not.toBeNull();
        expect(response!.sourceUid).toEqual(request.destinationUid);
        expect(response!.destinationUid).toEqual(request.sourceUid);
        expect(response!.responseType).toBe(RdmResponseType.ACK);
        expect(response!.pid).toBe(request.pid);
        expect(Array.from(response!.parameterData)).toEqual([0x01, 0x02, 0x03, 0x04]);
    });

    it('ignores stray non-Art-Net UDP traffic while waiting for a reply', async () => {
        fakeDevice = createSocket('udp4');
        await new Promise<void>((resolve) => fakeDevice!.bind(0, '127.0.0.1', resolve));
        const devicePort = (fakeDevice.address() as {port: number}).port;

        const request: RdmRequest = {
            destinationUid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
            sourceUid: {manufacturerId: 0x7a70, deviceId: 0x00000002},
            transactionNumber: 2,
            portId: 1,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: 0x0060,
        };

        fakeDevice.on('message', (_msg, rinfo) => {
            // Stray, unrelated broadcast-shaped traffic that must be filtered out.
            fakeDevice!.send(Buffer.from('not an art-net packet at all'), rinfo.port, rinfo.address);

            const parameterData = Buffer.from([0xaa]);
            const ackFrame = buildRdmAckFrame(request, parameterData);
            const response = buildFakeArtRdmResponse(ackFrame);
            fakeDevice!.send(response, rinfo.port, rinfo.address);
        });

        client = new ArtNetRdmClient({host: '127.0.0.1', port: devicePort, timeoutMs: 300});
        const response = await client.rdmTransaction(1, request);

        expect(response).not.toBeNull();
        expect(Array.from(response!.parameterData)).toEqual([0xaa]);
    });
});
