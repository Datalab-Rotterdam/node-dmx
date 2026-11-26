# node-dmx 🎛️

[![npm version](https://img.shields.io/npm/v/node-dmx.svg)](https://www.npmjs.com/package/node-dmx)
[![npm downloads](https://img.shields.io/npm/dm/node-dmx.svg)](https://www.npmjs.com/package/node-dmx)
[![CI](https://github.com/Datalab-Rotterdam/node-dmx/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Datalab-Rotterdam/node-dmx/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Datalab-Rotterdam/node-dmx/branch/main/graph/badge.svg)](https://codecov.io/gh/Datalab-Rotterdam/node-dmx)
[![node](https://img.shields.io/node/v/node-dmx.svg)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/node-dmx.svg)](https://www.npmjs.com/package/node-dmx)
[![license](https://img.shields.io/npm/l/node-dmx.svg)](LICENSE)
[![docs](https://img.shields.io/badge/docs-API%20reference-blue.svg)](https://datalab-rotterdam.github.io/node-dmx/)

Control DMX lighting over your network from Node.js. Written in TypeScript and
has no runtime dependencies.

- **sACN (E1.31)**: send, receive and merge multiple sources, sync, universe discovery
- **Art-Net 4**: send, receive, node discovery, ArtSync
- **RDM (E1.20)**: configure and query fixtures over Art-Net
- **RDMnet (E1.33)**: Broker client, RDM over RPT, LLRP discovery, TLS
- **Fixture simulation**: make your app behave like an RDM-capable fixture
- **Fixture plugins**: set fixtures with values like `{dimmer: 1, rgb: [1, 0, 0]}` instead of raw channels

📚 **[API reference](https://datalab-rotterdam.github.io/node-dmx/)** · 🐛 **[Report a bug](https://github.com/Datalab-Rotterdam/node-dmx/issues/new/choose)** · 🛠️ **[Contributing](CONTRIBUTING.md)**

## Contents
- [Install](#install)
- [DMX in 30 seconds](#dmx-in-30-seconds)
- [Quick start](#quick-start)
- [Guides](#guides)
  - [Multiple universes](#multiple-universes)
  - [Art-Net universe numbering](#art-net-universe-numbering)
  - [Receiving sACN](#receiving-sacn)
  - [Receiving Art-Net](#receiving-art-net)
  - [Finding Art-Net nodes](#finding-art-net-nodes)
  - [RDM over Art-Net](#rdm-over-art-net)
  - [Simulating a fixture](#simulating-a-fixture)
  - [Testing without lights](#testing-without-lights)
  - [Fixtures](#fixtures)
- [Controller options](#controller-options)
- [Protocol support](#protocol-support)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Install
```bash
npm install node-dmx
```

You need Node.js 20 or newer, plus a lighting device or node that speaks sACN or
Art-Net on the same network as your computer. The package ships both ESM and
CommonJS builds with type definitions.

## DMX in 30 seconds
- A **universe** is 512 channels. A **channel value** is 0–255.
- A fixture uses a few consecutive channels from its **start address** (for
  example red, green, blue on channels 1–3).
- With node-dmx you change values in memory, then call `flush()` to send them.
- The controller resends each universe about once a second, even if nothing
  changed. Receivers drop a silent source after 2.5 s, so this keeps your
  lights on. Call `close()` when you're done.

## Quick start

### sACN
```ts
import {DMXController} from 'node-dmx';

const controller = new DMXController({protocol: 'sacn'});
const universe = controller.addUniverse(1);

universe.setChannel(1, 255); // channel 1 at full
await controller.flush();

// ...later
controller.close();
```

If your computer has more than one network interface, pick one with
`iface: '192.168.1.50'` (the IPv4 address of your own network card).

### Art-Net
```ts
import {DMXController} from 'node-dmx';

const controller = new DMXController({protocol: 'artnet', artSync: true});

controller.setChannel(1, 1, 255); // universe 1, channel 1, full
await controller.flush();
controller.close();
```

By default Art-Net uses your subnet's broadcast address. To send to one node
instead, set `unicastDestination: '192.168.1.20'`.

## Guides

### Multiple universes
```ts
const controller = new DMXController({protocol: 'sacn'});
const u1 = controller.addUniverse(1);
const u2 = controller.addUniverse(2);

u1.setChannel(1, 255);
u2.fill(128);          // all 512 channels at half
u2.setFrame(new Uint8Array([255, 0, 0])); // replace whole frame, rest becomes 0

await controller.flush(); // sends every changed universe at once
```

To make several universes change on the exact same frame, use sACN sync:
`new DMXController({protocol: 'sacn', sacnSyncUniverse: 7999})`. Receivers then
hold each frame until a sync packet arrives after `flush()`.

### Art-Net universe numbering
By default, Art-Net universes start at **1**, like sACN (universe `1` is
Port-Address `0`). Most Art-Net consoles and nodes show the raw Port-Address,
which starts at **0**. To use that numbering, turn on `artnetPortAddressing`:

```ts
const controller = new DMXController({protocol: 'artnet', artnetPortAddressing: true});
controller.setChannel(0, 1, 255); // Port-Address 0 (Net 0, Sub-Net 0, Universe 0)
```

### Receiving sACN
```ts
import {Receiver, Merger} from 'node-dmx';

const receiver = new Receiver({universes: [1, 2]});

receiver.on('packet', (packet) => {
  console.log(packet.universe, packet.sourceName, packet.payloadAsBuffer?.[0]);
});
receiver.on('sourceLost', (source) => console.log('lost', source.sourceName, source.reason));
```

With several consoles on one universe, a `Merger` combines them into one frame.
The highest priority wins, and sources with equal priority are merged
highest-takes-precedence (HTP):

```ts
const merger = new Merger(receiver);
merger.on('merged', ({universe, data}) => console.log(universe, data[0]));
```

Bad network packets never crash your process. They are reported as
`PacketCorruption` events, which you can ignore.

### Receiving Art-Net
```ts
import {ArtNetReceiver} from 'node-dmx';

const receiver = new ArtNetReceiver({universes: [1]});
receiver.on('dmx', (msg) => console.log(msg.universe, msg.portAddress, msg.data[0]));
```

### Finding Art-Net nodes
```ts
import {ArtNetDiscovery} from 'node-dmx';

const discovery = new ArtNetDiscovery({bindAddress: '192.168.1.50'});
const nodes = await discovery.pollOnce();

for (const node of nodes) {
  console.log(node.ip, node.shortName, node.longName);
}
discovery.close();
```

### RDM over Art-Net
RDM lets you query and configure fixtures: read their info, change the DMX
start address, or make them identify themselves.

```ts
import {ArtNetRdmClient, RdmCommandClass, PIDS} from 'node-dmx';

const client = new ArtNetRdmClient({host: '192.168.1.20'});

const response = await client.rdmTransaction(1, {
  destinationUid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
  sourceUid: {manufacturerId: 0x7a70, deviceId: 0x00000002},
  portId: 1,
  subDevice: 0,
  commandClass: RdmCommandClass.GET_COMMAND,
  pid: PIDS.DEVICE_INFO,
});

console.log(response); // null on timeout
client.close();
```

You can send requests at the same time; each reply goes back to the request it
belongs to. The client listens on UDP port 6454, where Art-Net nodes send their
replies.

### Simulating a fixture
`RdmResponder` makes your app act like an RDM fixture. It answers the standard
requests (device info, start address, identify, label, personality, and more)
for you.

```ts
import {ArtNetRdmResponder, RdmResponder} from 'node-dmx';

const responder = new RdmResponder({
  uid: {manufacturerId: 0x7a70, deviceId: 0x00000042},
  deviceLabel: 'Sim Fixture 1',
  dmxStartAddress: 1,
  personalities: [{footprint: 3, description: 'RGB'}],
  onIdentifyChange: (on) => console.log('identify', on),
});

const fixture = new ArtNetRdmResponder({responder, universe: 1});
fixture.on('dmx', (frame) => console.log('levels', frame.subarray(0, 3)));
```

The same responder also works over RDMnet (`RdmnetClient.useRdmResponder(responder)`)
and LLRP (`new LlrpTarget({..., onRdmCommand: (frame) => responder.respond(frame)})`).

### Testing without lights
[node-dmx-simulator](https://github.com/Datalab-Rotterdam/node-dmx-simulator)
is a stage full of virtual fixtures on your network: it receives sACN and
Art-Net, answers discovery and RDM, and shows the result in your browser.

![node-dmx-simulator in a browser: LED bars, pars and moving heads lit by sACN](https://raw.githubusercontent.com/Datalab-Rotterdam/node-dmx-simulator/main/docs/demo.gif)

```bash
npx node-dmx-simulator       # then open http://localhost:8080
npm run example/sacn-rainbow # in a second terminal
```

Drag fixtures around, change their patch, or start from a bundled rig
(`--rig classroom`).

### Fixtures
Fixture plugins let you set a fixture with values like colours and dimmer
levels from 0 to 1 instead of raw channel bytes.

```ts
import {DMXController, Fixture, RGBDimmerFixture} from 'node-dmx';

const controller = new DMXController({protocol: 'sacn'});

const fixture = new Fixture(controller, RGBDimmerFixture, 1 /* universe */, 1 /* address */, '4ch');

fixture.set({dimmer: 1, rgb: [1, 0.25, 0.1]});
fixture.render();
await controller.flush();
```

Built-in example plugins:
- `RGBDimmerFixture` (`4ch`: dimmer, R, G, B)
- `RGBWW5Fixture` (`5ch`: R, G, B, warm white, cool white)

To support your own fixtures, implement `FixtureModelPlugin<State>` (see
`src/fixtures/vendors/example` for reference).

## Controller options
`new DMXController(options)` accepts:

| Option                 | Default        | Description                                                                 |
|------------------------|----------------|-----------------------------------------------------------------------------|
| `protocol`             | `'sacn'`       | `'sacn'` or `'artnet'`                                                      |
| `iface`                | OS default     | IPv4 address of the network interface to send from                          |
| `unicastDestination`   | –              | Send to this IP instead of multicast (sACN) or broadcast (Art-Net)          |
| `keepAliveMs`          | `1000`         | How often unchanged universes are resent; `0` turns this off                |
| `artSync`              | `false`        | Art-Net: send ArtSync after each flush                                      |
| `sacnSyncUniverse`     | –              | sACN: synchronization universe; receivers hold frames until the sync packet |
| `artnetPortAddressing` | `false`        | Art-Net: universe ids are 0-based Port-Addresses                            |
| `defaultPacketOptions` | –              | sACN: `sourceName`, `priority`, `cid` for every packet                      |
| `sacn` / `artnet`      | –              | Protocol-specific sender settings                                           |
| `senderFactory`        | –              | Provide your own sender (useful for tests)                                  |

Background send errors are emitted as `controller.on('error', ...)`.

## Protocol support

| Feature                        | sACN (E1.31)       | Art-Net 4   | RDMnet (E1.33)       |
|--------------------------------|--------------------|-------------|----------------------|
| Send DMX                       | ✅                 | ✅          | n/a                  |
| Receive DMX                    | ✅ (with merging)  | ✅          | n/a                  |
| Synchronization                | ✅                 | ✅ ArtSync  | n/a                  |
| Device / node discovery        | ✅ Universe discovery | ✅ ArtPoll | ✅ DNS-SD + LLRP    |
| RDM controller                 | –                  | ✅          | ✅                   |
| RDM responder (simulate fixture) | –                | ✅          | ✅                   |
| Secure transport (TLS)         | –                  | –           | ✅                   |

RDMnet's wire format is checked against the ETC open-source E1.33 reference
implementation, but node-dmx has not been certified with the ESTA conformance
suite. EPT beyond basic pass-through, dynamic UID assignment and Redirect V6
are not implemented.

## Examples
The [`examples/`](https://github.com/Datalab-Rotterdam/node-dmx/tree/main/examples) folder has runnable scripts for every feature:
animations (rainbow, comet chase, fire, storm…), listeners, discovery, RDM, and
fixture simulators. To run one, clone the repository and run:

```bash
npm install
npm run example/sacn-rainbow
DMX_IFACE=192.168.1.50 npm run example/sacn-rainbow   # choose an interface
```

`npm run example/list-network-interfaces` shows the interface addresses on
your machine.

## Troubleshooting
- **Nothing lights up**: check that `iface` is on the same subnet as the
  device, and that the device listens to the same universe and protocol.
- **Off by one universe**: some devices count from 0. For Art-Net, try
  `artnetPortAddressing: true`.
- **Multicast is blocked** (common on Wi-Fi and managed switches): use
  `unicastDestination`.
- **Art-Net replies are missing**: make sure UDP port 6454 is not taken by
  other software and that your firewall allows UDP broadcasts.
- **Lights drop out when idle**: keep `keepAliveMs` above `0`.

Still stuck? [Open an issue](https://github.com/Datalab-Rotterdam/node-dmx/issues/new/choose).

## Protocol references
- [Art-Net 4](https://art-net.org.uk/downloads/art-net.pdf)
- [ANSI E1.31 (sACN), E1.20 (RDM), E1.33 (RDMnet)](https://tsp.esta.org/tsp/documents/published_docs.php)

## License
[Apache-2.0](LICENSE)
