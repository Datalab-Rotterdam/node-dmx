import {PIDS, RdmCommandClass, RdmnetClient} from '../src';

/**
 * Connects to a real RDMnet broker and sends one RDM GET DEVICE_INFO
 * command to a device UID over RPT, printing the response.
 *
 * Run: RDMNET_HOST=192.168.1.50 RDMNET_TARGET_UID=7a70:00000001 \
 *      npm run example/rdmnet-rdm-transaction
 */
async function main(): Promise<void> {
    const host = process.env.RDMNET_HOST;
    if (!host) {
        throw new Error('Set RDMNET_HOST to a real RDMnet broker hostname/IP');
    }
    const [manufacturerId, deviceId] = (process.env.RDMNET_TARGET_UID ?? '7a70:00000001')
        .split(':')
        .map((part) => parseInt(part, 16));

    const client = new RdmnetClient({
        host,
        port: Number(process.env.RDMNET_PORT ?? 5568),
        uid: {manufacturerId: 0x7a70, deviceId: 0x00000002},
    });
    client.on('error', (err) => console.error('[rdmnet:error]', err.message));

    try {
        await client.connect();
        await client.startBrokerSession({scope: process.env.RDMNET_SCOPE ?? 'default'});
        console.log('broker session connected, brokerUid=', client.getBrokerUid());

        const targetUid = {manufacturerId: manufacturerId!, deviceId: deviceId!};
        const response = await client.rdmTransaction(targetUid, {
            destinationUid: targetUid,
            sourceUid: client.getUid(),
            transactionNumber: 1,
            portId: 1,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: PIDS.DEVICE_INFO,
        });

        console.log('RDM response:', response);
    } finally {
        client.disconnect();
    }
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
