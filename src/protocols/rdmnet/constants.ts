/**
 * ANSI E1.33 (RDMnet) constants.
 * @module rdmnet/constants
 *
 * Spec references:
 * - ANSI E1.33 (RDMnet)
 * - ANSI E1.17 (ACN Root Layer framing)
 */
export const RDMNET_DEFAULT_PORT = 8888;
export const RDMNET_DEFAULT_HEARTBEAT_MS = 15000;
export const RDMNET_DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const RDMNET_DEFAULT_RECONNECT_DELAY_MS = 500;
export const RDMNET_DEFAULT_RECONNECT_MAX_DELAY_MS = 10000;
export const RDMNET_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
export const ACN_PREAMBLE_SIZE = 0x0010;
export const ACN_POSTAMBLE_SIZE = 0x0000;
export const ACN_PID = Buffer.from('ASC-E1.17\0\0\0', 'ascii');

/**
 * Root layer protocol vectors for E1.33 packets.
 * Values match the registered ACN root-layer protocol numbers
 * (ANSI E1.33 §5, confirmed against ETCLabs/EtcPal `acn_prot.h`).
 */
export enum RdmnetRootVector {
    Rpt = 0x00000005,
    Broker = 0x00000009,
    Llrp = 0x0000000a,
    Ept = 0x0000000b,
}

/**
 * LLRP's independent UDP multicast transport (ANSI E1.33 §6). LLRP is
 * designed to work even when a component has no active Broker/TCP
 * connection, so it is never carried over the Broker session — it always
 * uses these multicast groups/port directly. There are two groups, not
 * one: Managers send Probe Requests/RDM Commands to the REQUEST group;
 * Targets send Probe Replies/RDM Responses to the RESPONSE group. Both use
 * the same port. See {@link LlrpManager}/{@link LlrpTarget} in
 * `rdmnet/llrp-transport` for a ready-made UDP implementation, or use
 * `encodeLlrpMessage`/`decodeLlrpMessage` from `rdmnet/ept-llrp` directly
 * to build your own.
 */
export const LLRP_MULTICAST_REQUEST_GROUP = '239.255.250.133';
export const LLRP_MULTICAST_RESPONSE_GROUP = '239.255.250.134';
export const LLRP_MULTICAST_PORT = 5569;
/** Manager-side per-probe response window (defs.h `LLRP_TIMEOUT_MS`). */
export const LLRP_TIMEOUT_MS = 2000;
/** Target-side reply-pending staleness timeout (defs.h `LLRP_TARGET_TIMEOUT_MS`). */
export const LLRP_TARGET_TIMEOUT_MS = 500;
/** Target's randomized pre-reply backoff ceiling, to reduce reply collisions (defs.h `LLRP_MAX_BACKOFF_MS`). */
export const LLRP_MAX_BACKOFF_MS = 1500;
/** Max known-UID exclusion list size before the Manager must sub-range (defs.h `LLRP_KNOWN_UID_SIZE`). */
export const LLRP_KNOWN_UID_SIZE = 200;
/** Consecutive discovery-less probes required before a range is considered exhausted. */
export const LLRP_CLEAN_SENDS_TO_ADVANCE = 3;
