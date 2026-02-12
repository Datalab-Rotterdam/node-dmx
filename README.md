# node-dmx 🎛️

`node-dmx` is a TypeScript library for controlling DMX over IP from Node.js.

It supports:
- sACN (E1.31)
- Art-Net 4
- RDM over Art-Net
- A fixture plugin system

This guide is written for students and first-time users: start simple, then move to advanced features.

## Requirements
- Node.js 18+
- A DMX-over-IP device (sACN or Art-Net)
- Computer and lighting device on the same network

## Install
```bash
npm install node-dmx
```

## DMX Basics (Quick)
- A **universe** has 512 channels.
- A **channel value** is 0-255.
- You set values in memory, then call `flush()` to send them.

## 1. Quick Start (sACN)
```ts
import {DMXController} from 'node-dmx';

const controller = new DMXController({protocol: 'sacn'});
const universe = controller.addUniverse(1);

universe.setChannel(1, 255); // channel 1 at full

await controller.flush();
controller.close();
```

## 2. Quick Start (Art-Net)
```ts
import {DMXController} from 'node-dmx';

const controller = new DMXController({
  protocol: 'artnet',
  artSync: true,
  artnet: {
    host: '255.255.255.255',
    broadcast: true,
  },
});

controller.setChannel(1, 1, 255); // universe 1, channel 1, full
await controller.flush();
controller.close();
```

## 3. Working With Multiple Universes
```ts
import {DMXController} from 'node-dmx';

const controller = new DMXController({protocol: 'sacn'});
const u1 = controller.addUniverse(1);
const u2 = controller.addUniverse(2);

u1.setChannel(1, 255);
u2.setChannel(1, 128);

await controller.flush(); // sends all dirty universes
```

## 4. Device Discovery (Art-Net)
```ts
import {ArtNetDiscovery} from 'node-dmx';

const discovery = new ArtNetDiscovery();
const replies = await discovery.pollOnce();

for (const node of replies) {
  console.log(node.ip, node.shortName, node.longName);
}

discovery.close();
```

## 5. RDM Over Art-Net
```ts
import {ArtNetRdmClient, RdmCommandClass, PIDS} from 'node-dmx';

const client = new ArtNetRdmClient({host: '192.168.0.10'});

const response = await client.rdmTransaction(1, {
  destinationUid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
  sourceUid: {manufacturerId: 0x7a70, deviceId: 0x00000002},
  transactionNumber: 1,
  portId: 1,
  subDevice: 0,
  commandClass: RdmCommandClass.GET_COMMAND,
  pid: PIDS.DEVICE_INFO,
});

console.log(response);
client.close();
```

## 6. Fixtures (Higher-Level API)
```ts
import {DMXController, Fixture, RGBDimmerFixture} from 'node-dmx';

const controller = new DMXController({protocol: 'sacn'});
controller.addUniverse(1);

const fixture = new Fixture(
  controller,
  RGBDimmerFixture,
  1,     // universe
  1,     // start address
  '4ch', // personality id
);

// RGBDimmerFixture expects state with `dimmer` and `rgb` array values in range 0..1
fixture.set({dimmer: 1, rgb: [1, 0.25, 0.1]});
fixture.render();

await controller.flush();
```

## 7. Runnable Examples
All examples live in `examples/`.

Core examples:
- `examples/sacn-basic.ts`
- `examples/sacn-animate.ts`
- `examples/sacn-rainbow.ts`
- `examples/artnet-animate.ts`
- `examples/artnet-discover.ts`
- `examples/rdm-tod.ts`

Additional animation examples:
- `examples/sacn-comet-chase.ts`
- `examples/sacn-fire-flicker.ts`
- `examples/sacn-police-strobe.ts`
- `examples/sacn-breathing-pastels.ts`
- `examples/sacn-color-wipe.ts`
- `examples/sacn-sparkle.ts`
- `examples/sacn-theater-chase.ts`
- `examples/sacn-aurora.ts`
- `examples/sacn-pulse-stack.ts`
- `examples/sacn-storm.ts`
- `examples/sacn-halloween.ts`
- `examples/sacn-christmas.ts`

Run an example:
```bash
npm run example/sacn-rainbow
```

## 8. Common Options
Useful options for `DMXController`:
- `protocol`: `'sacn' | 'artnet'`
- `iface`: local interface IPv4 address
- `reuseAddr`: allow multiple listeners/senders on same UDP port
- `unicastDestination`: send unicast instead of multicast/broadcast
- `artSync`: send ArtSync after flush (Art-Net)

## 9. TypeDoc
TypeDoc output uses `README.md` as the landing page.

Build docs:
```bash
npm run docs:build
```

Output:
- `generated/docs`

## Troubleshooting
- Verify your interface IP (`iface`) is on the same subnet as the fixture.
- If multicast does not work on your network, use unicast.
- Try universe numbering differences (some devices start at 0, most at 1).
- For Art-Net broadcast, ensure network allows UDP broadcasts.

## Protocol References
- Art-Net 4: https://art-net.org.uk/downloads/art-net.pdf
- ANSI E1.31 (sACN): https://tsp.esta.org/tsp/documents/published_docs.php
- ANSI E1.20 (RDM): https://getdlight.com/media/kunena/attachments/42/ANSI_E1-20_2010.pdf
