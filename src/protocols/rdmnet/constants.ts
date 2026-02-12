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

/** Commonly used root vectors for E1.33 packets. */
export enum RdmnetRootVector {
    Broker = 0x00000001,
    Rpt = 0x00000002,
    Ept = 0x00000003,
    Llrp = 0x00000004,
}
