import {describe, expect, it, vi} from 'vitest';

import {
    decodeDiscoveryResponse,
    decodeRdmResponse,
    encodeDiscoveryResponse,
    encodeRdmRequest,
    PIDS,
    RdmCommandClass,
    RdmNackReason,
    RdmResponder,
    RdmResponseType,
    UID_MAX,
} from '../src';
import type {RdmRequest} from '../src/protocols/artnet/rdm/types';

const controllerUid = {manufacturerId: 0x7a70, deviceId: 0x00000001};
const deviceUid = {manufacturerId: 0x1234, deviceId: 0x00000042};

function request(overrides: Partial<RdmRequest>): RdmRequest {
    return {
        destinationUid: deviceUid,
        sourceUid: controllerUid,
        transactionNumber: 1,
        portId: 1,
        subDevice: 0,
        commandClass: RdmCommandClass.GET_COMMAND,
        pid: PIDS.DEVICE_INFO,
        parameterData: Buffer.alloc(0),
        ...overrides,
    };
}

describe('RdmResponder', () => {
    it('answers GET DEVICE_INFO with a well-formed 19-byte payload', () => {
        const responder = new RdmResponder({uid: deviceUid, dmxStartAddress: 5, personalities: [{footprint: 4}]});
        const response = responder.handle(request({pid: PIDS.DEVICE_INFO}));

        expect(response).not.toBeNull();
        expect(response!.responseType).toBe(RdmResponseType.ACK);
        expect(response!.sourceUid).toEqual(deviceUid);
        expect(response!.destinationUid).toEqual(controllerUid);
        const data = response!.parameterData;
        expect(data.readUInt16BE(10)).toBe(4); // footprint
        expect(data.readUInt8(12)).toBe(1); // current personality
        expect(data.readUInt8(13)).toBe(1); // personality count
        expect(data.readUInt16BE(14)).toBe(5); // dmx start address
    });

    it('GET/SET DMX_START_ADDRESS round-trips and calls the change hook', () => {
        const onChange = vi.fn();
        const responder = new RdmResponder({uid: deviceUid, onDmxStartAddressChange: onChange});

        const setData = Buffer.alloc(2);
        setData.writeUInt16BE(200, 0);
        const setResponse = responder.handle(request({commandClass: RdmCommandClass.SET_COMMAND, pid: PIDS.DMX_START_ADDRESS, parameterData: setData}));
        expect(setResponse!.responseType).toBe(RdmResponseType.ACK);
        expect(onChange).toHaveBeenCalledWith(200);
        expect(responder.dmxStartAddress).toBe(200);

        const getResponse = responder.handle(request({pid: PIDS.DMX_START_ADDRESS}));
        expect(getResponse!.parameterData.readUInt16BE(0)).toBe(200);
    });

    it('NACKs an out-of-range DMX_START_ADDRESS instead of applying it', () => {
        const responder = new RdmResponder({uid: deviceUid, dmxStartAddress: 1});
        const badData = Buffer.alloc(2);
        badData.writeUInt16BE(600, 0);
        const response = responder.handle(request({commandClass: RdmCommandClass.SET_COMMAND, pid: PIDS.DMX_START_ADDRESS, parameterData: badData}));

        expect(response!.responseType).toBe(RdmResponseType.NACK_REASON);
        expect(response!.parameterData.readUInt16BE(0)).toBe(RdmNackReason.DATA_OUT_OF_RANGE);
        expect(responder.dmxStartAddress).toBe(1);
    });

    it('SET IDENTIFY_DEVICE toggles state and calls the hook', () => {
        const onIdentify = vi.fn();
        const responder = new RdmResponder({uid: deviceUid, onIdentifyChange: onIdentify});
        const response = responder.handle(request({commandClass: RdmCommandClass.SET_COMMAND, pid: PIDS.IDENTIFY_DEVICE, parameterData: Buffer.from([1])}));

        expect(response!.responseType).toBe(RdmResponseType.ACK);
        expect(responder.identify).toBe(true);
        expect(onIdentify).toHaveBeenCalledWith(true);
    });

    it('NACKs unknown PIDs unless onUnhandledCommand answers them', () => {
        const responder = new RdmResponder({uid: deviceUid});
        const unknown = responder.handle(request({pid: 0x9999}));
        expect(unknown!.responseType).toBe(RdmResponseType.NACK_REASON);
        expect(unknown!.parameterData.readUInt16BE(0)).toBe(RdmNackReason.UNKNOWN_PID);

        const withHook = new RdmResponder({
            uid: deviceUid,
            onUnhandledCommand: (req) => (req.pid === 0x9999 ? Buffer.from([0x2a]) : undefined),
        });
        const handled = withHook.handle(request({pid: 0x9999}));
        expect(handled!.responseType).toBe(RdmResponseType.ACK);
        expect(handled!.parameterData).toEqual(Buffer.from([0x2a]));
    });

    it('never replies to broadcast requests but still applies their effect', () => {
        const responder = new RdmResponder({uid: deviceUid});
        const setData = Buffer.from([1]);
        const response = responder.handle(request({
            destinationUid: UID_MAX,
            commandClass: RdmCommandClass.SET_COMMAND,
            pid: PIDS.IDENTIFY_DEVICE,
            parameterData: setData,
        }));

        expect(response).toBeNull();
        expect(responder.identify).toBe(true);
    });

    it('ignores requests not addressed to it', () => {
        const responder = new RdmResponder({uid: deviceUid});
        const other = {manufacturerId: 0x9999, deviceId: 0x1};
        expect(responder.handle(request({destinationUid: other}))).toBeNull();
    });

    it('mutes/unmutes via DISC_MUTE/DISC_UN_MUTE', () => {
        const responder = new RdmResponder({uid: deviceUid});
        expect(responder.muted).toBe(false);

        const mute = responder.handle(request({commandClass: RdmCommandClass.DISCOVERY_COMMAND, pid: PIDS.DISC_MUTE}));
        expect(mute!.commandClass).toBe(RdmCommandClass.DISCOVERY_COMMAND_RESPONSE);
        expect(responder.muted).toBe(true);

        const unmute = responder.handle(request({commandClass: RdmCommandClass.DISCOVERY_COMMAND, pid: PIDS.DISC_UN_MUTE}));
        expect(unmute!.commandClass).toBe(RdmCommandClass.DISCOVERY_COMMAND_RESPONSE);
        expect(responder.muted).toBe(false);
    });

    it('respond() answers DISC_UNIQUE_BRANCH with a discovery-response frame when unmuted and in range', () => {
        const responder = new RdmResponder({uid: deviceUid});
        const dubFrame = encodeRdmRequest({
            destinationUid: UID_MAX,
            sourceUid: controllerUid,
            transactionNumber: 1,
            portId: 1,
            commandClass: RdmCommandClass.DISCOVERY_COMMAND,
            pid: PIDS.DISC_UNIQUE_BRANCH,
            parameterData: Buffer.concat([
                Buffer.from([0, 0, 0, 0, 0, 0]),
                Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            ]),
        });

        const reply = responder.respond(dubFrame);
        expect(reply).not.toBeNull();
        expect(decodeDiscoveryResponse(reply!)).toEqual(deviceUid);
        expect(reply).toEqual(encodeDiscoveryResponse(deviceUid));
    });

    it('respond() stays silent for DISC_UNIQUE_BRANCH while muted', () => {
        const responder = new RdmResponder({uid: deviceUid});
        responder.handle(request({commandClass: RdmCommandClass.DISCOVERY_COMMAND, pid: PIDS.DISC_MUTE}));

        const dubFrame = encodeRdmRequest({
            destinationUid: UID_MAX,
            sourceUid: controllerUid,
            transactionNumber: 1,
            portId: 1,
            commandClass: RdmCommandClass.DISCOVERY_COMMAND,
            pid: PIDS.DISC_UNIQUE_BRANCH,
            parameterData: Buffer.concat([
                Buffer.from([0, 0, 0, 0, 0, 0]),
                Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            ]),
        });
        expect(responder.respond(dubFrame)).toBeNull();
    });

    it('respond() round-trips a full raw-frame GET request/response', () => {
        const responder = new RdmResponder({uid: deviceUid, manufacturerLabel: 'Acme'});
        const frame = encodeRdmRequest(request({pid: PIDS.MANUFACTURER_LABEL}));
        const replyFrame = responder.respond(frame);
        expect(replyFrame).not.toBeNull();
        const decoded = decodeRdmResponse(replyFrame!);
        expect(decoded.parameterData.toString('ascii')).toBe('Acme');
    });

    it('DMX_PERSONALITY / DMX_PERSONALITY_DESCRIPTION expose configured modes', () => {
        const onPersonalityChange = vi.fn();
        const responder = new RdmResponder({
            uid: deviceUid,
            personalities: [{footprint: 3, description: 'RGB'}, {footprint: 5, description: 'RGBWW'}],
            onPersonalityChange,
        });

        const getPersonality = responder.handle(request({pid: PIDS.DMX_PERSONALITY}));
        expect(Array.from(getPersonality!.parameterData)).toEqual([1, 2]);

        const setResponse = responder.handle(request({commandClass: RdmCommandClass.SET_COMMAND, pid: PIDS.DMX_PERSONALITY, parameterData: Buffer.from([2])}));
        expect(setResponse!.responseType).toBe(RdmResponseType.ACK);
        expect(responder.currentPersonality).toBe(2);
        expect(responder.dmxFootprint).toBe(5);
        expect(onPersonalityChange).toHaveBeenCalledWith(2, 5);

        const description = responder.handle(request({pid: PIDS.DMX_PERSONALITY_DESCRIPTION, parameterData: Buffer.from([2])}));
        expect(description!.parameterData.readUInt8(0)).toBe(2);
        expect(description!.parameterData.readUInt16BE(1)).toBe(5);
        expect(description!.parameterData.toString('ascii', 3)).toBe('RGBWW');
    });
});
