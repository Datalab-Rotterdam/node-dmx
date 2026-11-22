import {createSocket, type Socket} from 'dgram';
import {afterEach, describe, expect, it} from 'vitest';

import {ArtNetRdmClient} from '../src/protocols/artnet/rdm/artnet-client';
import {buildArtRdm, buildArtTodData, parseArtRdm} from '../src/protocols/artnet/rdm/artnet-packets';
import {decodeRdmRequest, encodeRdmResponse} from '../src/protocols/artnet/rdm/codec';
import {PIDS, RdmCommandClass, RdmResponseType} from '../src/protocols/artnet/rdm/constants';
import type {RdmRequest, RdmResponse} from '../src/protocols/artnet/rdm/types';
import {ARTNET_ID, OpCode} from '../src/protocols/artnet';

const controllerUid = {manufacturerId: 0x7a70, deviceId: 0x00000001};
const deviceA = {manufacturerId: 0x7a70, deviceId: 0x000000a0};
const deviceB = {manufacturerId: 0x7a70, deviceId: 0x000000b0};

type Received = {request: RdmRequest; rinfo: {address: string; port: number}};

function ackFor(request: RdmRequest, data: Buffer, overrides: Partial<RdmResponse> = {}): Buffer {
    const frame = encodeRdmResponse({
        destinationUid: request.sourceUid,
        sourceUid: request.destinationUid,
        transactionNumber: request.transactionNumber,
        responseType: RdmResponseType.ACK,
        messageCount: 0,
        subDevice: 0,
        commandClass: (request.commandClass + 1) as RdmCommandClass,
        pid: request.pid,
        parameterData: data,
        ...overrides,
    });
    return buildArtRdm({universe: 1, rdmPacket: frame.subarray(1)});
}

function getDeviceInfo(destinationUid: typeof deviceA) {
    return {
        destinationUid,
        sourceUid: controllerUid,
        portId: 1,
        commandClass: RdmCommandClass.GET_COMMAND,
        pid: PIDS.DEVICE_INFO,
    };
}

describe('ArtNetRdmClient reply correlation', () => {
    let device: Socket | undefined;
    let client: ArtNetRdmClient | undefined;

    afterEach(() => {
        client?.close();
        device?.close();
        client = undefined;
        device = undefined;
    });

    async function startDevice(onRequest: (received: Received, socket: Socket) => void): Promise<number> {
        device = createSocket('udp4');
        await new Promise<void>((resolve) => device!.bind(0, '127.0.0.1', resolve));
        device.on('message', (msg, rinfo) => {
            const parsed = parseArtRdm(msg);
            if (!parsed) return;
            onRequest({request: decodeRdmRequest(parsed.rdmPacket), rinfo}, device!);
        });
        return (device.address() as {port: number}).port;
    }

    it('routes concurrent replies to the right caller and resolves without waiting for the timeout', async () => {
        const received: Received[] = [];
        const port = await startDevice((r, socket) => {
            received.push(r);
            if (received.length < 2) return;
            // Answer in reverse order.
            for (const {request, rinfo} of [...received].reverse()) {
                const data = Buffer.from([request.destinationUid.deviceId & 0xff]);
                socket.send(ackFor(request, data), rinfo.port, rinfo.address);
            }
        });
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 2000, localPort: 0});

        const started = Date.now();
        const [a, b] = await Promise.all([
            client.rdmTransaction(1, getDeviceInfo(deviceA)),
            client.rdmTransaction(1, getDeviceInfo(deviceB)),
        ]);
        expect(Date.now() - started).toBeLessThan(1500);
        expect(a!.sourceUid).toEqual(deviceA);
        expect(Array.from(a!.parameterData)).toEqual([0xa0]);
        expect(b!.sourceUid).toEqual(deviceB);
        expect(Array.from(b!.parameterData)).toEqual([0xb0]);
        // Auto-assigned, distinct transaction numbers.
        expect(received[0]!.request.transactionNumber).not.toBe(received[1]!.request.transactionNumber);
    });

    it('ignores replies with a wrong transaction number, source UID, destination UID or command class', async () => {
        const port = await startDevice(({request, rinfo}, socket) => {
            const wrong = [
                ackFor(request, Buffer.from([1]), {transactionNumber: (request.transactionNumber + 1) & 0xff}),
                ackFor(request, Buffer.from([2]), {sourceUid: deviceB}),
                ackFor(request, Buffer.from([3]), {destinationUid: deviceB}),
                ackFor(request, Buffer.from([4]), {commandClass: RdmCommandClass.SET_COMMAND_RESPONSE}),
                ackFor(request, Buffer.from([5])).subarray(0, 30), // truncated / malformed
            ];
            for (const packet of wrong) socket.send(packet, rinfo.port, rinfo.address);
            setTimeout(() => socket.send(ackFor(request, Buffer.from([0x42])), rinfo.port, rinfo.address), 30);
        });
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 1000, localPort: 0});
        const response = await client.rdmTransaction(1, {...getDeviceInfo(deviceA), transactionNumber: 7});
        expect(response!.transactionNumber).toBe(7);
        expect(Array.from(response!.parameterData)).toEqual([0x42]);
    });

    it('resolves null on timeout when only non-matching replies arrive', async () => {
        const port = await startDevice(({request, rinfo}, socket) => {
            socket.send(ackFor(request, Buffer.from([1]), {sourceUid: deviceB}), rinfo.port, rinfo.address);
        });
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 150, localPort: 0});
        expect(await client.rdmTransaction(1, getDeviceInfo(deviceA))).toBeNull();
    });

    it('auto-increments transaction numbers per client and wraps at 255', async () => {
        const seen: number[] = [];
        const port = await startDevice(({request, rinfo}, socket) => {
            seen.push(request.transactionNumber);
            socket.send(ackFor(request, Buffer.alloc(0)), rinfo.port, rinfo.address);
        });
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 500, localPort: 0});
        for (let i = 0; i < 3; i++) {
            await client.rdmTransaction(1, getDeviceInfo(deviceA));
        }
        expect(seen).toEqual([0, 1, 2]);

        const other = new ArtNetRdmClient({host: '127.0.0.1', localPort: 0});
        const numbers = Array.from({length: 258}, () => other.nextTransactionNumber());
        other.close();
        expect(numbers[0]).toBe(0);
        expect(numbers[255]).toBe(255);
        expect(numbers[256]).toBe(0);
        expect(numbers[257]).toBe(1);
    });

    it('does not wait for a reply to broadcast requests', async () => {
        const port = await startDevice(() => undefined);
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 5000, localPort: 0});
        const started = Date.now();
        const response = await client.rdmTransaction(1, {
            destinationUid: {manufacturerId: 0xffff, deviceId: 0xffffffff},
            sourceUid: controllerUid,
            portId: 1,
            commandClass: RdmCommandClass.SET_COMMAND,
            pid: PIDS.IDENTIFY_DEVICE,
            parameterData: Buffer.from([1]),
        });
        expect(response).toBeNull();
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('resolves pending transactions with null on close()', async () => {
        const port = await startDevice(() => undefined);
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 5000, localPort: 0});
        const pending = client.rdmTransaction(1, getDeviceInfo(deviceA));
        await new Promise((resolve) => setTimeout(resolve, 50));
        client.close();
        await expect(pending).resolves.toBeNull();
        client = undefined;
    });

    it('getTod() keeps only ToD data for the requested universe and de-duplicates UIDs', async () => {
        device = createSocket('udp4');
        await new Promise<void>((resolve) => device!.bind(0, '127.0.0.1', resolve));
        device.on('message', (msg, rinfo) => {
            if (msg.readUInt16LE(8) !== OpCode.OpTodRequest) return;
            device!.send(buildArtTodData({universe: 1, uids: [deviceA]}), rinfo.port, rinfo.address);
            device!.send(buildArtTodData({universe: 1, uids: [deviceA, deviceB]}), rinfo.port, rinfo.address);
            device!.send(buildArtTodData({universe: 257, uids: [{manufacturerId: 1, deviceId: 1}]}), rinfo.port, rinfo.address);
            device!.send(Buffer.concat([Buffer.from(ARTNET_ID, 'ascii'), Buffer.from([0x00, 0x81, 0x00])]), rinfo.port, rinfo.address);
        });
        const port = (device.address() as {port: number}).port;
        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 200, localPort: 0});
        expect(await client.getTod(1)).toEqual([deviceA, deviceB]);
    });

    it('falls back to an ephemeral port and reports the error when the local port is taken', async () => {
        const blocker = createSocket({type: 'udp4', reuseAddr: false});
        await new Promise<void>((resolve) => blocker.bind(0, resolve));
        const takenPort = (blocker.address() as {port: number}).port;
        const errors: Error[] = [];
        try {
            const port = await startDevice(({request, rinfo}, socket) => {
                socket.send(ackFor(request, Buffer.from([9])), rinfo.port, rinfo.address);
            });
            client = new ArtNetRdmClient({
                host: '127.0.0.1',
                port,
                timeoutMs: 500,
                localPort: takenPort,
                reuseAddr: false,
                onError: (err) => errors.push(err),
            });
            const response = await client.rdmTransaction(1, getDeviceInfo(deviceA));
            expect(Array.from(response!.parameterData)).toEqual([9]);
            expect(errors.length).toBeGreaterThan(0);
            expect((errors[0] as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
        } finally {
            blocker.close();
        }
    });
});
