import {describe, expect, it} from 'vitest';

import {decodeRdmResponse, encodeRdmRequest} from '../src/protocols/artnet/rdm/codec';
import {PIDS, RdmCommandClass} from '../src/protocols/artnet/rdm/constants';
import {
    decodeDiscoveryResponse,
    discoverDevices,
    discoveryHelpers,
    encodeDiscoveryResponse,
} from '../src/protocols/artnet/rdm/discovery';
import {RdmResponder} from '../src/protocols/artnet/rdm/responder';
import type {DiscoveryUniqueBranchResult, RdmTransport} from '../src/protocols/artnet/rdm/transport';
import type {RdmRequest, RdmResponse} from '../src/protocols/artnet/rdm/types';
import {type UID, uidCompare, uidFromBuffer, uidInRange} from '../src/protocols/artnet/rdm/uid';

const controllerUid = {manufacturerId: 0x7a70, deviceId: 0x00000001};

type SimDevice = {
    uid: UID;
    muted: boolean;
    /** Answers DISC_MUTE with an ACK (default true). */
    acksMute?: boolean;
    /** Actually stops answering DISC_UNIQUE_BRANCH once muted (default true). */
    honorsMute?: boolean;
    /** Number of 0xFE preamble bytes sent (0-7, default 7). */
    preamble?: number;
};

/**
 * Simulated RDM line. `collision` decides what the controller sees when
 * several devices answer one DISC_UNIQUE_BRANCH:
 * - 'garble': one corrupted frame (wired-AND overlay of all answers);
 * - 'frames': every answer as a separate frame;
 * - 'dominant': only the lowest UID's answer is received intact.
 */
class SimBus implements RdmTransport {
    public dubCount = 0;
    public readonly devices: SimDevice[];

    constructor(devices: SimDevice[], private readonly collision: 'garble' | 'frames' | 'dominant' = 'garble') {
        this.devices = devices;
    }

    async sendDiscoveryUniqueBranch(lower: UID, upper: UID): Promise<DiscoveryUniqueBranchResult> {
        this.dubCount++;
        if (this.dubCount > 100_000) throw new Error('discovery does not terminate');
        const answering = this.devices
            .filter((d) => !(d.muted && (d.honorsMute ?? true)) && uidInRange(d.uid, lower, upper))
            .sort((a, b) => uidCompare(a.uid, b.uid));
        const frames = answering.map((d) => encodeDiscoveryResponse(d.uid).subarray(7 - (d.preamble ?? 7)));
        if (frames.length <= 1 || this.collision === 'frames') return {responses: frames};
        if (this.collision === 'dominant') return {responses: [frames[0]!]};
        const full = answering.map((d) => encodeDiscoveryResponse(d.uid));
        const overlay = Buffer.from(full[0]!);
        for (const frame of full.slice(1)) {
            for (let i = 0; i < overlay.length; i++) overlay[i] = overlay[i]! & frame[i]!;
        }
        if (decodeDiscoveryResponse(overlay) !== null) overlay[overlay.length - 1] = 0; // force a bad frame
        return {responses: [overlay]};
    }

    async sendMute(uid: UID): Promise<boolean> {
        const device = this.devices.find((d) => uidCompare(d.uid, uid) === 0);
        if (!device || device.acksMute === false) return false;
        device.muted = true;
        return true;
    }

    async sendUnMute(uid: UID): Promise<boolean> {
        const device = this.devices.find((d) => uidCompare(d.uid, uid) === 0);
        if (!device) return false;
        device.muted = false;
        return true;
    }

    async send(): Promise<RdmResponse | null> {
        return null;
    }
}

function makeDevices(uids: UID[]): SimDevice[] {
    return uids.map((uid) => ({uid, muted: false}));
}

const manyUids: UID[] = [
    {manufacturerId: 0x0000, deviceId: 0x00000000},
    {manufacturerId: 0x0000, deviceId: 0x00000001},
    {manufacturerId: 0x7a70, deviceId: 0x00000001},
    {manufacturerId: 0x7a70, deviceId: 0x00000002},
    {manufacturerId: 0x7a70, deviceId: 0x00000003},
    {manufacturerId: 0x7a70, deviceId: 0x80000000},
    {manufacturerId: 0x7a71, deviceId: 0x00000000},
    {manufacturerId: 0x4a4c, deviceId: 0x12345678},
    {manufacturerId: 0x4a4c, deviceId: 0x12345679},
    {manufacturerId: 0xffff, deviceId: 0xfffffffe},
    {manufacturerId: 0x8000, deviceId: 0x00000000},
    {manufacturerId: 0x7fff, deviceId: 0xffffffff},
];

function sortUids(uids: UID[]): UID[] {
    return [...uids].sort(uidCompare);
}

describe('decodeDiscoveryResponse', () => {
    const uid = {manufacturerId: 0x7a70, deviceId: 0x01020304};

    it('accepts 0-7 preamble bytes before the 0xAA separator', () => {
        const full = encodeDiscoveryResponse(uid);
        for (let preamble = 0; preamble <= 7; preamble++) {
            expect(decodeDiscoveryResponse(full.subarray(7 - preamble))).toEqual(uid);
        }
    });

    it('rejects more than 7 preamble bytes, missing separator, truncation and bad checksum', () => {
        const full = encodeDiscoveryResponse(uid);
        expect(decodeDiscoveryResponse(Buffer.concat([Buffer.from([0xfe]), full]))).toBeNull();
        expect(decodeDiscoveryResponse(full.subarray(8))).toBeNull();
        expect(decodeDiscoveryResponse(full.subarray(0, full.length - 1))).toBeNull();
        expect(decodeDiscoveryResponse(Buffer.alloc(0))).toBeNull();
        const corrupt = Buffer.from(full);
        corrupt[9] = corrupt[9]! ^ 0x01;
        expect(decodeDiscoveryResponse(corrupt)).toBeNull();
    });

    it('rejects encoded bytes missing the mandatory 0xAA/0x55 bits', () => {
        const full = Buffer.from(encodeDiscoveryResponse(uid));
        full[8] = full[8]! & 0x0f;
        expect(decodeDiscoveryResponse(full)).toBeNull();
    });
});

describe('discoverDevices (simulated multi-device bus)', () => {
    it.each(['garble', 'frames', 'dominant'] as const)('finds and mutes every device with %s collisions', async (mode) => {
        const bus = new SimBus(makeDevices(manyUids), mode);
        const results = await discoverDevices(bus, {sourceUid: controllerUid});
        expect(sortUids(results.map((r) => r.uid))).toEqual(sortUids(manyUids));
        expect(results.every((r) => r.muted)).toBe(true);
        expect(bus.devices.every((d) => d.muted)).toBe(true);
    });

    it('re-probes a branch after muting so a second device in it is found', async () => {
        // Only the dominant answer is received, so the first DUB of the full
        // range decodes cleanly although two devices are present.
        const uids = [
            {manufacturerId: 0x7a70, deviceId: 0x10},
            {manufacturerId: 0x7a70, deviceId: 0x11},
        ];
        const bus = new SimBus(makeDevices(uids), 'dominant');
        const results = await discoverDevices(bus, {sourceUid: controllerUid});
        expect(sortUids(results.map((r) => r.uid))).toEqual(uids);
    });

    it('splits a branch whose responses collide instead of dropping it', async () => {
        const uids = [
            {manufacturerId: 0x1234, deviceId: 0x1},
            {manufacturerId: 0x1234, deviceId: 0x2},
        ];
        const bus = new SimBus(makeDevices(uids), 'garble');
        const results = await discoverDevices(bus, {sourceUid: controllerUid});
        expect(sortUids(results.map((r) => r.uid))).toEqual(uids);
    });

    it('handles short preambles', async () => {
        const devices = makeDevices(manyUids.slice(0, 8)).map((d, i) => ({...d, preamble: i}));
        const results = await discoverDevices(new SimBus(devices, 'garble'), {sourceUid: controllerUid});
        expect(results).toHaveLength(8);
    });

    it('finds every device without muting (muteFound: false)', async () => {
        const bus = new SimBus(makeDevices(manyUids), 'garble');
        const results = await discoverDevices(bus, {sourceUid: controllerUid, muteFound: false});
        expect(sortUids(results.map((r) => r.uid))).toEqual(sortUids(manyUids));
        expect(results.every((r) => !r.muted)).toBe(true);
    });

    it('terminates and finds the others when a device cannot be muted or ignores its mute', async () => {
        const devices: SimDevice[] = makeDevices(manyUids);
        devices[2] = {...devices[2]!, acksMute: false};
        devices[5] = {...devices[5]!, honorsMute: false};
        const bus = new SimBus(devices, 'garble');
        const results = await discoverDevices(bus, {sourceUid: controllerUid});
        expect(sortUids(results.map((r) => r.uid))).toEqual(sortUids(manyUids));
        expect(results.find((r) => uidCompare(r.uid, manyUids[2]!) === 0)!.muted).toBe(false);
    });

    it('unmutes found devices at the end when requested', async () => {
        const bus = new SimBus(makeDevices(manyUids.slice(0, 4)), 'garble');
        const results = await discoverDevices(bus, {sourceUid: controllerUid, unmuteAtEnd: true});
        expect(results).toHaveLength(4);
        expect(bus.devices.every((d) => !d.muted)).toBe(true);
    });

    it('works through transport.send() with real RdmResponder devices (no sendMute helper)', async () => {
        const responders = manyUids.slice(0, 6).map((uid) => new RdmResponder({uid}));
        const transactionNumbers: number[] = [];
        let counter = 100;
        const transport: RdmTransport = {
            nextTransactionNumber: () => counter++,
            async sendDiscoveryUniqueBranch(lower, upper) {
                const frame = discoveryHelpers.buildDiscoveryUniqueBranch(lower, upper, controllerUid, 0);
                const replies = responders.map((r) => r.respond(frame)).filter((r): r is Buffer => r !== null);
                if (replies.length <= 1) return {responses: replies};
                const overlay = Buffer.from(replies[0]!);
                for (const reply of replies.slice(1)) {
                    for (let i = 0; i < overlay.length; i++) overlay[i] = overlay[i]! & reply[i]!;
                }
                overlay[overlay.length - 1] = 0;
                return {responses: [overlay]};
            },
            async send(request: RdmRequest) {
                transactionNumbers.push(request.transactionNumber);
                const frame = encodeRdmRequest(request);
                for (const responder of responders) {
                    const reply = responder.respond(frame);
                    if (reply) return decodeRdmResponse(reply);
                }
                return null;
            },
        };

        const results = await discoverDevices(transport, {sourceUid: controllerUid, unmuteAtEnd: true});
        expect(sortUids(results.map((r) => r.uid))).toEqual(sortUids(manyUids.slice(0, 6)));
        expect(results.every((r) => r.muted)).toBe(true);
        // 6 mutes + 6 unmutes, numbered by the transport's own counter.
        expect(transactionNumbers).toEqual(Array.from({length: 12}, (_, i) => 100 + i));
        // Unmuted again: a full-range DUB collides once more.
        const frame = discoveryHelpers.buildDiscoveryUniqueBranch(
            {manufacturerId: 0, deviceId: 0},
            {manufacturerId: 0xffff, deviceId: 0xffffffff},
            controllerUid,
            0,
        );
        expect(responders.filter((r) => r.respond(frame) !== null)).toHaveLength(6);
    });

    it('builds DISC_UNIQUE_BRANCH and DISC_MUTE request frames', () => {
        const lower = {manufacturerId: 0x0001, deviceId: 0x2};
        const upper = {manufacturerId: 0x0003, deviceId: 0x4};
        const dub = decodeRdmResponse(discoveryHelpers.buildDiscoveryUniqueBranch(lower, upper, controllerUid, 9));
        expect(dub.commandClass).toBe(RdmCommandClass.DISCOVERY_COMMAND);
        expect(dub.pid).toBe(PIDS.DISC_UNIQUE_BRANCH);
        expect(dub.transactionNumber).toBe(9);
        expect(uidFromBuffer(dub.parameterData, 0)).toEqual(lower);
        expect(uidFromBuffer(dub.parameterData, 6)).toEqual(upper);

        const unmute = decodeRdmResponse(discoveryHelpers.buildMute(lower, controllerUid, 1, true));
        expect(unmute.pid).toBe(PIDS.DISC_UN_MUTE);
        expect(unmute.destinationUid).toEqual(lower);
    });
});
