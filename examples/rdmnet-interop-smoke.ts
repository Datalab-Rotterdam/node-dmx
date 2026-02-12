import {BrokerClientRole, RdmnetClient} from '../src';

async function main(): Promise<void> {
    const host = process.env.RDMNET_INTEROP_HOST;
    if (!host) {
        throw new Error('Set RDMNET_INTEROP_HOST to a real RDMnet broker hostname/IP');
    }

    const useTls = process.env.RDMNET_INTEROP_TLS === '1' || process.env.RDMNET_INTEROP_TLS === 'true';
    const port = Number(process.env.RDMNET_INTEROP_PORT ?? (useTls ? 5569 : 5568));
    const scope = process.env.RDMNET_INTEROP_SCOPE ?? 'default';
    const endpointId = Number(process.env.RDMNET_INTEROP_ENDPOINT_ID ?? 1);
    const timeoutMs = Number(process.env.RDMNET_INTEROP_TIMEOUT_MS ?? 5000);

    const client = new RdmnetClient({
        host,
        port,
        transport: useTls ? 'tls' : 'tcp',
        requireTlsAuthorization: process.env.RDMNET_INTEROP_TLS_STRICT !== '0',
    });

    client.on('error', (err) => {
        console.error('[rdmnet:error]', err);
    });

    try {
        await client.connect();
        console.log(`transport connected to ${host}:${port} (${useTls ? 'tls' : 'tcp'})`);

        await client.startBrokerSession({
            scope,
            endpointId,
            endpointRole: BrokerClientRole.Controller,
            autoBind: true,
            strictNegotiation: false,
            timeoutMs,
        });
        console.log('broker session bound', {
            clientId: client.getBrokerClientId(),
            negotiatedRole: client.getBrokerNegotiatedRole(),
            negotiatedProfile: client.getBrokerNegotiatedProfile(),
        });

        const [clients, endpoints] = await Promise.all([
            client.requestBrokerClientList(timeoutMs),
            client.requestBrokerEndpointList(timeoutMs),
        ]);
        console.log('broker lists', {clients, endpoints});
    } finally {
        client.disconnect();
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
