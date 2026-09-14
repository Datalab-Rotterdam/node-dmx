/**
 * Constants used in the sACN (E1.31) protocol implementation.
 * @module sACN/constants
 */

/**
 * ACN Packet Identifier (PID) as defined in ANSI E1.17.
 * Must be the 12-byte ASCII string `"ASC-E1.17\0\0\0"`.
 */
export const ACN_PID: Buffer = Buffer.from([
    0x41, // 'A'
    0x53, // 'S'
    0x43, // 'C'
    0x2d, // '-'
    0x45, // 'E'
    0x31, // '1'
    0x2e, // '.'
    0x31, // '1'
    0x37, // '7'
    0x00, // null
    0x00, // null
    0x00, // null
]);

/**
 * Default Component Identifier (CID).
 *
 * The E1.31 standard requires a **128-bit (16-byte) UUID** that remains constant
 * for the lifetime of a device. This default is provided for testing or simple use cases.
 *
 */
export const DEFAULT_CID: Buffer = Buffer.from([
    0x4C,0x69,0x67,0x68,
    0x74,0x53,0x6F,0x75,
    0x72,0x63,0x65,0x5F,
    0x55,0x55,0x49,0x44
]);

/**
 * Root layer protocol vectors (E1.31 Section 5.2).
 */
export enum RootVector {
    /** Standard data packet */
    DATA = 0x00000004,
    /** Extended protocol (not commonly used) */
    EXTENDED = 0x00000008,
}

/**
 * Framing layer protocol vectors (E1.31 Section 6.2).
 */
export enum FrameVector {
    /** DMX512-A data packet */
    DATA = 0x00000002,
}

/**
 * DMP (Data Management Protocol) layer vectors (E1.31 Section 7.2).
 */
export enum DmpVector {
    /** DMP Set Property Message (used for DMX data) */
    DATA = 0x00000002,
}

/**
 * Extended (root vector {@link RootVector.EXTENDED}) framing layer vectors
 * (E1.31 Section 4/8: Synchronization Packet, Universe Discovery Packet).
 */
export enum ExtendedFrameVector {
    /** Synchronization Packet (E1.31 Section 6). */
    SYNCHRONIZATION = 0x00000001,
    /** Universe Discovery Packet (E1.31 Section 8). */
    DISCOVERY = 0x00000002,
}

/** Universe Discovery Layer vector (E1.31 Section 8.4). */
export enum UniverseDiscoveryVector {
    UNIVERSE_LIST = 0x00000001,
}

/** Well-known multicast universe used for Universe Discovery packets (239.255.250.214). */
export const DISCOVERY_UNIVERSE = 64214;
/** Nominal resend interval for Universe Discovery packets (E1.31 Section 8.6). */
export const DISCOVERY_INTERVAL_MS = 10000;
/** Maximum universe entries per Universe Discovery page (E1.31 Section 8.5). */
export const MAX_UNIVERSES_PER_DISCOVERY_PAGE = 512;

/**
 * Framing layer Options bitfield (E1.31 Section 6.2.6).
 */
export enum FrameOptions {
    /** Bit 7: Preview_Data - packet is intended for visualization, not live output. */
    PREVIEW_DATA = 0x80,
    /** Bit 6: Stream_Terminated - source is terminating transmission of this universe. */
    STREAM_TERMINATED = 0x40,
    /** Bit 5: Force_Synchronization - allow output without waiting for sync packet. */
    FORCE_SYNCHRONIZATION = 0x20,
}
