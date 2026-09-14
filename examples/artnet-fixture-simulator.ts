import {ArtNetRdmResponder, RdmResponder} from '../src';

/**
 * Simulates a real Art-Net fixture: receives DMX for universe 1, answers
 * ArtPoll (discoverable via `ArtNetDiscovery`), and answers RDM commands
 * (discoverable/queryable via `ArtNetRdmClient`) — DMX_START_ADDRESS,
 * IDENTIFY_DEVICE, DEVICE_LABEL, etc. are all handled for you.
 *
 * Run: npm run example/artnet-fixture-simulator
 * Then, in another terminal:
 *   npm run example/artnet-discover
 *   npm run example/rdm-tod
 */
const uid = {manufacturerId: 0x7a70, deviceId: 0x00000042};

const responder = new RdmResponder({
    uid,
    manufacturerLabel: 'node-dmx',
    deviceModelDescription: 'Simulated RGB Fixture',
    deviceLabel: 'Sim Fixture 1',
    dmxStartAddress: 1,
    personalities: [
        {footprint: 3, description: 'RGB'},
        {footprint: 4, description: 'RGB + Dimmer'},
    ],
    onIdentifyChange: (identify) => console.log(`[identify] ${identify ? 'ON' : 'off'}`),
    onDmxStartAddressChange: (address) => console.log(`[dmx-start-address] -> ${address}`),
    onDeviceLabelChange: (label) => console.log(`[device-label] -> "${label}"`),
});

const fixture = new ArtNetRdmResponder({
    responder,
    universe: 1,
    shortName: 'node-dmx-sim',
    longName: 'node-dmx simulated Art-Net fixture',
});

fixture.on('dmx', (frame) => {
    const [r, g, b] = frame;
    console.log(`[dmx] r=${r} g=${g} b=${b}`);
});
fixture.on('error', (err) => console.error('[error]', err.message));

console.log(`Simulated fixture running: uid=${uid.manufacturerId.toString(16)}:${uid.deviceId.toString(16)}, universe=1`);
console.log('Press Ctrl+C to exit.');

function shutdown(): void {
    fixture.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
