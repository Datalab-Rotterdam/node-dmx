import {RdmnetClient} from '../src';

async function main(): Promise<void> {
    const host = process.env.RDMNET_INTEROP_HOST;
    if (!host) {
        throw new Error('Set RDMNET_INTEROP_HOST to a real RDMnet broker hostname/IP');
    }

    const useTls = process.env.RDMNET_INTEROP_TLS === '1' || process.env.RDMNET_INTEROP_TLS === 'true';
    const port = Number(process.env.RDMNET_INTEROP_PORT ?? (useTls ? 5569 : 5568));
    const scope = process.env.RDMNET_INTEROP_SCOPE ?? 'default';
    const timeoutMs = Number(process.env.RDMNET_INTEROP_TIMEOUT_MS ?? 5000);

    const client = new RdmnetClient({
        host,
        port,
        transport: useTls ? 'tls' : 'tcp',
        requireTlsAuthorization: process.env.RDMNET_INTEROP_TLS_STRICT !== '0',
        // Real ESTA manufacturer ID + a device id unique to this process.
        uid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
    });

    client.on('error', (err) => {
        console.error('[rdmnet:error]', err);
    });

    try {
        await client.connect();
        console.log(`transport connected to ${host}:${port} (${useTls ? 'tls' : 'tcp'})`);

        await client.startBrokerSession({scope, timeoutMs});
        console.log('broker session connected', {
            brokerUid: client.getBrokerUid(),
            ownUid: client.getUid(),
        });

        if (process.env.RDMNET_INTEROP_CHECK_LISTS === '1') {
            const clients = await client.requestClientList(timeoutMs);
            console.log('broker client list', clients);
        }
    } finally {
        client.disconnect();
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
