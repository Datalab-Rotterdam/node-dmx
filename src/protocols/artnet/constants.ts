/**
 * Art-Net 4 protocol constants.
 * @module artnet/constants
 *
 * Spec reference:
 * - Art-Net 4 Specification (tables for opcodes, fields, and defaults)
 *   https://art-net.org.uk/downloads/art-net.pdf
 */
export const ARTNET_PORT = 6454;
/** Art-Net packet id (8-byte ASCII signature). */
export const ARTNET_ID = 'Art-Net\u0000';
/** Protocol version used by this implementation. */
export const ARTNET_PROTOCOL_VERSION = 14;

/** Art-Net operation codes (little-endian on wire). */
export enum OpCode {
    OpPoll = 0x2000,
    OpPollReply = 0x2100,
    OpDiagData = 0x2300,
    OpCommand = 0x2400,
    OpDataRequest = 0x2700,
    OpDataReply = 0x2800,
    OpDmx = 0x5000,
    OpNzs = 0x5100,
    OpSync = 0x5200,
    OpAddress = 0x6000,
    OpInput = 0x7000,
    OpTodRequest = 0x8000,
    OpTodData = 0x8100,
    OpTodControl = 0x8200,
    OpRdm = 0x8300,
    OpRdmSub = 0x8400,
    OpTimeCode = 0x9700,
    OpTimeSync = 0x9800,
    OpTrigger = 0x9900,
    OpDirectory = 0x9a00,
    OpDirectoryReply = 0x9b00,
    OpFirmwareMaster = 0xf200,
    OpFirmwareReply = 0xf300,
    OpIpProg = 0xf800,
    OpIpProgReply = 0xf900,
    OpMacMaster = 0xf000,
    OpMacSlave = 0xf100,
}

/** Diagnostic priority values used by OpPoll and OpDiagData. */
export enum DiagnosticsPriority {
    Low = 0x10,
    Med = 0x40,
    High = 0x80,
    Critical = 0xe0,
    Volatile = 0xf0,
}

/** Node style codes advertised in ArtPollReply. */
export enum NodeStyle {
    StNode = 0x00,
    StController = 0x01,
    StMedia = 0x02,
    StRoute = 0x03,
    StBackup = 0x04,
    StConfig = 0x05,
    StVisual = 0x06,
}
