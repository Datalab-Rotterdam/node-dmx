import {describe, expect, it, vi} from 'vitest';

import {DMXController, type DmxSender} from '../src';
import {Universe} from '../src';
import {clampByte} from '../src';

type MockSender = DmxSender & {
    sendRaw: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    sendSync: ReturnType<typeof vi.fn>;
};

const createMockSender = (): MockSender => ({
    sendRaw: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    sendSync: vi.fn().mockResolvedValue(undefined),
});

describe('clampByte', () => {
    it('clamps and rounds values', () => {
        expect(clampByte(-1)).toBe(0);
        expect(clampByte(999)).toBe(255);
        expect(clampByte(12.6)).toBe(13);
        expect(clampByte(NaN)).toBe(0);
    });
});

describe('Universe', () => {
    it('validates universe id', () => {
        expect(() => new Universe(0)).toThrow(RangeError);
        expect(() => new Universe(64000)).toThrow(RangeError);
        expect(() => new Universe(1.5)).toThrow(RangeError);
    });

    it('writes channels and tracks dirty state', () => {
        const u = new Universe(1);

        expect(u.isDirty()).toBe(false);
        u.setChannel(1, 255);

        expect(u.data[0]).toBe(255);
        expect(u.isDirty()).toBe(true);
        expect(u.consumeDirty()).toBe(true);
        expect(u.consumeDirty()).toBe(false);
    });

    it('validates channel address', () => {
        const u = new Universe(1);
        expect(() => u.setChannel(0, 1)).toThrow(RangeError);
        expect(() => u.setChannel(513, 1)).toThrow(RangeError);
        expect(() => u.setChannel(1.1, 1)).toThrow(RangeError);
    });

    it('sets full frame and zero-fills remainder', () => {
        const u = new Universe(1);
        u.setFrame(Uint8Array.from([10, 20, 30]));

        expect(u.data[0]).toBe(10);
        expect(u.data[1]).toBe(20);
        expect(u.data[2]).toBe(30);
        expect(u.data[3]).toBe(0);
        expect(u.isDirty()).toBe(true);
    });

    it('fills and clears frame', () => {
        const u = new Universe(1);

        u.fill(99.9);
        expect(u.data[0]).toBe(100);
        expect(u.data[511]).toBe(100);

        u.clear();
        expect(u.data[0]).toBe(0);
        expect(u.data[511]).toBe(0);
    });
});

describe('DMXController', () => {
    it('creates one sender per universe and reuses universe instances', () => {
        const byUniverse = new Map<number, MockSender>();
        const controller = new DMXController({
            senderFactory: (universeId) => {
                const sender = createMockSender();
                byUniverse.set(universeId, sender);
                return sender;
            },
        });

        const a = controller.addUniverse(1);
        const b = controller.addUniverse(1);

        expect(a).toBe(b);
        expect(byUniverse.size).toBe(1);
    });

    it('flushes only dirty universes by default', async () => {
        const byUniverse = new Map<number, MockSender>();
        const controller = new DMXController({
            senderFactory: (id) => {
                const sender = createMockSender();
                byUniverse.set(id, sender);
                return sender;
            },
        });

        controller.setChannel(1, 1, 10);
        controller.addUniverse(2);

        await controller.flush();

        expect(byUniverse.get(1)?.sendRaw).toHaveBeenCalledTimes(1);
        expect(byUniverse.get(2)?.sendRaw).not.toHaveBeenCalled();

        await controller.flush();
        expect(byUniverse.get(1)?.sendRaw).toHaveBeenCalledTimes(1);
    });

    it('flushes specific universe id and supports force flush', async () => {
        const byUniverse = new Map<number, MockSender>();
        const controller = new DMXController({
            senderFactory: (id) => {
                const sender = createMockSender();
                byUniverse.set(id, sender);
                return sender;
            },
        });

        controller.addUniverse(1);
        controller.addUniverse(2);

        await controller.flush(1, true);
        expect(byUniverse.get(1)?.sendRaw).toHaveBeenCalledTimes(1);
        expect(byUniverse.get(2)?.sendRaw).toHaveBeenCalledTimes(0);

        await controller.flush(undefined, true);
        expect(byUniverse.get(1)?.sendRaw).toHaveBeenCalledTimes(2);
        expect(byUniverse.get(2)?.sendRaw).toHaveBeenCalledTimes(1);
    });

    it('sends ArtSync once when enabled and something flushed', async () => {
        const byUniverse = new Map<number, MockSender>();
        const controller = new DMXController({
            artSync: true,
            senderFactory: (id) => {
                const sender = createMockSender();
                byUniverse.set(id, sender);
                return sender;
            },
        });

        controller.setChannel(1, 1, 255);
        controller.setChannel(2, 1, 128);

        await controller.flush();

        expect(byUniverse.get(1)?.sendRaw).toHaveBeenCalledTimes(1);
        expect(byUniverse.get(2)?.sendRaw).toHaveBeenCalledTimes(1);
        expect(byUniverse.get(1)?.sendSync).toHaveBeenCalledTimes(1);
        expect(byUniverse.get(2)?.sendSync).toHaveBeenCalledTimes(0);
    });

    it('closes all senders and clears universes', () => {
        const byUniverse = new Map<number, MockSender>();
        const controller = new DMXController({
            senderFactory: (id) => {
                const sender = createMockSender();
                byUniverse.set(id, sender);
                return sender;
            },
        });

        controller.addUniverse(1);
        controller.addUniverse(2);
        controller.close();

        expect(byUniverse.get(1)?.close).toHaveBeenCalledTimes(1);
        expect(byUniverse.get(2)?.close).toHaveBeenCalledTimes(1);

        controller.addUniverse(1);
        expect(byUniverse.size).toBe(2);
    });
});
