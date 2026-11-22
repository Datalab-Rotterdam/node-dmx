import {EventEmitter} from 'events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
    ArtNetDiscovery,
    ArtNetReceiver,
    ArtNetSender,
    DMXController,
    Merger,
    Packet,
    Receiver,
    Sender,
    buildArtDmx,
    type DmxSender,
} from '../src';

type Sent = {buffer: Buffer; port: number; host: string};

/** dgram socket double that mimics the real bind/setBroadcast ordering rules. */
class MockSocket extends EventEmitter {
    public bound = false;
    public closed = false;
    public bindArgs: unknown[] = [];
    public broadcast = false;
    public memberships = new Set<string>();
    public sent: Sent[] = [];

    public bind(...args: unknown[]): void {
        this.bindArgs = args;
        const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
        queueMicrotask(() => {
            this.bound = true;
            cb?.();
        });
    }

    public setBroadcast(flag: boolean): void {
        if (!this.bound) throw new Error('setBroadcast EBADF');
        this.broadcast = flag;
    }

    public setMulticastInterface(): void {
        if (!this.bound) throw new Error('setMulticastInterface EBADF');
    }

    public addMembership(group: string): void {
        if (!this.bound) throw new Error('addMembership EBADF');
        this.memberships.add(group);
    }

    public dropMembership(group: string): void {
        this.memberships.delete(group);
    }

    public send(buffer: Buffer, port: number, host: string, cb: (err: Error | null) => void): void {
        if (this.closed) return cb(new Error('Not running'));
        this.sent.push({buffer: Buffer.from(buffer), port, host});
        cb(null);
    }

    public close(cb?: () => void): void {
        if (this.closed) throw new Error('Not running');
        this.closed = true;
        cb?.();
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

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const sacnPacket = (opts: {universe?: number; sequence: number; cid?: number; priority?: number; data?: number[]; options?: number}) =>
    new Packet({
        universe: opts.universe ?? 1,
        sequence: opts.sequence,
        cid: Buffer.alloc(16, opts.cid ?? 1),
        priority: opts.priority,
        payload: Buffer.from(opts.data ?? [10, 20]),
        options: opts.options,
        sourceName: `src-${opts.cid ?? 1}`,
    }).buffer;

beforeEach(() => {
    sockets.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('sACN Receiver', () => {
    const setup = async (props: ConstructorParameters<typeof Receiver>[0] = {}) => {
        const receiver = new Receiver({universes: [1], ...props});
        await flushMicrotasks();
        const socket = sockets[0]!;
        const deliver = (buf: Buffer) => socket.emit('message', buf, {address: '10.0.0.5', port: 5568});
        return {receiver, socket, deliver};
    };

    it('joins multicast groups after bind, including universes added before bind completes', async () => {
        const receiver = new Receiver({universes: [1]});
        receiver.addUniverse(2);
        await flushMicrotasks();
        expect([...sockets[0]!.memberships].sort()).toEqual(['239.255.0.1', '239.255.0.2']);
        expect(receiver.universes.sort()).toEqual([1, 2]);
        receiver.close();
    });

    it('applies the E1.31 sequence rule: drops duplicates and small backward steps only', async () => {
        const {receiver, deliver} = await setup();
        const seen: number[] = [];
        const stale: string[] = [];
        receiver.on('packet', (p) => seen.push(p.sequence));
        receiver.on('PacketOutOfOrder', (e) => stale.push(e.message));

        deliver(sacnPacket({sequence: 50}));
        deliver(sacnPacket({sequence: 50})); // duplicate → drop
        deliver(sacnPacket({sequence: 45})); // -5 → drop
        deliver(sacnPacket({sequence: 30})); // -20 → accept (restart)
        deliver(sacnPacket({sequence: 31}));
        deliver(sacnPacket({sequence: 31, cid: 2})); // other source, independent

        expect(seen).toEqual([50, 30, 31, 31]);
        expect(stale).toHaveLength(2);
        receiver.close();
    });

    it('routes non-zero START codes to alternateStartCode and garbage to PacketCorruption', async () => {
        const {receiver, deliver} = await setup();
        const levels = vi.fn();
        const alternate = vi.fn();
        const corrupt = vi.fn();
        receiver.on('packet', levels);
        receiver.on('alternateStartCode', alternate);
        receiver.on('PacketCorruption', corrupt);

        const prio = sacnPacket({sequence: 1});
        prio[125] = 0xdd;
        deliver(prio);
        deliver(Buffer.alloc(30));
        deliver(Buffer.from(sacnPacket({sequence: 2}).subarray(0, 300)));

        expect(levels).not.toHaveBeenCalled();
        expect(alternate).toHaveBeenCalledTimes(1);
        expect(corrupt).toHaveBeenCalledTimes(2);
        receiver.close();
    });

    it('emits sourceLost once on Stream_Terminated and again on timeout for silent sources', async () => {
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'Date']});
        const {receiver, deliver} = await setup({sourceTimeoutMs: 2500});
        const lost: Array<{reason: string; cidHex: string}> = [];
        receiver.on('sourceLost', (s) => lost.push({reason: s.reason, cidHex: s.cidHex}));

        deliver(sacnPacket({sequence: 1, cid: 1}));
        deliver(sacnPacket({sequence: 1, cid: 2}));
        for (let i = 2; i < 5; i++) deliver(sacnPacket({sequence: i, cid: 1, options: 0x40}));
        expect(lost).toEqual([{reason: 'terminated', cidHex: '01'.repeat(16)}]);

        vi.advanceTimersByTime(3000);
        expect(lost).toEqual([
            {reason: 'terminated', cidHex: '01'.repeat(16)},
            {reason: 'timeout', cidHex: '02'.repeat(16)},
        ]);
        receiver.close();
    });

    it('can ignore preview data', async () => {
        const {receiver, deliver} = await setup({ignorePreviewData: true});
        const levels = vi.fn();
        receiver.on('packet', levels);
        deliver(sacnPacket({sequence: 1, options: 0x80}));
        expect(levels).not.toHaveBeenCalled();
        receiver.close();
    });

    it('does not crash on socket errors without an error listener', async () => {
        const {receiver, socket} = await setup();
        expect(() => socket.emit('error', new Error('boom'))).not.toThrow();
        receiver.close();
        expect(() => receiver.close()).not.toThrow();
    });
});

describe('sACN Merger', () => {
    it('lets the highest priority win and HTP-merges equal priorities', () => {
        const merger = new Merger();
        const p = (cid: number, priority: number, data: number[]) =>
            new Packet(sacnPacket({sequence: 1, cid, priority, data}));

        merger.update(p(1, 100, [10, 200]));
        let out = merger.update(p(2, 100, [50, 20]));
        expect(Array.from(out.data.subarray(0, 2))).toEqual([50, 200]);
        expect(out.sources).toHaveLength(2);

        out = merger.update(p(3, 150, [1, 1]));
        expect(Array.from(out.data.subarray(0, 2))).toEqual([1, 1]);
        expect(out.priority).toBe(150);

        out = merger.remove(1, '03'.repeat(16))!;
        expect(Array.from(out.data.subarray(0, 2))).toEqual([50, 200]);
    });

    it('follows a receiver and drops lost sources', async () => {
        const receiver = new Receiver({universes: [1]});
        await flushMicrotasks();
        const merger = new Merger(receiver);
        const merged = vi.fn();
        merger.on('merged', merged);

        sockets[0]!.emit('message', sacnPacket({sequence: 1, data: [99]}), {address: '1.2.3.4'});
        expect(merger.get(1)?.data[0]).toBe(99);
        sockets[0]!.emit('message', sacnPacket({sequence: 2, options: 0x40}), {address: '1.2.3.4'});
        expect(merger.get(1)?.data[0]).toBe(0);
        expect(merged).toHaveBeenCalledTimes(2);
        merger.dispose();
        receiver.close();
    });
});

describe('sACN Sender', () => {
    it('binds an ephemeral port, sends to the multicast group and terminates on close', async () => {
        const sender = new Sender({universe: 3});
        await sender.sendRaw(Buffer.from([1, 2, 3]));
        const socket = sockets[0]!;
        expect(socket.bindArgs[0]).toBe(0);
        expect(socket.sent[0]).toMatchObject({port: 5568, host: '239.255.0.3'});

        await sender.closeAsync();
        const terminated = socket.sent.slice(1).map((s) => new Packet(s.buffer));
        expect(terminated).toHaveLength(3);
        expect(terminated.every((p) => p.isTerminated)).toBe(true);
        expect(terminated.map((p) => p.sequence)).toEqual([1, 2, 3]);
        expect(socket.closed).toBe(true);

        await expect(sender.sendRaw(Buffer.from([1]))).rejects.toThrow(/closed/);
        expect(() => sender.close()).not.toThrow();
    });

    it('sends sync packets unicast when a unicast destination is configured', async () => {
        const sender = new Sender({universe: 3, useUnicastDestination: '10.0.0.9'});
        await sender.sendSync(7);
        expect(sockets[0]!.sent[0]!.host).toBe('10.0.0.9');
        await sender.closeAsync();
    });

    it('lets two senders coexist and survives socket errors without listeners', async () => {
        const a = new Sender({universe: 1});
        const b = new Sender({universe: 2});
        await Promise.all([a.sendRaw(Buffer.from([1])), b.sendRaw(Buffer.from([2]))]);
        expect(() => sockets[0]!.emit('error', new Error('boom'))).not.toThrow();
        await Promise.all([a.closeAsync(), b.closeAsync()]);
    });
});

describe('ArtNetSender', () => {
    it('enables broadcast only after bind instead of throwing EBADF', async () => {
        const sender = new ArtNetSender({universe: 1, broadcast: true});
        await sender.sendRaw(Buffer.from([1, 2, 3]));
        const socket = sockets[0]!;
        expect(socket.broadcast).toBe(true);
        expect(socket.sent[0]).toMatchObject({port: 6454, host: '255.255.255.255'});
        expect(socket.sent[0]!.buffer.readUInt16BE(16)).toBe(4);
        sender.close();
        sender.close();
        await expect(sender.sendSync()).rejects.toThrow(/closed/);
    });

    it('supports raw Port-Address 0', async () => {
        const sender = new ArtNetSender({portAddress: 0, host: '10.0.0.2'});
        await sender.sendRaw(new Uint8Array(512));
        const sent = sockets[0]!.sent[0]!;
        expect(sent.host).toBe('10.0.0.2');
        expect(sent.buffer.readUInt8(14)).toBe(0);
        expect(sent.buffer.readUInt8(15)).toBe(0);
        sender.close();
    });

    it('requires an address', () => {
        expect(() => new ArtNetSender({})).toThrow(RangeError);
    });
});

describe('ArtNetReceiver robustness', () => {
    it('reports malformed ArtDMX as invalidPacket, never as error', () => {
        const receiver = new ArtNetReceiver();
        const invalid = vi.fn();
        receiver.on('invalidPacket', invalid);
        const bad = buildArtDmx({universe: 1, sequence: 1, data: new Uint8Array(4)});
        bad.writeUInt16BE(600, 16);
        expect(() => sockets[0]!.emit('message', bad, {address: '1.1.1.1', port: 6454})).not.toThrow();
        expect(invalid).toHaveBeenCalledTimes(1);
        expect(() => sockets[0]!.emit('error', new Error('boom'))).not.toThrow();
        receiver.close();
    });
});

describe('ArtNetDiscovery', () => {
    it('listens on port 6454 (where nodes send ArtPollReply) with reuseAddr', async () => {
        const discovery = new ArtNetDiscovery({broadcastAddress: '2.255.255.255'});
        await discovery.sendPoll();
        const socket = sockets[0]!;
        expect(socket.bindArgs[0]).toMatchObject({port: 6454});
        expect(socket.broadcast).toBe(true);
        expect(socket.sent[0]!.host).toBe('2.255.255.255');
        expect(() => socket.emit('message', Buffer.from('Art-Net\0garbage'))).not.toThrow();
        discovery.close();
        discovery.close();
    });
});

describe('DMXController', () => {
    const mockSender = (): DmxSender & {sendRaw: ReturnType<typeof vi.fn>; sendSync: ReturnType<typeof vi.fn>} => ({
        sendRaw: vi.fn().mockResolvedValue(undefined),
        sendSync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
    });

    it('resends unchanged universes as keep-alive', async () => {
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'Date']});
        const sender = mockSender();
        const controller = new DMXController({keepAliveMs: 1000, senderFactory: () => sender});
        controller.setChannel(1, 1, 255);
        await controller.flush();
        expect(sender.sendRaw).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1100);
        expect(sender.sendRaw).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sender.sendRaw).toHaveBeenCalledTimes(3);

        controller.close();
        await vi.advanceTimersByTimeAsync(5000);
        expect(sender.sendRaw).toHaveBeenCalledTimes(3);
    });

    it('does not keep alive when disabled or before the first flush', async () => {
        vi.useFakeTimers({toFake: ['setInterval', 'clearInterval', 'Date']});
        const sender = mockSender();
        const controller = new DMXController({keepAliveMs: 0, senderFactory: () => sender});
        controller.setChannel(1, 1, 255);
        await vi.advanceTimersByTimeAsync(5000);
        expect(sender.sendRaw).not.toHaveBeenCalled();
        controller.close();
    });

    it('re-marks a universe dirty when the send fails', async () => {
        const sender = mockSender();
        sender.sendRaw.mockRejectedValueOnce(new Error('net down'));
        const controller = new DMXController({keepAliveMs: 0, senderFactory: () => sender});
        const u = controller.setChannel(1, 1, 1);
        await expect(controller.flush()).rejects.toThrow('net down');
        expect(u.isDirty()).toBe(true);
        controller.close();
    });

    it('sends an E1.31 sync packet to the sync universe after flush', async () => {
        const sender = mockSender();
        const controller = new DMXController({keepAliveMs: 0, sacnSyncUniverse: 9, senderFactory: () => sender});
        controller.setChannel(1, 1, 1);
        await controller.flush();
        expect(sender.sendRaw.mock.calls[0]![1]).toMatchObject({syncUniverse: 9});
        expect(sender.sendSync).toHaveBeenCalledWith(9);
        controller.close();
    });

    it('accepts Art-Net Port-Address 0 when artnetPortAddressing is enabled', () => {
        const controller = new DMXController({protocol: 'artnet', artnetPortAddressing: true, keepAliveMs: 0, senderFactory: () => mockSender()});
        expect(controller.universe(0).id).toBe(0);
        expect(() => controller.universe(32768)).toThrow(RangeError);
        controller.close();
    });

    it('creates a working Art-Net controller with default broadcast', async () => {
        const controller = new DMXController({protocol: 'artnet', keepAliveMs: 0});
        controller.setChannel(1, 1, 255);
        await controller.flush();
        expect(sockets[0]!.broadcast).toBe(true);
        expect(sockets[0]!.sent).toHaveLength(1);
        controller.close();
    });
});
