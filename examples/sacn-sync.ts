import {Sender} from '../src';

/**
 * Demonstrates E1.31 Synchronization Packets (§6): two universes are sent
 * with a shared Synchronization Address, so receivers buffer the new
 * levels without applying them until one Synchronization Packet arrives —
 * guaranteeing both universes change on the same output frame.
 *
 * DMXController doesn't expose per-send packet options (like
 * `syncUniverse`) yet, so this uses the lower-level `Sender` class
 * directly. See `Options.syncUniverse` in `protocols/sacn/packet.ts` and
 * `Sender.sendSync` in `protocols/sacn/sender.ts`.
 *
 * Run: DMX_IFACE=192.168.1.50 npm run example/sacn-sync
 */
const SYNC_ADDRESS = 63999;

const iface = process.env.DMX_IFACE;
const sender1 = new Sender({universe: 1, iface});
const sender2 = new Sender({universe: 2, iface});

const frame1 = new Uint8Array(512);
const frame2 = new Uint8Array(512);

async function main(): Promise<void> {
    let level = 0;
    let direction = 1;

    setInterval(async () => {
        level += direction * 15;
        if (level >= 255) {
            level = 255;
            direction = -1;
        } else if (level <= 0) {
            level = 0;
            direction = 1;
        }

        frame1[0] = level;
        frame2[0] = 255 - level;

        // Both frames declare the same Synchronization Address and are sent
        // to their own universes' multicast groups; receivers wait for it.
        await sender1.sendRaw(frame1, {syncUniverse: SYNC_ADDRESS});
        await sender2.sendRaw(frame2, {syncUniverse: SYNC_ADDRESS});
        // One Synchronization Packet releases both buffered frames together.
        await sender1.sendSync(SYNC_ADDRESS);

        console.log(`universe1=${level} universe2=${255 - level} (synced via address ${SYNC_ADDRESS})`);
    }, 200);
}

void main();

function shutdown(): void {
    sender1.close();
    sender2.close();
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
