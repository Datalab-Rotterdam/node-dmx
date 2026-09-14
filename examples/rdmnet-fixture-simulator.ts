import {RdmResponder, RdmnetClient, RptClientType} from '../src';

/**
 * Simulates an RDMnet device: connects to a real broker as an RPT Device
 * and answers every inbound RDM command automatically via `RdmResponder` —
 * `useRdmResponder` handles the RPT header swap and Notification framing
 * for you.
 *
 * Run: RDMNET_HOST=192.168.1.50 npm run example/rdmnet-fixture-simulator
 */
async function main(): Promise<void> {
    const host = process.env.RDMNET_HOST;
    if (!host) {
        throw new Error('Set RDMNET_HOST to a real RDMnet broker hostname/IP');
    }

    const uid = {manufacturerId: 0x7a70, deviceId: 0x00000099};
    const responder = new RdmResponder({
        uid,
        manufacturerLabel: 'node-dmx',
        deviceModelDescription: 'Simulated RDMnet Fixture',
        deviceLabel: 'Sim RDMnet Fixture',
        dmxStartAddress: 1,
        onIdentifyChange: (identify) => console.log(`[identify] ${identify ? 'ON' : 'off'}`),
        onDmxStartAddressChange: (address) => console.log(`[dmx-start-address] -> ${address}`),
    });

    const client = new RdmnetClient({
        host,
        port: Number(process.env.RDMNET_PORT ?? 5568),
        uid,
        clientType: RptClientType.Device,
    });
    client.on('error', (err) => console.error('[rdmnet:error]', err.message));

    await client.connect();
    await client.startBrokerSession({scope: process.env.RDMNET_SCOPE ?? 'default'});
    console.log('broker session connected, answering RDM commands as a Device');

    client.useRdmResponder(responder);

    function shutdown(): void {
        client.disconnect();
        process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
