# Contributing to node-dmx

Thank you for helping out! This guide covers local setup, the project layout,
testing, and how changes get released. For how to *use* the library, see the
[README](README.md).

## Reporting bugs and requesting features
Use the [issue templates](https://github.com/Datalab-Rotterdam/node-dmx/issues/new/choose).
For bugs on the network, the most useful details are:
- the protocol (sACN, Art-Net, RDM, RDMnet)
- the device or console on the other end
- your OS
- a packet capture (Wireshark has dissectors for all four protocols)

## Development setup
Requirements: Node.js 20 or newer (CI uses 22) and npm.

```bash
git clone https://github.com/Datalab-Rotterdam/node-dmx.git
cd node-dmx
npm install
npm test
```

### Scripts
| Script                         | What it does                                                         |
|--------------------------------|----------------------------------------------------------------------|
| `npm test`                     | Vitest in watch mode                                                 |
| `npm run test:coverage`        | Single run with v8 coverage (what CI runs)                           |
| `npm run test:ui`              | Vitest browser UI                                                    |
| `npm run typecheck`            | `tsc --noEmit` on `src`                                              |
| `npm run build`                | Type-check, then Vite library build to `dist/` (ESM + CJS + `.d.ts`) |
| `npm run docs:build`           | TypeDoc API reference to `generated/docs`                            |
| `npm run example/<name>`       | Run `examples/<name>.ts` with `tsx`                                  |
| `npm run test:interop:rdmnet`  | RDMnet integration test against a real broker (see below)            |

## Project layout
```
src/
  core/          DMXController, Universe, shared helpers
  fixtures/      Fixture class, plugin types, registry, example vendor plugins
  protocols/
    sacn/        E1.31: packet codec, sender, receiver, merger, sync + discovery
    artnet/      Art-Net 4: packets, sender, receiver, discovery
      rdm/       RDM (E1.20) over Art-Net: client, responder, discovery, codec
    rdmnet/      E1.33: root layer, Broker, RPT, EPT, LLRP, DNS-SD discovery, client
test/            Vitest suites (one per area; transport.test.ts mocks dgram)
examples/        Runnable scripts, one npm script each
```

Everything public is exported from `src/index.ts`. The library has no
runtime dependencies and only uses Node built-ins (`dgram`, `net`, `tls`,
`os`, `crypto`, `events`).

## Coding guidelines
- **Never crash on network input.** Malformed packets must surface as a
  dedicated event (`PacketCorruption`, `invalidPacket`, `malformedPacket`),
  never as a thrown exception or an unhandled `'error'`. Emit `'error'` only
  when `listenerCount('error') > 0`.
- **Bind before configuring sockets.** `setBroadcast` and multicast options
  throw `EBADF` on an unbound dgram socket. Wait on the socket's `ready`
  promise before sending.
- **Make `close()` safe.** It should be idempotent, and sending after close
  should throw a clear error.
- **Cite the spec.** When behaviour follows a protocol rule, reference the
  clause in a comment (for example `E1.31 §6.7.1`).
- **Mind timers.** Background timers (keep-alive, source timeouts) must be
  `unref()`'d so they don't keep the process alive.
- **Avoid breaking public APIs.** Changing an existing event name, option
  default or method signature needs a `BREAKING CHANGE:` footer (see below).
- **Add tests.** Every bug fix or feature needs one. Socket behaviour can be
  tested with the mock dgram in `test/transport.test.ts`.

## Commit messages and releases
Releases are automated with [semantic-release](https://semantic-release.gitbook.io/)
on every push to `main`, so commit messages must follow
[Conventional Commits](https://www.conventionalcommits.org/):

| Prefix                         | Release | Example                                           |
|--------------------------------|---------|---------------------------------------------------|
| `fix:`                         | patch   | `fix(artnet): pad odd-length ArtDmx payloads`     |
| `feat:`                        | minor   | `feat(sacn): add source merger`                   |
| `BREAKING CHANGE:` footer      | major   | `feat!: rename PacketCorruption event`            |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:` | none | `docs: clarify universe numbering` |

Work on a branch, open a pull request against `main`, and wait for CI
(type-check, build, tests) to pass. On merge, CI:
1. bumps the version
2. updates `CHANGELOG.md`
3. tags the release
4. publishes to npm through trusted publishing (OIDC)
5. deploys the API docs to GitHub Pages

Do not edit `version` in `package.json` or `CHANGELOG.md` by hand.

## Testing against real hardware
Unit tests use mocks. For changes to wire formats or socket handling, please
also test on a real network if you can and mention the setup in your PR.

The `sacn-*` examples read `DMX_IFACE` to choose a network interface:
```bash
DMX_IFACE=192.168.1.50 npm run example/sacn-rainbow
npm run example/list-network-interfaces
```

### RDMnet interoperability
Smoke test against a real broker:
```bash
RDMNET_INTEROP_HOST=192.168.1.50 \
RDMNET_INTEROP_PORT=5568 \
npm run example/rdmnet-interop-smoke
```

Integration test (skipped unless `RDMNET_INTEROP_HOST` is set):
```bash
RDMNET_INTEROP_HOST=192.168.1.50 \
RDMNET_INTEROP_PORT=5568 \
RDMNET_INTEROP_SCOPE=default \
npm run test:interop:rdmnet
```

| Variable                        | Effect                                     |
|---------------------------------|--------------------------------------------|
| `RDMNET_INTEROP_TLS=1`          | Use TLS transport                          |
| `RDMNET_INTEROP_TLS_STRICT=0`   | Accept unauthorized TLS peers (lab setups) |
| `RDMNET_INTEROP_CHECK_LISTS=1`  | Also validate the Broker client list       |
| `RDMNET_INTEROP_TIMEOUT_MS=5000`| Per-request timeout                        |

## Protocol implementation notes

### sACN (E1.31)
- Sequence numbers are tracked per source CID and universe. A packet is
  discarded when `-20 < (seq - last) <= 0`.
- A source is lost after 2.5 s of silence (`NETWORK_DATA_LOSS_TIMEOUT_MS`) or
  when it sets the Stream_Terminated bit.
- Source names are UTF-8, at most 63 bytes plus a NUL terminator, and never
  split in the middle of a character.
- Frames with a non-zero START code (for example `0xDD` per-address priority)
  go to the `alternateStartCode` event.

### Art-Net 4
- Universes in the public API are 1-based (`universe = Port-Address + 1`)
  unless `artnetPortAddressing` is set.
- ArtDmx length is padded to an even number of at least 2.
- Senders default to the directed broadcast address of the bound interface.
- Discovery and the RDM client bind UDP 6454, because ArtPollReply and ArtRdm
  are sent to that port. On Windows, two sockets sharing 6454 in one process
  may see only one of them receive unicast replies.

### RDMnet (E1.33)
- The root layer, Broker PDUs and RPT PDUs are verified byte-for-byte against
  ETC's open-source E1.33 reference implementation.
- TCP framing is the 12-byte ACN packet identifier, a u32 PDU block size, then
  the root layer (`buildRdmnetTcpPacket` / `extractRdmnetTcpPackets`).
- LLRP runs over UDP multicast (§6) and works without a Broker session.
- The EPT codec and the new TCP framing have not yet been checked against a
  third-party broker. Reports from real setups are very welcome.
- Not implemented: EPT beyond basic pass-through, dynamic UID assignment,
  Redirect V6.
- node-dmx makes no formal compliance claim. That would need the ESTA
  conformance suite run against third-party equipment.

## Documentation
- The README is for library users: keep it task-focused, with working code
  snippets.
- Developer and protocol detail belongs in this file.
- API docs are generated from TSDoc comments in `src/`, so document public
  classes, options and events there.
