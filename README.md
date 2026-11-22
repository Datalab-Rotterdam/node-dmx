# node-dmx 🎛️

`node-dmx` is a TypeScript library for controlling DMX over IP from Node.js.

It supports:
- sACN (E1.31)
- Art-Net 4
- RDM over Art-Net
- RDMnet (ANSI E1.33: root layer + Broker session + RPT RDM transactions + real LLRP UDP discovery)
- A fixture plugin system

## RDMnet Compliance Status
- Root layer (`rdmnet/packet`), Broker PDU (`rdmnet/broker`), and RPT PDU (`rdmnet/rpt`) are wire-format-correct per ANSI E1.33, verified byte-for-byte against ETCLabs' open-source E1.33 reference implementation (root-layer extended flags+length, Broker Connect/Connect Reply/Client Entry/Client List/Disconnect/Null, RPT header + Request/Notification/Status PDUs including the RDM Command PDU's leading-0xCC encoding).
- LLRP (`rdmnet/llrp-transport`: `LlrpManager`, `LlrpTarget`) implements the real ANSI E1.33 §6 UDP multicast transport — two multicast groups (request/response), the 27-byte LLRP PDU header, Probe Request/Reply, RDM command passthrough, and the reference discovery algorithm (ranged probing with a known-UID exclusion list, gated by consecutive clean rounds). It is intentionally not carried over `RdmnetClient`'s TCP connection, matching the spec's requirement that LLRP work without a live Broker session.
- Not implemented: EPT client entries/messages beyond basic pass-through, Dynamic UID assignment, and Redirect V6. These are lower-traffic corners of E1.33 that most controllers/devices don't exercise.
- Not claimed: formal/full E1.33 compliance certification — that requires running the ANSI/ESTA conformance test suite against real third-party brokers/controllers/devices in your target environment, which is outside what a library alone can certify.

## Feature Support Matrix
| Area              | Feature                          | sACN (E1.31)            | Art-Net 4                 | RDMnet (E1.33)          | Notes                                                                                          |
|-------------------|----------------------------------|--------------------------|---------------------------|--------------------------|-------------------------------------------------------------------------------------------------|
| Core I/O          | DMX Send                         | ✅                      | ✅                        | ❌                      | `DMXController` sends DMX via sACN/Art-Net                                                      |
| Core I/O          | DMX Receive / Listen             | ✅                      | ✅                        | ❌                      | `Receiver`, `ArtNetReceiver` — RDMnet carries RDM device management, not DMX slot data          |
| Core I/O          | Synchronization / Discovery      | ✅                      | ✅ (ArtSync)              | n/a                      | `Sender.sendSync`, `UniverseDiscoverySource` (E1.31 §6/§8)                                      |
| Device Discovery  | Controller/Node Discovery        | ⚠️ Discovery packets    | ✅                        | ✅                       | `ArtNetDiscovery`, `RdmnetDiscovery` (DNS-SD + mDNS), `LlrpManager`                              |
| Device Management | RDM Messaging (controller)       | ❌                      | ✅                        | ✅                       | `ArtNetRdmClient` full flow, `RdmnetClient` RPT `rdmTransaction`, `LlrpManager` RDM passthrough  |
| Device Management | RDM Responder (fixture/device)   | n/a                      | ✅                        | ✅                       | `RdmResponder` core + `ArtNetRdmResponder` / `RdmnetClient.useRdmResponder` / `LlrpTarget`        |
| Security          | Secure Transport                 | ❌                      | ❌                        | ✅                       | `RdmnetClient` supports `transport: 'tls'`, peer auth policy, post-connect auth hook            |
| Ecosystem         | Fixture Plugin System            | ✅                      | ✅                        | ❌                       | Fixture API currently targets DMX output protocols                                              |
| Compliance        | Formal Protocol Compliance Claim | ✅ E1.31 implementation | ✅ Art-Net implementation | ⚠️ Wire-format verified | RDMnet: root/Broker/RPT/LLRP wire-verified; full claim depends on third-party conformance runs  |

This guide is written for students and first-time users: start simple, then move to advanced features.

## Requirements
- Node.js 20+
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
- The controller re-sends every flushed universe about once a second
  (`keepAliveMs`, default `1000`), because sACN receivers drop a source after
  2.5 s of silence. Call `close()` when done to stop it.

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

### Art-Net universe numbering
By default Art-Net universes are **1-based** (universe `1` = Port-Address `0`),
matching sACN. Most Art-Net consoles and nodes show the raw 0-based
Port-Address instead; opt in with `artnetPortAddressing`:

```ts
const controller = new DMXController({protocol: 'artnet', artnetPortAddressing: true});
controller.setChannel(0, 1, 255); // Port-Address 0 (Net 0, Sub-Net 0, Universe 0)
```

`ArtNetSender` accepts `portAddress` directly, and received ArtDMX packets
carry both `universe` (1-based) and `portAddress` (0-based).

## 4. Device Discovery (Art-Net)
```ts
import {ArtNetDiscovery} from 'node-dmx';

// Listens on UDP 6454 (where nodes send ArtPollReply). Pass `bindAddress`
// to poll that interface's directed broadcast address.
const discovery = new ArtNetDiscovery({bindAddress: '192.168.1.50'});
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
  // transactionNumber is optional: the client auto-increments it (0-255, wrapping)
  portId: 1,
  subDevice: 0,
  commandClass: RdmCommandClass.GET_COMMAND,
  pid: PIDS.DEVICE_INFO,
});

console.log(response); // null on timeout
client.close();
```

Replies are matched to requests by transaction number, UIDs and command
class, so concurrent requests are safe. Art-Net nodes send `OpRdm`/`ArtTodData`
to UDP **6454**, so the client binds that port by default (`localPort`, with
`reuseAddr: true`) and falls back to a random port if it's taken. On Windows,
sharing 6454 with another socket in the same process (e.g. an `ArtNetReceiver`)
can cause one of them to miss unicast replies; give each its own interface or
use `localPort: 0` if your nodes reply to the source port.

## 6. Simulate a Fixture (RDM Responder)
`RdmResponder` is a transport-agnostic RDM *device* core — it answers GET/SET for the
standard PID set (DEVICE_INFO, DMX_START_ADDRESS, IDENTIFY_DEVICE, DEVICE_LABEL,
DMX_PERSONALITY, MANUFACTURER_LABEL, SUPPORTED_PARAMETERS, DISC_MUTE/UN_MUTE...) for you —
no manual ACK/NACK frame or checksum handling. Three wrappers plug it into each transport:

```ts
import {ArtNetRdmResponder, RdmResponder} from 'node-dmx';

const uid = {manufacturerId: 0x7a70, deviceId: 0x00000042};
const responder = new RdmResponder({
  uid,
  deviceLabel: 'Sim Fixture 1',
  dmxStartAddress: 1,
  personalities: [{footprint: 3, description: 'RGB'}],
  onIdentifyChange: (on) => console.log('identify', on),
});

// Art-Net: answers ArtPoll/ArtTodRequest/ArtRdm; discoverable via ArtNetDiscovery.
const fixture = new ArtNetRdmResponder({responder, universe: 1});
fixture.on('dmx', (frame) => console.log('levels', frame.subarray(0, 3)));
```

- **Art-Net**: `ArtNetRdmResponder` (also receives ArtDMX for the configured universe).
- **RDMnet**: `RdmnetClient.useRdmResponder(responder)` — auto-answers inbound RPT Requests.
- **LLRP**: `new LlrpTarget({..., onRdmCommand: (frame) => responder.respond(frame)})`.

See `examples/artnet-fixture-simulator.ts`, `examples/rdmnet-fixture-simulator.ts`, and
`examples/rdmnet-llrp-fixture-simulator.ts`.

## 7. Fixtures (Higher-Level API)
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

Available built-in example fixture plugins:
- `RGBDimmerFixture` (`4ch`: dimmer + RGB)
- `RGBWW5Fixture` (`5ch`: R + G + B + warm white + cool white)

## 8. Runnable Examples
All examples live in `examples/`.

Core examples:
- `examples/sacn-basic.ts`
- `examples/sacn-animate.ts`
- `examples/sacn-animate-orignal.ts` (older single-universe variant)
- `examples/sacn-rainbow.ts`
- `examples/sacn-sync.ts` — Synchronization Packets (E1.31 §6)
- `examples/sacn-universe-discovery.ts` — Universe Discovery (E1.31 §8)
- `examples/sacn-listen-matrix.ts`
- `examples/artnet-animate.ts`
- `examples/artnet-listen-matrix.ts`
- `examples/artnet-discover.ts`
- `examples/artnet-fixture-simulator.ts` — simulate a DMX+RDM fixture
- `examples/rdm-tod.ts`
- `examples/rdmnet-listen.ts`
- `examples/rdmnet-discover.ts`
- `examples/rdmnet-interop-smoke.ts`
- `examples/rdmnet-rdm-transaction.ts` — RDM GET over RPT
- `examples/rdmnet-llrp-discover.ts` — real LLRP UDP device discovery
- `examples/rdmnet-fixture-simulator.ts` — simulate an RDMnet RDM device
- `examples/rdmnet-llrp-fixture-simulator.ts` — simulate an LLRP Target
- `examples/fixture-rgbww5.ts`
- `examples/list-network-interfaces.ts`

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

All `sacn-*` examples read `DMX_IFACE` to override the hardcoded interface IP:
```bash
DMX_IFACE=192.168.1.50 npm run example/sacn-rainbow
```

## 9. Common Options
Useful options for `DMXController`:
- `protocol`: `'sacn' | 'artnet'`
- `iface`: local interface IPv4 address
- `reuseAddr`: allow multiple listeners/senders on same UDP port
- `unicastDestination`: send unicast instead of multicast/broadcast
- `artSync`: send ArtSync after flush (Art-Net)
- `sacnSyncUniverse`: E1.31 synchronization address; receivers hold frames until the sync packet sent after each flush
- `keepAliveMs`: resend interval for unchanged universes (default `1000`, `0` disables)
- `artnetPortAddressing`: use raw 0-based Art-Net Port-Addresses as universe ids

Receiving sACN from several sources:
```ts
import {Receiver, Merger} from 'node-dmx';

const receiver = new Receiver({universes: [1]});
const merger = new Merger(receiver); // highest priority wins, HTP between equal priorities
merger.on('merged', ({universe, data}) => console.log(universe, data[0]));
receiver.on('sourceLost', (s) => console.log('lost', s.sourceName, s.reason));
```
The receiver applies the E1.31 sequence rules, reports sources that time out
(2.5 s) or send Stream_Terminated via `sourceLost`, and emits non-zero START
Code frames (e.g. `0xDD` priority) as `alternateStartCode` instead of `packet`.
Malformed network input never raises `error` (sACN: `PacketCorruption`,
Art-Net: `invalidPacket`), so a bad packet can't crash your process.

RDMnet client options:
- `uid`: **required** — this component's RDM UID (`{manufacturerId, deviceId}`), carried in the Broker Client Entry and every RPT header
- `transport`: `'tcp' | 'tls'` (default `tcp`)
- `tls`: Node TLS options (CA, client cert/key, ciphers, min/max version, etc.)
- `requireTlsAuthorization`: reject unauthorized TLS peers (default `true` when `transport: 'tls'`)
- `postConnectAuth`: async hook for environment-specific auth/profile checks

## 10. RDMnet Interoperability/Conformance
Use real brokers/devices for compliance verification (not mocks only).

Smoke-runner against a real broker:
```bash
RDMNET_INTEROP_HOST=192.168.1.50 \
RDMNET_INTEROP_PORT=5568 \
npm run example/rdmnet-interop-smoke
```

Environment-gated integration test:
```bash
RDMNET_INTEROP_HOST=192.168.1.50 \
RDMNET_INTEROP_PORT=5568 \
RDMNET_INTEROP_SCOPE=default \
npm run test:interop:rdmnet
```

Useful flags:
- `RDMNET_INTEROP_TLS=1`: use TLS transport
- `RDMNET_INTEROP_TLS_STRICT=0`: allow non-authorized TLS peer for lab setups
- `RDMNET_INTEROP_CHECK_LISTS=1`: also validate the broker client-list request
- `RDMNET_INTEROP_TIMEOUT_MS=5000`: per-request timeout override

## 11. TypeDoc
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
- ANSI E1.33 (RDMnet): https://tsp.esta.org/tsp/documents/published_docs.php
