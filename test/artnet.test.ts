import {describe, expect, it} from 'vitest';

import {ARTNET_ID, ARTNET_PROTOCOL_VERSION, DiagnosticsPriority, OpCode} from '../src';
import {
    buildArtCommand,
    buildArtDiagData,
    buildArtDmx,
    buildArtPoll,
    buildArtSync,
    buildArtTimeCode,
    buildArtTrigger,
    parseArtDmx,
    parseArtPollReply,
} from '../src';
import {readNullTerminatedString, splitUniverseAddress} from '../src';

describe('Art-Net util', () => {
    it('splits 1-based universe address into net/subnet/universe', () => {
        expect(splitUniverseAddress(1)).toEqual({net: 0, subNet: 0, universe: 0, subUni: 0});
        expect(splitUniverseAddress(257)).toEqual({net: 1, subNet: 0, universe: 0, subUni: 0});
        expect(() => splitUniverseAddress(0)).toThrow(RangeError);
    });

    it('reads null-terminated strings', () => {
        const a = Buffer.from('hello\0ignored', 'ascii');
        const b = Buffer.from('abc   ', 'ascii');
        expect(readNullTerminatedString(a, 0, 10)).toBe('hello');
        expect(readNullTerminatedString(b, 0, 6)).toBe('abc');
    });
});

describe('Art-Net packet builders', () => {
    it('builds ArtPoll with talk-to-me flags and priority', () => {
        const packet = buildArtPoll({
            sendDiagnostics: true,
            diagnosticsUnicast: true,
            sendInputOnChange: true,
            priority: DiagnosticsPriority.High,
        });

        expect(packet.length).toBe(14);
        expect(packet.toString('ascii', 0, 8)).toBe(ARTNET_ID);
        expect(packet.readUInt16LE(8)).toBe(OpCode.OpPoll);
        expect(packet.readUInt16BE(10)).toBe(ARTNET_PROTOCOL_VERSION);
        expect(packet[12]).toBe(0x02 | 0x04 | 0x10);
        expect(packet[13]).toBe(DiagnosticsPriority.High);
    });

    it('builds ArtDMX and applies payload length cap', () => {
        const packet = buildArtDmx({
            universe: 257,
            sequence: 3,
            data: Uint8Array.from([1, 2, 3, 4]),
            length: 2,
        });

        expect(packet.readUInt16LE(8)).toBe(OpCode.OpDmx);
        expect(packet[12]).toBe(3);
        expect(packet[14]).toBe(0);
        expect(packet[15]).toBe(1);
        expect(packet.readUInt16BE(16)).toBe(2);
        expect(Array.from(packet.subarray(18))).toEqual([1, 2]);
    });

    it('builds ArtSync', () => {
        const packet = buildArtSync();
        expect(packet.readUInt16LE(8)).toBe(OpCode.OpSync);
        expect(packet.length).toBe(14);
    });

    it('builds ArtDiagData with null-terminated message', () => {
        const packet = buildArtDiagData({
            priority: DiagnosticsPriority.Med,
            message: 'diag',
        });

        expect(packet.readUInt16LE(8)).toBe(OpCode.OpDiagData);
        expect(packet[13]).toBe(DiagnosticsPriority.Med);
        expect(packet.readUInt16BE(14)).toBe(5);
        expect(packet.toString('ascii', 16, 20)).toBe('diag');
        expect(packet[20]).toBe(0);
    });

    it('builds ArtTimeCode, ArtCommand and ArtTrigger', () => {
        const timeCode = buildArtTimeCode({frames: 1, seconds: 2, minutes: 3, hours: 4, type: 5});
        expect(timeCode.readUInt16LE(8)).toBe(OpCode.OpTimeCode);
        expect(Array.from(timeCode.subarray(13, 18))).toEqual([1, 2, 3, 4, 5]);

        const cmd = buildArtCommand('reboot');
        expect(cmd.readUInt16LE(8)).toBe(OpCode.OpCommand);
        expect(cmd.toString('ascii', 14, 20)).toBe('reboot');
        expect(cmd[20]).toBe(0);

        const trigger = buildArtTrigger({key: 9, subKey: 2, payload: Uint8Array.from([7, 8])});
        expect(trigger.readUInt16LE(8)).toBe(OpCode.OpTrigger);
        expect(trigger[13]).toBe(9);
        expect(trigger[14]).toBe(2);
        expect(trigger.readUInt16BE(16)).toBe(2);
        expect(Array.from(trigger.subarray(18))).toEqual([7, 8]);
    });
});

describe('parseArtPollReply', () => {
    it('returns null for non-reply packets', () => {
        expect(parseArtPollReply(Buffer.alloc(10))).toBeNull();

        const badId = Buffer.alloc(239);
        badId.write('not-art', 0, 'ascii');
        expect(parseArtPollReply(badId)).toBeNull();

        const badOpcode = Buffer.alloc(239);
        badOpcode.write(ARTNET_ID, 0, 'ascii');
        badOpcode.writeUInt16LE(OpCode.OpPoll, 8);
        expect(parseArtPollReply(badOpcode)).toBeNull();
    });

    it('parses a valid ArtPollReply payload', () => {
        const reply = Buffer.alloc(239);
        reply.write(ARTNET_ID, 0, 'ascii');
        reply.writeUInt16LE(OpCode.OpPollReply, 8);
        reply[10] = 192;
        reply[11] = 168;
        reply[12] = 1;
        reply[13] = 99;
        reply.writeUInt16BE(0x1936, 14);
        reply[18] = 2;
        reply[19] = 3;
        reply[23] = 4;
        reply.write('Short', 26, 'ascii');
        reply.write('Long Node Name', 44, 'ascii');
        reply.write('Node report text', 108, 'ascii');
        reply.writeUInt16BE(2, 172);
        reply[186] = 1;
        reply[187] = 2;
        reply[190] = 10;
        reply[191] = 11;
        reply[201] = 6;
        reply[211] = 7;

        expect(parseArtPollReply(reply)).toEqual({
            ip: '192.168.1.99',
            port: 0x1936,
            shortName: 'Short',
            longName: 'Long Node Name',
            nodeReport: 'Node report text',
            numPorts: 2,
            swIn: [1, 2, 0, 0],
            swOut: [10, 11, 0, 0],
            netSwitch: 2,
            subSwitch: 3,
            status1: 4,
            status2: 6,
            status3: 7,
        });
    });
});

describe('parseArtDmx', () => {
    it('returns null for non-OpDmx payloads', () => {
        expect(parseArtDmx(Buffer.alloc(10))).toBeNull();
        expect(parseArtDmx(buildArtPoll())).toBeNull();
    });

    it('parses a valid OpDmx payload', () => {
        const packet = buildArtDmx({
            universe: 257,
            sequence: 11,
            physical: 2,
            data: Uint8Array.from([1, 2, 3, 4]),
        });
        const parsed = parseArtDmx(packet);

        expect(parsed).toEqual({
            protocolVersion: ARTNET_PROTOCOL_VERSION,
            sequence: 11,
            physical: 2,
            net: 1,
            subNet: 0,
            universe: 257,
            length: 4,
            data: Buffer.from([1, 2, 3, 4]),
        });
    });

    it('throws on malformed OpDmx payload length', () => {
        const packet = buildArtDmx({
            universe: 1,
            sequence: 1,
            data: Uint8Array.from([1, 2, 3, 4]),
        });
        packet.writeUInt16BE(600, 16);
        expect(() => parseArtDmx(packet)).toThrow(RangeError);
    });
});
