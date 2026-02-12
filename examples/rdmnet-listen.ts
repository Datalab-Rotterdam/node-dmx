import {BrokerSessionState, RdmnetClient, RptVector} from '../src';

type CliOptions = {
    host: string;
    port?: number;
    vector?: number;
};

function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {host: '127.0.0.1'};
    for (const arg of argv) {
        if (arg.startsWith('--host=')) {
            options.host = arg.substring('--host='.length);
        } else if (arg.startsWith('--port=')) {
            const port = Number(arg.substring('--port='.length));
            if (Number.isInteger(port) && port > 0 && port <= 65535) options.port = port;
        } else if (arg.startsWith('--vector=')) {
            const value = Number(arg.substring('--vector='.length));
            if (Number.isInteger(value) && value >= 0) options.vector = value >>> 0;
        }
    }
    return options;
}

const options = parseArgs(process.argv.slice(2));

const client = new RdmnetClient({
    host: options.host,
    port: options.port,
});

client.on('connect', () => {
    console.log(`Connected to RDMnet broker ${options.host}:${options.port ?? 8888}`);
});

client.on('message', (packet) => {
    console.log(
        `RDMnet packet vector=0x${packet.vector.toString(16)} cid=${packet.cid.toString('hex')} dataLen=${packet.data.length}`,
    );
});

client.on('rptMessage', (message) => {
    if (message.vector === RptVector.Status) {
        console.log(`RPT status seq=${message.sequence} code=${message.statusCode} text="${message.text ?? ''}"`);
    } else if (message.vector === RptVector.RdmCommand) {
        console.log(`RPT RDM command seq=${message.sequence} pid=0x${message.request.pid.toString(16)}`);
    } else if (message.vector === RptVector.RdmResponse) {
        console.log(`RPT RDM response seq=${message.sequence} pid=0x${message.response.pid.toString(16)}`);
    }
});

client.on('disconnect', (hadError) => {
    console.log(`Disconnected (hadError=${hadError})`);
});

client.on('brokerState', (state) => {
    console.log(`Broker session state: ${state}`);
});

client.on('error', (error) => {
    console.error('[RDMnetError]', error.message);
});

async function main(): Promise<void> {
    await client.connect();
    await client.startBrokerSession({scope: 'default', autoBind: false}).catch((err) => {
        console.error('[BrokerSessionError]', err.message);
    });

    if (options.vector !== undefined) {
        await client.sendPacket({
            vector: options.vector,
            data: Buffer.alloc(0),
        });
        console.log(`Sent vector 0x${options.vector.toString(16)} message`);
    } else {
        if (client.getBrokerSessionState() === BrokerSessionState.Connected
            || client.getBrokerSessionState() === BrokerSessionState.Bound) {
            await client.sendStatus(0, 'node-dmx RDMnet online');
            console.log('Sent default RPT status message');
        } else {
            console.log('Broker session not active; skipping default status message');
        }
    }
}

void main();

function shutdown(): void {
    client.disconnect();
    setTimeout(() => process.exit(0), 30);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
