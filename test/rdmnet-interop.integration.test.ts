import {describe, expect, it} from 'vitest';

import {BrokerSessionState, RdmnetClient} from '../src';

const interopHost = process.env.RDMNET_INTEROP_HOST;
const hasInteropEnv = Boolean(interopHost);
const interopIt = hasInteropEnv ? it : it.skip;

describe('RDMnet interop (real broker/device)', () => {
    interopIt('connects and completes broker session handshake', async () => {
        const useTls = process.env.RDMNET_INTEROP_TLS === '1' || process.env.RDMNET_INTEROP_TLS === 'true';
        const port = Number(process.env.RDMNET_INTEROP_PORT ?? (useTls ? 5569 : 5568));
        const scope = process.env.RDMNET_INTEROP_SCOPE ?? 'default';
        const timeoutMs = Number(process.env.RDMNET_INTEROP_TIMEOUT_MS ?? 5000);

        const client = new RdmnetClient({
            host: interopHost!,
            port,
            transport: useTls ? 'tls' : 'tcp',
            requireTlsAuthorization: process.env.RDMNET_INTEROP_TLS_STRICT !== '0',
            uid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
        });

        try {
            await client.connect();
            await client.startBrokerSession({scope, timeoutMs});

            expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Connected);
            expect(client.getBrokerUid()).not.toBeNull();

            if (process.env.RDMNET_INTEROP_CHECK_LISTS === '1') {
                const clients = await client.requestClientList(timeoutMs);
                expect(Array.isArray(clients)).toBe(true);
            }
        } finally {
            client.disconnect();
        }
    }, 30000);
});
