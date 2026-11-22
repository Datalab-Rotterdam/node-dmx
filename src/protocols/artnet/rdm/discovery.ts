/**
 * RDM discovery helpers (unique branch + mute/unmute).
 * @module artnet/rdm/discovery
 */
import {PIDS, RdmCommandClass} from './constants';
import {encodeRdmRequest} from './codec';
import type {RdmDiscoveryResult} from './types';
import type {RdmTransport} from './transport';
import {UID, UID_MAX, UID_MIN, uidFromBigInt, uidFromBuffer, uidInRange, uidToBigInt, uidToBuffer} from './uid';

const DISCOVERY_PREAMBLE = 0xfe;
const DISCOVERY_SEPARATOR = 0xaa;
const DISCOVERY_PREAMBLE_LEN = 7;

/**
 * Build a DISC_UNIQUE_BRANCH discovery response frame for `uid` (ANSI E1.20
 * §5.1: 7×0xFE preamble + 0xAA separator, then each of the 6 UID bytes and
 * the 2 checksum bytes transmitted as an `(byte|0xAA), (byte|0x55)` pair so
 * a receiver can recover the original byte via AND — this is a distinct
 * framing from a normal ACK/NACK response frame, with no 0xCC start code).
 * The checksum is the 16-bit sum of the 12 *encoded* UID bytes, matching
 * {@link decodeDiscoveryResponse} and verified against OLA's reference decoder.
 */
export function encodeDiscoveryResponse(uid: UID): Buffer {
    const uidBytes = uidToBuffer(uid);
    const encodedUid = Buffer.alloc(12);
    for (let i = 0; i < 6; i++) {
        encodedUid[i * 2] = uidBytes[i]! | 0xaa;
        encodedUid[i * 2 + 1] = uidBytes[i]! | 0x55;
    }

    let sum = 0;
    for (const byte of encodedUid) sum += byte;
    sum &= 0xffff;

    const encodedChecksum = Buffer.alloc(4);
    encodedChecksum[0] = ((sum >> 8) & 0xff) | 0xaa;
    encodedChecksum[1] = ((sum >> 8) & 0xff) | 0x55;
    encodedChecksum[2] = (sum & 0xff) | 0xaa;
    encodedChecksum[3] = (sum & 0xff) | 0x55;

    return Buffer.concat([
        Buffer.alloc(DISCOVERY_PREAMBLE_LEN, DISCOVERY_PREAMBLE),
        Buffer.from([DISCOVERY_SEPARATOR]),
        encodedUid,
        encodedChecksum,
    ]);
}

/**
 * Decode a DISC_UNIQUE_BRANCH discovery response frame (as built by
 * {@link encodeDiscoveryResponse}). Per ANSI E1.20 §7.5 the response starts
 * with 0-7 preamble bytes (0xFE) followed by the 0xAA separator — in-line
 * devices may shorten the preamble — so the decoder scans for the separator.
 * Returns `null` for anything that is not a valid, checksum-correct response
 * (including the garbled result of two devices answering at once).
 */
export function decodeDiscoveryResponse(buffer: Buffer): UID | null {
    let separator = 0;
    while (separator < DISCOVERY_PREAMBLE_LEN && buffer[separator] === DISCOVERY_PREAMBLE) {
        separator++;
    }
    if (buffer[separator] !== DISCOVERY_SEPARATOR) return null;

    const start = separator + 1;
    if (buffer.length < start + 16) return null;
    const encodedUid = buffer.subarray(start, start + 12);
    const encodedChecksum = buffer.subarray(start + 12, start + 16);

    // Every encoded pair is (byte | 0xAA), (byte | 0x55): those bits must be set.
    for (let i = 0; i < 8; i++) {
        const pair = i < 6 ? encodedUid : encodedChecksum;
        const offset = i < 6 ? i * 2 : (i - 6) * 2;
        if ((pair[offset]! & 0xaa) !== 0xaa || (pair[offset + 1]! & 0x55) !== 0x55) return null;
    }

    const uidBytes = Buffer.alloc(6);
    for (let i = 0; i < 6; i++) {
        uidBytes[i] = encodedUid[i * 2]! & encodedUid[i * 2 + 1]!;
    }

    const checksumBytes = Buffer.alloc(2);
    checksumBytes[0] = encodedChecksum[0]! & encodedChecksum[1]!;
    checksumBytes[1] = encodedChecksum[2]! & encodedChecksum[3]!;
    const checksum = checksumBytes.readUInt16BE(0);

    let sum = 0;
    for (const byte of encodedUid) sum += byte;
    sum &= 0xffff;
    if (sum !== checksum) return null;

    return uidFromBuffer(uidBytes, 0);
}

/** Build DISC_UNIQUE_BRANCH request payload for a UID range. */
function buildDiscoveryUniqueBranch(lower: UID, upper: UID, sourceUid: UID, transactionNumber: number): Buffer {
    const data = Buffer.concat([uidToBuffer(lower), uidToBuffer(upper)]);
    return encodeRdmRequest({
        destinationUid: UID_MAX,
        sourceUid,
        transactionNumber,
        portId: 1,
        subDevice: 0,
        commandClass: RdmCommandClass.DISCOVERY_COMMAND,
        pid: PIDS.DISC_UNIQUE_BRANCH,
        parameterData: data,
    });
}

/** Build DISC_MUTE or DISC_UN_MUTE request. */
function buildMute(uid: UID, sourceUid: UID, transactionNumber: number, unmute = false): Buffer {
    return encodeRdmRequest({
        destinationUid: uid,
        sourceUid,
        transactionNumber,
        portId: 1,
        subDevice: 0,
        commandClass: RdmCommandClass.DISCOVERY_COMMAND,
        pid: unmute ? PIDS.DISC_UN_MUTE : PIDS.DISC_MUTE,
    });
}

export type DiscoveryOptions = {
    /** Timeout applied to each transport request. */
    timeoutMs?: number;
    /** Controller/source UID used in generated requests. */
    sourceUid: UID;
    /** Whether to mute each found device during discovery. */
    muteFound?: boolean;
    /** Whether to unmute all muted devices before returning. */
    unmuteAtEnd?: boolean;
};

/**
 * Run RDM binary-search discovery across full UID range (ANSI E1.20 §7).
 *
 * For each branch a DISC_UNIQUE_BRANCH is sent:
 * - no reply: the branch is empty;
 * - exactly one valid, in-range reply: that device is muted and the *same*
 *   branch is probed again until it is silent, so further devices sharing the
 *   branch are found;
 * - replies that do not decode (collision), several distinct UIDs, or a device
 *   that cannot be muted: the branch is split in two and both halves searched.
 *
 * With `muteFound: false` devices are never muted; a branch with a single
 * clean reply is then considered done (any second device in it would have
 * collided), so discovery still terminates.
 *
 * @param transport RDM transport implementation.
 * @param options Discovery behavior flags and source UID.
 */
export async function discoverDevices(
    transport: RdmTransport,
    options: DiscoveryOptions,
): Promise<RdmDiscoveryResult[]> {
    const {sourceUid, muteFound = true, unmuteAtEnd = false, timeoutMs} = options;
    const results: RdmDiscoveryResult[] = [];
    const byUid = new Map<bigint, RdmDiscoveryResult>();
    let fallbackTransaction = 0;
    const nextTransaction = (): number => {
        const fromTransport = transport.nextTransactionNumber?.();
        if (fromTransport !== undefined) return fromTransport & 0xff;
        const tn = fallbackTransaction;
        fallbackTransaction = (tn + 1) & 0xff;
        return tn;
    };

    async function mute(uid: UID): Promise<boolean> {
        if (transport.sendMute) {
            return transport.sendMute(uid, {timeoutMs});
        }
        const response = await transport.send(
            {
                destinationUid: uid,
                sourceUid,
                transactionNumber: nextTransaction(),
                portId: 1,
                subDevice: 0,
                commandClass: RdmCommandClass.DISCOVERY_COMMAND,
                pid: PIDS.DISC_MUTE,
            },
            {timeoutMs},
        );
        return response !== null;
    }

    async function split(lower: UID, upper: UID): Promise<void> {
        const low = uidToBigInt(lower);
        const high = uidToBigInt(upper);
        if (low >= high) return;
        const mid = (low + high) / 2n;
        await discoverRange(lower, uidFromBigInt(mid));
        await discoverRange(uidFromBigInt(mid + 1n), upper);
    }

    async function discoverRange(lower: UID, upper: UID): Promise<void> {
        // Each pass either finds the branch silent, mutes one new device and
        // re-probes, or splits; muting a distinct device per pass bounds the loop.
        for (;;) {
            const response = await transport.sendDiscoveryUniqueBranch(lower, upper, {timeoutMs});
            const frames = response.responses;
            if (frames.length === 0) return;

            const distinct = new Map<bigint, UID>();
            let collision = false;
            for (const frame of frames) {
                const uid = decodeDiscoveryResponse(frame);
                if (uid === null || !uidInRange(uid, lower, upper)) {
                    collision = true;
                    continue;
                }
                distinct.set(uidToBigInt(uid), uid);
            }
            if (collision || distinct.size !== 1) {
                await split(lower, upper);
                return;
            }

            const [key, uid] = [...distinct.entries()][0]!;
            const known = byUid.get(key);
            if (!muteFound) {
                if (!known) {
                    const result = {uid, muted: false};
                    byUid.set(key, result);
                    results.push(result);
                }
                return;
            }
            if (known?.muted) {
                // Device keeps answering although it ACKed DISC_MUTE: narrow
                // the branch instead of looping on it forever.
                await split(lower, upper);
                return;
            }

            const muteOk = await mute(uid);
            if (known) {
                known.muted = muteOk;
            } else {
                const result = {uid, muted: muteOk};
                byUid.set(key, result);
                results.push(result);
            }
            if (!muteOk) {
                // Could not silence it: split so other devices in this branch
                // are not hidden behind it.
                await split(lower, upper);
                return;
            }
        }
    }

    await discoverRange(UID_MIN, UID_MAX);

    if (unmuteAtEnd) {
        for (const result of results) {
            if (!result.muted) continue;
            const uid = result.uid;
            if (transport.sendUnMute) {
                await transport.sendUnMute(uid, {timeoutMs});
            } else {
                const unmuteRequest = {
                    destinationUid: uid,
                    sourceUid,
                    transactionNumber: nextTransaction(),
                    portId: 1,
                    subDevice: 0,
                    commandClass: RdmCommandClass.DISCOVERY_COMMAND,
                    pid: PIDS.DISC_UN_MUTE,
                };
                await transport.send(unmuteRequest, {timeoutMs});
            }
        }
    }

    return results;
}

/** Low-level request builders exposed for testing/integration use. */
export const discoveryHelpers = {
    buildDiscoveryUniqueBranch,
    buildMute,
};
