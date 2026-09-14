import {createSocket} from 'dgram';
import {afterEach, describe, expect, it} from 'vitest';

import {ArtNetRdmClient} from '../src/protocols/artnet/rdm/artnet-client';
import {ArtNetRdmResponder} from '../src/protocols/artnet/rdm/artnet-responder';
import {PIDS, RdmCommandClass} from '../src/protocols/artnet/rdm/constants';
import {RdmResponder} from '../src/protocols/artnet/rdm/responder';
import {buildArtPoll, parseArtPollReply} from '../src/protocols/artnet/packet';

const deviceUid = {manufacturerId: 0x7a70, deviceId: 0x00000042};
const controllerUid = {manufacturerId: 0x7a70, deviceId: 0x00000001};

describe('ArtNetRdmResponder (loopback UDP, real ArtNetRdmClient controller)', () => {
    let responder: ArtNetRdmResponder | undefined;
    let client: ArtNetRdmClient | undefined;

    afterEach(() => {
        responder?.close();
        client?.close();
        responder = undefined;
        client = undefined;
    });

    it('answers getTod() with its own UID', async () => {
        const rdm = new RdmResponder({uid: deviceUid});
        responder = new ArtNetRdmResponder({responder: rdm, universe: 1, port: 0, bindAddress: '127.0.0.1'});
        await new Promise((resolve) => setTimeout(resolve, 20));
        const port = (responder as unknown as {socket: {address(): {port: number}}}).socket.address().port;

        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 300});
        const uids = await client.getTod(1);

        expect(uids).toEqual([deviceUid]);
    });

    it('answers rdmTransaction() GET DEVICE_INFO with a real ACK built by RdmResponder', async () => {
        const rdm = new RdmResponder({uid: deviceUid, dmxStartAddress: 12, personalities: [{footprint: 8}]});
        responder = new ArtNetRdmResponder({responder: rdm, universe: 1, port: 0, bindAddress: '127.0.0.1'});
        await new Promise((resolve) => setTimeout(resolve, 20));
        const port = (responder as unknown as {socket: {address(): {port: number}}}).socket.address().port;

        client = new ArtNetRdmClient({host: '127.0.0.1', port, timeoutMs: 300});
        const response = await client.rdmTransaction(1, {
            destinationUid: deviceUid,
            sourceUid: controllerUid,
            transactionNumber: 1,
            portId: 1,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: PIDS.DEVICE_INFO,
        });

        expect(response).not.toBeNull();
        expect(response!.parameterData.readUInt16BE(10)).toBe(8); // dmx footprint
        expect(response!.parameterData.readUInt16BE(14)).toBe(12); // dmx start address
    });

    it('answers a unicast ArtPoll with a well-formed ArtPollReply', async () => {
        // ArtNetDiscovery only ever broadcasts to 255.255.255.255, which
        // this sandboxed test environment can't route (EADDRNOTAVAIL) — so
        // this poll is sent by hand, unicast, to exercise the same
        // responder logic without depending on real network broadcast.
        const rdm = new RdmResponder({uid: deviceUid});
        responder = new ArtNetRdmResponder({
            responder: rdm,
            universe: 1,
            port: 0,
            bindAddress: '127.0.0.1',
            shortName: 'sim-fixture',
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const port = (responder as unknown as {socket: {address(): {port: number}}}).socket.address().port;

        const poller = createSocket('udp4');
        const reply = await new Promise<Buffer>((resolve) => {
            poller.on('message', resolve);
            poller.send(buildArtPoll(), port, '127.0.0.1');
        });
        poller.close();

        const parsed = parseArtPollReply(reply);
        expect(parsed).not.toBeNull();
        expect(parsed!.shortName).toBe('sim-fixture');
    });
});
