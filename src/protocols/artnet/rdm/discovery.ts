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

function decodeDiscoveryResponse(buffer: Buffer): UID | null {
    const minLength = DISCOVERY_PREAMBLE_LEN + 1 + 12 + 4;
    if (buffer.length < minLength) return null;

    for (let i = 0; i < DISCOVERY_PREAMBLE_LEN; i++) {
        if (buffer[i] !== DISCOVERY_PREAMBLE) return null;
    }
    if (buffer[DISCOVERY_PREAMBLE_LEN] !== DISCOVERY_SEPARATOR) return null;

    const start = DISCOVERY_PREAMBLE_LEN + 1;
    const encodedUid = buffer.subarray(start, start + 12);
    const encodedChecksum = buffer.subarray(start + 12, start + 16);

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
 * Run RDM binary-search discovery across full UID range.
 * @param transport RDM transport implementation.
 * @param options Discovery behavior flags and source UID.
 */
export async function discoverDevices(
    transport: RdmTransport,
    options: DiscoveryOptions,
): Promise<RdmDiscoveryResult[]> {
    const {sourceUid, muteFound = true, unmuteAtEnd = false, timeoutMs} = options;
    const results: RdmDiscoveryResult[] = [];
    const muted: UID[] = [];

    async function discoverRange(lower: UID, upper: UID): Promise<void> {
        const response = await transport.sendDiscoveryUniqueBranch(lower, upper, {timeoutMs});
        const decoded = response.responses
            .map((res) => decodeDiscoveryResponse(res))
            .filter((uid): uid is UID => uid !== null && uidInRange(uid, lower, upper));

        if (decoded.length === 0) return;
        if (decoded.length === 1) {
            const uid = decoded[0]!;
            let muteOk = false;
            if (muteFound) {
                if (transport.sendMute) {
                    muteOk = await transport.sendMute(uid, {timeoutMs});
                } else {
                    const muteRequest = {
                        destinationUid: uid,
                        sourceUid,
                        transactionNumber: results.length & 0xff,
                        portId: 1,
                        subDevice: 0,
                        commandClass: RdmCommandClass.DISCOVERY_COMMAND,
                        pid: PIDS.DISC_MUTE,
                    };
                    const response = await transport.send(muteRequest, {timeoutMs});
                    muteOk = response !== null;
                }
            }
            results.push({uid, muted: muteOk});
            if (muteOk) muted.push(uid);
            return;
        }

        const low = uidToBigInt(lower);
        const high = uidToBigInt(upper);
        if (low >= high) return;
        const mid = (low + high) / 2n;
        await discoverRange(lower, uidFromBigInt(mid));
        if (mid + 1n <= high) {
            await discoverRange(uidFromBigInt(mid + 1n), upper);
        }
    }

    await discoverRange(UID_MIN, UID_MAX);

    if (unmuteAtEnd) {
        for (const uid of muted) {
            if (transport.sendUnMute) {
                await transport.sendUnMute(uid, {timeoutMs});
            } else {
                const unmuteRequest = {
                    destinationUid: uid,
                    sourceUid,
                    transactionNumber: results.length & 0xff,
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
