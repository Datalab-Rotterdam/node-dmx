import {LlrpTarget, RdmResponder} from '../src';

/**
 * Simulates an LLRP Target: answers Probe Requests (discoverable via
 * `LlrpManager.discoverTargets()`) and RDM commands sent directly over
 * LLRP — `RdmResponder.respond()` handles the raw frame in, raw frame out.
 *
 * Run: npm run example/rdmnet-llrp-fixture-simulator
 * Then, in another terminal: npm run example/rdmnet-llrp-discover
 */
const uid = {manufacturerId: 0x7a70, deviceId: 0x000000aa};
const responder = new RdmResponder({
    uid,
    manufacturerLabel: 'node-dmx',
    deviceModelDescription: 'Simulated LLRP Fixture',
    dmxStartAddress: 1,
});

const target = new LlrpTarget({
    uid,
    hardwareAddress: Buffer.from([0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e]),
    onRdmCommand: (rdmFrame) => responder.respond(rdmFrame),
});

async function main(): Promise<void> {
    await target.start();
    console.log(`LLRP Target running: uid=${uid.manufacturerId.toString(16)}:${uid.deviceId.toString(16)}`);
    console.log('Press Ctrl+C to exit.');
}

void main();

function shutdown(): void {
    target.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
