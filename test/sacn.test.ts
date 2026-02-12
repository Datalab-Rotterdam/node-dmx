import {describe, expect, it} from 'vitest';

import {Packet} from '../src';
import {bit, dp, empty, inRange, multicastGroup, objectify} from '../src/protocols/sacn/util';

describe('sACN util', () => {
    it('builds multicast groups for valid universes', () => {
        expect(multicastGroup(1)).toBe('239.255.0.1');
        expect(multicastGroup(256)).toBe('239.255.1.0');
        expect(multicastGroup(64214)).toBe('239.255.250.214');
    });

    it('throws for invalid universe', () => {
        expect(() => multicastGroup(0)).toThrow(RangeError);
        expect(() => multicastGroup(64000)).toThrow(RangeError);
        expect(() => multicastGroup(1.1)).toThrow(TypeError);
    });

    it('rounds decimals and guards non-finite', () => {
        expect(dp(1.239, 2)).toBe(1.24);
        expect(dp(Infinity)).toBe(0);
    });

    it('objectifies DMX buffer into sparse payload', () => {
        const payload = objectify(Buffer.from([255, 128, 0]));
        expect(payload).toEqual({1: 100, 2: 50.2});
    });

    it('clamps to byte range', () => {
        expect(inRange(-10)).toBe(0);
        expect(inRange(999)).toBe(255);
        expect(inRange(12.6)).toBe(13);
        expect(inRange(NaN)).toBe(0);
    });

    it('converts numbers to big-endian byte arrays', () => {
        expect(bit(16, 0x1234)).toEqual([0x12, 0x34]);
        expect(bit(24, 0x010203)).toEqual([0x01, 0x02, 0x03]);
        expect(() => bit(16, -1)).toThrow(RangeError);
    });

    it('creates zero-filled arrays', () => {
        expect(empty(3)).toEqual([0, 0, 0]);
        expect(() => empty(-1)).toThrow(RangeError);
    });
});

describe('sACN Packet', () => {
    it('encodes payload object into packet buffer', () => {
        const packet = new Packet({
            universe: 1,
            payload: {1: 100, 2: 50},
            sequence: 7,
            sourceName: 'node-dmx-test',
            priority: 120,
        });

        const buffer = packet.buffer;

        expect(buffer.length).toBe(638);
        expect(buffer.readUInt16BE(113)).toBe(1);
        expect(buffer.readUInt8(111)).toBe(7);
        expect(buffer.readUInt8(108)).toBe(120);
        expect(buffer[126]).toBe(255);
        expect(buffer[127]).toBe(127);
    });

    it('supports raw DMX values in object payload mode', () => {
        const packet = new Packet({
            universe: 1,
            payload: {1: 200, 2: 999},
            sequence: 1,
            useRawDmxValues: true,
        });

        const buffer = packet.buffer;
        expect(buffer[126]).toBe(200);
        expect(buffer[127]).toBe(255);
    });

    it('parses packet buffer and keeps payload copy isolated', () => {
        const outbound = new Packet({
            universe: 2,
            payload: Buffer.from([10, 20, 0]),
            sequence: 55,
            sourceName: 'source-name',
        });

        const raw = outbound.buffer;
        const parsed = new Packet(raw, '127.0.0.1');

        expect(parsed.universe).toBe(2);
        expect(parsed.sequence).toBe(55);
        expect(parsed.sourceName).toBe('source-name');
        expect(parsed.payloadAsBuffer).not.toBeNull();
        expect(parsed.payload).toEqual({1: 3.92, 2: 7.84});

        raw[126] = 99;
        expect(parsed.payloadAsBuffer?.[0]).toBe(10);
    });

    it('truncates source name to 64 bytes', () => {
        const longName = 'x'.repeat(90);
        const packet = new Packet({
            universe: 1,
            payload: {1: 1},
            sequence: 1,
            sourceName: longName,
        });
        const parsed = new Packet(packet.buffer);

        expect(parsed.sourceName.length).toBe(64);
        expect(parsed.sourceName).toBe('x'.repeat(64));
    });

    it('rejects invalid constructor inputs', () => {
        expect(() => new Packet(Buffer.alloc(100))).toThrow(RangeError);
        expect(() => new Packet(undefined as never)).toThrow('Packet instantiated with no input');
    });
});
