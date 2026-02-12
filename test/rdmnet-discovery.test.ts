import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
    class MockMdnsSocket {
        public sent: Array<{data: Buffer; port: number; host: string}> = [];
        private handlers: Record<string, Array<(msg: Buffer) => void>> = {};

        public on(event: string, cb: (msg: Buffer) => void): void {
            if (!this.handlers[event]) this.handlers[event] = [];
            this.handlers[event]!.push(cb);
        }

        public bind(_port: number, cb?: () => void): void {
            cb?.();
        }

        public send(data: Buffer, port: number, host: string): void {
            this.sent.push({data: Buffer.from(data), port, host});
        }

        public close(): void {}

        public setMulticastInterface(_iface: string): void {}
    }

    const sockets: MockMdnsSocket[] = [];
    return {MockMdnsSocket, sockets};
});

vi.mock('dns/promises', () => ({
    resolveSrv: vi.fn(async () => [{name: 'broker.local', port: 8888, priority: 0, weight: 0}]),
    resolveTxt: vi.fn(async () => [[Buffer.from('scope=default')]]),
    resolve4: vi.fn(async () => ['10.0.0.10']),
    resolve6: vi.fn(async () => []),
}));

vi.mock('dgram', () => ({
    createSocket: vi.fn(() => {
        const socket = new mocks.MockMdnsSocket();
        mocks.sockets.push(socket);
        return socket;
    }),
}));

import {RdmnetDiscovery, __testUtils} from '../src';

beforeEach(() => {
    mocks.sockets.length = 0;
});

describe('RdmnetDiscovery', () => {
    it('discovers DNS-SD SRV/TXT/A records', async () => {
        const services = await RdmnetDiscovery.discoverDnsSd({serviceName: '_rdmnet._tcp', domain: 'local'});
        expect(services).toEqual([{
            name: '_rdmnet._tcp.local',
            host: 'broker.local',
            port: 8888,
            addresses: ['10.0.0.10'],
            txt: {scope: 'default'},
            source: 'dns-sd',
        }]);
    });

    it('builds mDNS PTR queries and parses records', () => {
        const query = __testUtils.buildPtrQuery('_rdmnet._tcp.local');
        expect(query.length).toBeGreaterThan(20);
        const parsed = __testUtils.parseDnsRecords(Buffer.alloc(12));
        expect(parsed).toEqual([]);
    });

    it('returns empty mDNS discovery list when no responses arrive', async () => {
        const services = await RdmnetDiscovery.discoverMdns({timeoutMs: 10});
        expect(services).toEqual([]);
        expect(mocks.sockets.length).toBe(1);
        expect(mocks.sockets[0]?.sent[0]?.port).toBe(5353);
    });
});
