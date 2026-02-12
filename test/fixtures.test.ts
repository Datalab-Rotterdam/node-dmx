import {describe, expect, it, vi} from 'vitest';

import {DMXController} from '../src';
import {Fixture} from '../src';
import {InMemoryFixtureRegistry} from '../src';
import type {FixtureModelPlugin} from '../src';
import {RGBDimmerFixture} from '../src';
import {RGBWW5Fixture} from '../src';

const stubSender = {
    sendRaw: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
};

describe('Fixture', () => {
    it('validates start address', () => {
        const dmx = new DMXController({senderFactory: () => stubSender});
        const plugin: FixtureModelPlugin = {
            vendor: 'v',
            model: 'm',
            personalities: [{id: 'p', name: 'P', channels: 1}],
            defaultPersonalityId: 'p',
            match: () => true,
            encode: () => undefined,
        };

        expect(() => new Fixture(dmx, plugin, 1, 0, 'p')).toThrow(RangeError);
        expect(() => new Fixture(dmx, plugin, 1, 513, 'p')).toThrow(RangeError);
    });

    it('merges state and renders via plugin encode', () => {
        const dmx = new DMXController({senderFactory: () => stubSender});
        const encode = vi.fn(({state, ctx}: Parameters<FixtureModelPlugin['encode']>[0]) => {
            ctx.frame[ctx.base] = (state.level as number) ?? 0;
        });
        const plugin: FixtureModelPlugin = {
            vendor: 'v',
            model: 'm',
            personalities: [{id: 'p', name: 'P', channels: 1}],
            defaultPersonalityId: 'p',
            match: () => true,
            encode,
        };

        const fx = new Fixture(dmx, plugin, 1, 10, 'p');
        fx.set({level: 123});
        fx.set({color: 'red'});
        fx.render(1000);

        const universe = dmx.universe(1);
        expect(encode).toHaveBeenCalledTimes(1);
        expect(encode).toHaveBeenCalledWith(
            expect.objectContaining({
                personalityId: 'p',
                state: {level: 123, color: 'red'},
                ctx: expect.objectContaining({base: 9, frame: universe.data, nowMs: 1000}),
            }),
        );
        expect(universe.data[9]).toBe(123);
        expect(universe.isDirty()).toBe(true);
    });
});

describe('InMemoryFixtureRegistry', () => {
    it('stores, resolves and returns copy of plugins', () => {
        const registry = new InMemoryFixtureRegistry();
        const a: FixtureModelPlugin = {
            vendor: 'A',
            model: 'ModelA',
            personalities: [{id: 'p', name: 'P', channels: 1}],
            defaultPersonalityId: 'p',
            match: (id) => id.manufacturerId === 1,
            encode: () => undefined,
        };
        const b: FixtureModelPlugin = {
            vendor: 'B',
            model: 'ModelB',
            personalities: [{id: 'p', name: 'P', channels: 1}],
            defaultPersonalityId: 'p',
            match: (id) => id.modelId === 2,
            encode: () => undefined,
        };

        registry.add(a);
        registry.add(b);

        expect(registry.find({manufacturerId: 1})).toBe(a);
        expect(registry.find({manufacturerId: 0, modelId: 2})).toBe(b);

        const all = registry.all();
        expect(all).toEqual([a, b]);
        all.pop();
        expect(registry.all()).toHaveLength(2);
    });
});

describe('RGBDimmerFixture', () => {
    it('matches expected fixture identity', () => {
        expect(RGBDimmerFixture.match({manufacturerId: 0x1234, modelId: 0x0001})).toBe(true);
        expect(RGBDimmerFixture.match({manufacturerId: 0x9999, modelId: 0x0001})).toBe(false);
    });

    it('encodes dimmer and rgb channels into frame', () => {
        const frame = new Uint8Array(20);

        RGBDimmerFixture.encode({
            personalityId: '4ch',
            state: {dimmer: 1, rgb: [0.5, 0.25, 0]},
            ctx: {base: 4, frame},
        });

        expect(frame[4]).toBe(255);
        expect(frame[5]).toBe(127);
        expect(frame[6]).toBe(63);
        expect(frame[7]).toBe(0);
    });

    it('ignores unknown personality id', () => {
        const frame = new Uint8Array([1, 2, 3, 4]);

        RGBDimmerFixture.encode({
            personalityId: 'unknown',
            state: {dimmer: 1, rgb: [1, 1, 1]},
            ctx: {base: 0, frame},
        });

        expect(Array.from(frame)).toEqual([1, 2, 3, 4]);
    });
});

describe('RGBWW5Fixture', () => {
    it('matches expected fixture identity', () => {
        expect(RGBWW5Fixture.match({manufacturerId: 0x1234, modelId: 0x0002})).toBe(true);
        expect(RGBWW5Fixture.match({manufacturerId: 0x9999, modelId: 0x0002})).toBe(false);
    });

    it('encodes rgbww channels into frame', () => {
        const frame = new Uint8Array(20);

        RGBWW5Fixture.encode({
            personalityId: '5ch',
            state: {rgbww: [1, 0.5, 0.25, 0.75, 0], dimmer: 1},
            ctx: {base: 3, frame},
        });

        expect(frame[3]).toBe(255);
        expect(frame[4]).toBe(127);
        expect(frame[5]).toBe(63);
        expect(frame[6]).toBe(191);
        expect(frame[7]).toBe(0);
    });

    it('supports rgb + warm/cool white fallback state fields', () => {
        const frame = new Uint8Array(10);

        RGBWW5Fixture.encode({
            personalityId: '5ch',
            state: {rgb: [0.2, 0.4, 0.6], warmWhite: 1, coolWhite: 0.5, dimmer: 0.5},
            ctx: {base: 0, frame},
        });

        expect(frame[0]).toBe(25);
        expect(frame[1]).toBe(51);
        expect(frame[2]).toBe(76);
        expect(frame[3]).toBe(127);
        expect(frame[4]).toBe(63);
    });

    it('ignores unknown personality id', () => {
        const frame = new Uint8Array([9, 8, 7, 6, 5]);

        RGBWW5Fixture.encode({
            personalityId: 'unknown',
            state: {rgbww: [1, 1, 1, 1, 1]},
            ctx: {base: 0, frame},
        });

        expect(Array.from(frame)).toEqual([9, 8, 7, 6, 5]);
    });
});
