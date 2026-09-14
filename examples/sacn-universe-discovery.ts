import {Receiver, Sender, UniverseDiscoverySource} from '../src';

/**
 * Demonstrates E1.31 Universe Discovery (§8): a source periodically
 * advertises which universes it's currently transmitting, and a
 * controller listens for those adverts instead of guessing which
 * multicast groups to join.
 *
 * Run: DMX_IFACE=192.168.1.50 npm run example/sacn-universe-discovery
 */
const iface = process.env.DMX_IFACE;

// --- Source side: send DMX on universes 1 and 2, advertise both. ---
const sender1 = new Sender({universe: 1, iface});
const sender2 = new Sender({universe: 2, iface});
void sender1.sendRaw(new Uint8Array(512).fill(255));
void sender2.sendRaw(new Uint8Array(512).fill(128));

const discoverySource = new UniverseDiscoverySource({sourceName: 'node-dmx example', iface});
discoverySource.setUniverses([1, 2]);
discoverySource.start(); // sends immediately, then every 10s (E1.31 §8.6)

// --- Controller side: listen for discovery adverts and print active sources. ---
const receiver = new Receiver({universes: [], iface, discovery: true, reuseAddr: true});
receiver.on('universeDiscovery', (packet) => {
    console.log(
        `source "${packet.sourceName}" (cid=${packet.cid.toString('hex')}) ` +
            `page ${packet.page}/${packet.lastPage} advertises universes: ${packet.universes.join(', ')}`,
    );
});
receiver.on('error', (err) => console.error('[Receiver]', err.message));

console.log('Listening for Universe Discovery packets. Press Ctrl+C to exit.');

function shutdown(): void {
    discoverySource.close();
    sender1.close();
    sender2.close();
    receiver.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
