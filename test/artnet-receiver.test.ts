import {EventEmitter} from 'events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ArtNetReceiver, buildArtDmx} from '../src';

class MockSocket extends EventEmitter {
    public bindConfig: unknown = null;

    public bind(config: unknown): void {
        this.bindConfig = config;
    }

    public close(callback?: () => void): void {
        callback?.();
    }
}

const sockets: MockSocket[] = [];

vi.mock('dgram', () => ({
    createSocket: vi.fn(() => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
    }),
}));

beforeEach(() => {
    sockets.length = 0;
});

afterEach(() => {
    for (const socket of sockets) {
        socket.removeAllListeners();
    }
});

describe('ArtNetReceiver', () => {
    it('receives and parses ArtDMX packets', async () => {
        const receiver = new ArtNetReceiver({port: 6454, iface: '127.0.0.1', universes: [10]});
        const socket = sockets[0];
        expect(socket).toBeDefined();

        const received = new Promise<{universe: number; sequence: number; data: number[]}>((resolve) => {
            receiver.once('dmx', (packet) => {
                resolve({
                    universe: packet.universe,
                    sequence: packet.sequence,
                    data: Array.from(packet.data),
                });
            });
        });
        socket.emit('message', buildArtDmx({
            universe: 10,
            sequence: 77,
            data: Uint8Array.from([9, 8, 7, 6]),
        }), {address: '127.0.0.1', port: 42000});

        await expect(received).resolves.toEqual({
            universe: 10,
            sequence: 77,
            data: [9, 8, 7, 6],
        });
        receiver.close();
    });

    it('filters out universes not in receiver subscription list', async () => {
        const receiver = new ArtNetReceiver({port: 6454, iface: '127.0.0.1', universes: [2]});
        const socket = sockets[0];
        expect(socket).toBeDefined();

        let hit = false;
        receiver.on('dmx', () => {
            hit = true;
        });
        socket.emit('message', buildArtDmx({
            universe: 3,
            sequence: 1,
            data: Uint8Array.from([1, 2]),
        }), {address: '127.0.0.1', port: 42000});

        expect(hit).toBe(false);
        receiver.close();
    });
});
