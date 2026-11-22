import {createSocket} from 'dgram';
import {afterEach, describe, expect, it} from 'vitest';

import {ArtNetRdmClient} from '../src/protocols/artnet/rdm/artnet-client';
import {buildArtRdm, buildArtTodControl, parseArtTodData} from '../src/protocols/artnet/rdm/artnet-packets';
import {ArtNetRdmResponder} from '../src/protocols/artnet/rdm/artnet-responder';
import {encodeRdmRequest} from '../src/protocols/artnet/rdm/codec';
import {PIDS, RdmCommandClass} from '../src/protocols/artnet/rdm/constants';
import {RdmResponder} from '../src/protocols/artnet/rdm/responder';
import {UID_MAX, UID_MIN, uidToBuffer} from '../src/protocols/artnet/rdm/uid';

const deviceUid = {manufacturerId: 0x7a70, deviceId: 0x00000042};
const controllerUid = {manufacturerId: 0x7a70, deviceId: 0x00000001};

// Universe 257 = Port-Address 0x100: Net 1, SubUni 0 — same SubUni as universe 1.
const OUR_UNIVERSE = 257;
const OTHER_NET_SAME_SUBUNI = 1;

async function startResponder(): Promise<{responder: ArtNetRdmResponder; port: number}> {
    const responder = new ArtNetRdmResponder({
        responder: new RdmResponder({uid: deviceUid}),
        universe: OUR_UNIVERSE,
        port: 0,
        bindAddress: '127.0.0.1',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const port = (responder as unknown as {socket: {address(): {port: number}}}).socket.address().port;
    return {responder, port};
}

const getDeviceInfo = {
    destinationUid: deviceUid,
    sourceUid: controllerUid,
    portId: 1,
    commandClass: RdmCommandClass.GET_COMMAND,
    pid: PIDS.DEVICE_INFO,
};

describe('ArtNetRdmResponder Port-Address filtering', () => {
    let responder: ArtNetRdmResponder | undefined;
    let client: ArtNetRdmClient | undefined;

    afterEach(() => {
        responder?.close();
        client?.close();
        responder = undefined;
        client = undefined;
    });

    it('answers OpRdm only for its full 15-bit Port-Address (Net + SubUni)', async () => {
        const started = await startResponder();
        responder = started.responder;
        client = new ArtNetRdmClient({host: '127.0.0.1', port: started.port, timeoutMs: 150, localPort: 0});

        expect(await client.rdmTransaction(OTHER_NET_SAME_SUBUNI, getDeviceInfo)).toBeNull();
        const response = await client.rdmTransaction(OUR_UNIVERSE, getDeviceInfo);
        expect(response).not.toBeNull();
        expect(response!.sourceUid).toEqual(deviceUid);
    });

    it('answers OpTodRequest only when the Net matches', async () => {
        const started = await startResponder();
        responder = started.responder;
        client = new ArtNetRdmClient({host: '127.0.0.1', port: started.port, timeoutMs: 150, localPort: 0});

        expect(await client.getTod(OTHER_NET_SAME_SUBUNI)).toEqual([]);
        expect(await client.getTod(OUR_UNIVERSE)).toEqual([deviceUid]);
    });

    it('answers OpTodControl only for its Port-Address', async () => {
        const started = await startResponder();
        responder = started.responder;
        const socket = createSocket('udp4');
        const replies: Buffer[] = [];
        socket.on('message', (msg) => replies.push(msg));
        await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
        try {
            socket.send(buildArtTodControl({universe: OTHER_NET_SAME_SUBUNI, command: 0x01}), started.port, '127.0.0.1');
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(replies).toHaveLength(0);

            socket.send(buildArtTodControl({universe: OUR_UNIVERSE, command: 0x01}), started.port, '127.0.0.1');
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(replies).toHaveLength(1);
            const tod = parseArtTodData(replies[0]!);
            expect(tod!.universe).toBe(OUR_UNIVERSE);
            expect(tod!.uids).toEqual([deviceUid]);
        } finally {
            socket.close();
        }
    });

    it('drops malformed OpRdm and DISC_UNIQUE_BRANCH frames without crashing and keeps serving', async () => {
        const started = await startResponder();
        responder = started.responder;
        const socket = createSocket('udp4');
        const replies: Buffer[] = [];
        socket.on('message', (msg) => replies.push(msg));
        await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
        try {
            const valid = encodeRdmRequest({...getDeviceInfo, transactionNumber: 3});
            // Message Length that disagrees with PDL (24 + 0), checksum fixed up.
            const badLength = Buffer.concat([valid, Buffer.alloc(2)]);
            badLength[2] = 26;
            let sum = 0;
            for (let i = 0; i < 26; i++) sum += badLength[i]!;
            badLength.writeUInt16BE(sum & 0xffff, 26);
            socket.send(buildArtRdm({universe: OUR_UNIVERSE, rdmPacket: badLength.subarray(1)}), started.port, '127.0.0.1');
            // Truncated packet.
            socket.send(buildArtRdm({universe: OUR_UNIVERSE, rdmPacket: valid.subarray(1, 5)}), started.port, '127.0.0.1');
            // DISC_UNIQUE_BRANCH is not carried over Art-Net.
            const dub = encodeRdmRequest({
                destinationUid: UID_MAX,
                sourceUid: controllerUid,
                transactionNumber: 4,
                portId: 1,
                commandClass: RdmCommandClass.DISCOVERY_COMMAND,
                pid: PIDS.DISC_UNIQUE_BRANCH,
                parameterData: Buffer.concat([uidToBuffer(UID_MIN), uidToBuffer(UID_MAX)]),
            });
            socket.send(buildArtRdm({universe: OUR_UNIVERSE, rdmPacket: dub.subarray(1)}), started.port, '127.0.0.1');
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(replies).toHaveLength(0);

            socket.send(buildArtRdm({universe: OUR_UNIVERSE, rdmPacket: valid.subarray(1)}), started.port, '127.0.0.1');
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(replies).toHaveLength(1);
        } finally {
            socket.close();
        }
    });
});
