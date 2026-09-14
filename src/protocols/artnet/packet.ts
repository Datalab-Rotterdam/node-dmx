/**
 * Art-Net 4 packet builders and parsers.
 * @module artnet/packet
 *
 * Spec reference:
 * - Art-Net 4 Specification (opcode packets and field layouts)
 *   https://art-net.org.uk/downloads/art-net.pdf
 */
import {ARTNET_ID, ARTNET_PORT, ARTNET_PROTOCOL_VERSION, DiagnosticsPriority, NodeStyle, OpCode} from './constants';
import {readNullTerminatedString, splitUniverseAddress} from './util';

export type ArtDmxOptions = {
    /** 1-based universe number to send to. */
    universe: number;
    /** Art-Net sequence byte (0-255). */
    sequence: number;
    /** Physical output port number on controller, if used. */
    physical?: number;
    /** DMX frame bytes. */
    data: Uint8Array | Buffer;
    /** Optional data length override (max 512). */
    length?: number;
};

/** Parsed subset of fields from an incoming OpDmx packet. */
export type ArtDmxPacket = {
    protocolVersion: number;
    sequence: number;
    physical: number;
    net: number;
    subNet: number;
    universe: number;
    length: number;
    data: Buffer;
};

/** Bitfield flags/options for an ArtPoll packet. */
export type ArtPollOptions = {
    sendDiagnostics?: boolean;
    diagnosticsUnicast?: boolean;
    sendDiagnosticsOnChange?: boolean;
    sendInputOnChange?: boolean;
    sendIeee?: boolean;
    sendNodeReportOnData?: boolean;
    priority?: DiagnosticsPriority;
};

/** Payload for OpDiagData packets. */
export type ArtDiagDataOptions = {
    priority?: DiagnosticsPriority;
    message: string;
};

/** SMPTE-like timecode fields for ArtTimeCode. */
export type ArtTimeCode = {
    frames: number;
    seconds: number;
    minutes: number;
    hours: number;
    type: number;
};

/** Trigger key/sub-key and optional payload for OpTrigger. */
export type ArtTrigger = {
    key: number;
    subKey: number;
    payload?: Uint8Array | Buffer;
};

/** Parsed subset of fields from ArtPollReply. */
export type ArtPollReply = {
    ip: string;
    port: number;
    shortName: string;
    longName: string;
    numPorts: number;
    swIn: number[];
    swOut: number[];
    nodeReport: string;
    netSwitch?: number;
    subSwitch?: number;
    status1?: number;
    status2?: number;
    status3?: number;
};

/** Write common Art-Net header fields into a packet buffer. */
const writeHeader = (buffer: Buffer, opcode: OpCode): void => {
    buffer.write(ARTNET_ID, 0, 'ascii');
    buffer.writeUInt16LE(opcode, 8);
    buffer.writeUInt16BE(ARTNET_PROTOCOL_VERSION, 10);
};

/**
 * Recognize an incoming ArtPoll payload (used by device/responder code that
 * needs to answer with an ArtPollReply).
 */
export const parseArtPoll = (buffer: Buffer): boolean => {
    if (buffer.length < 14) return false;
    if (buffer.toString('ascii', 0, 8) !== ARTNET_ID) return false;
    return buffer.readUInt16LE(8) === OpCode.OpPoll;
};

/**
 * Build an ArtPoll packet used for node discovery.
 * @param options Poll flags and diagnostic priority.
 */
export const buildArtPoll = (options: ArtPollOptions = {}): Buffer => {
    const buffer = Buffer.alloc(14);
    writeHeader(buffer, OpCode.OpPoll);
    let talkToMe = 0;
    if (options.sendDiagnostics) talkToMe |= 0x02;
    if (options.diagnosticsUnicast) talkToMe |= 0x04;
    if (options.sendDiagnosticsOnChange) talkToMe |= 0x08;
    if (options.sendInputOnChange) talkToMe |= 0x10;
    if (options.sendIeee) talkToMe |= 0x20;
    if (options.sendNodeReportOnData) talkToMe |= 0x40;
    buffer.writeUInt8(talkToMe, 12);
    buffer.writeUInt8(options.priority ?? DiagnosticsPriority.Low, 13);
    return buffer;
};

/**
 * Build an ArtDMX packet carrying a DMX frame for one universe.
 * @param options DMX payload and addressing fields.
 */
export const buildArtDmx = (options: ArtDmxOptions): Buffer => {
    const length = Math.min(options.length ?? options.data.length, 512);
    const buffer = Buffer.alloc(18 + length);
    writeHeader(buffer, OpCode.OpDmx);
    buffer.writeUInt8(options.sequence & 0xff, 12);
    buffer.writeUInt8(options.physical ?? 0, 13);
    const addr = splitUniverseAddress(options.universe);
    buffer.writeUInt8(addr.subUni, 14);
    buffer.writeUInt8(addr.net, 15);
    buffer.writeUInt16BE(length, 16);
    Buffer.from(options.data).copy(buffer, 18, 0, length);
    return buffer;
};

/**
 * Parse an OpDmx payload into typed fields.
 * @param buffer Raw UDP payload.
 * @returns Parsed OpDmx data or `null` when payload is not OpDmx.
 */
export const parseArtDmx = (buffer: Buffer): ArtDmxPacket | null => {
    if (buffer.length < 18) return null;
    const id = buffer.toString('ascii', 0, 8);
    if (id !== ARTNET_ID) return null;
    const opcode = buffer.readUInt16LE(8);
    if (opcode !== OpCode.OpDmx) return null;

    const protocolVersion = buffer.readUInt16BE(10);
    const sequence = buffer.readUInt8(12);
    const physical = buffer.readUInt8(13);
    const subUni = buffer.readUInt8(14);
    const net = buffer.readUInt8(15);
    const length = buffer.readUInt16BE(16);
    if (length < 2 || length > 512) {
        throw new RangeError(`Invalid ArtDMX length ${length}: must be 2-512.`);
    }
    if (buffer.length < 18 + length) {
        throw new RangeError(`ArtDMX packet truncated: expected ${18 + length} bytes, got ${buffer.length}.`);
    }

    const subNet = (subUni >> 4) & 0x0f;
    const uni = subUni & 0x0f;
    const universe = ((net & 0x7f) << 8) | (subNet << 4) | uni;

    return {
        protocolVersion,
        sequence,
        physical,
        net,
        subNet,
        universe: universe + 1,
        length,
        data: Buffer.from(buffer.subarray(18, 18 + length)),
    };
};

/** Build an ArtSync packet for multi-universe synchronization. */
export const buildArtSync = (): Buffer => {
    const buffer = Buffer.alloc(14);
    writeHeader(buffer, OpCode.OpSync);
    buffer.writeUInt8(0, 12);
    buffer.writeUInt8(0, 13);
    return buffer;
};

/**
 * Build an ArtDiagData packet with an ASCII diagnostics message.
 * @param options Diagnostics priority and message.
 */
export const buildArtDiagData = (options: ArtDiagDataOptions): Buffer => {
    const message = Buffer.from(options.message, 'ascii');
    const buffer = Buffer.alloc(16 + message.length + 1);
    writeHeader(buffer, OpCode.OpDiagData);
    buffer.writeUInt8(0, 12);
    buffer.writeUInt8(options.priority ?? DiagnosticsPriority.Low, 13);
    buffer.writeUInt16BE(message.length + 1, 14);
    message.copy(buffer, 16);
    buffer.writeUInt8(0, 16 + message.length);
    return buffer;
};

/**
 * Build an ArtTimeCode packet.
 * @param timeCode Timecode components.
 */
export const buildArtTimeCode = (timeCode: ArtTimeCode): Buffer => {
    const buffer = Buffer.alloc(19);
    writeHeader(buffer, OpCode.OpTimeCode);
    buffer.writeUInt8(0, 12);
    buffer.writeUInt8(timeCode.frames & 0xff, 13);
    buffer.writeUInt8(timeCode.seconds & 0xff, 14);
    buffer.writeUInt8(timeCode.minutes & 0xff, 15);
    buffer.writeUInt8(timeCode.hours & 0xff, 16);
    buffer.writeUInt8(timeCode.type & 0xff, 17);
    buffer.writeUInt8(0, 18);
    return buffer;
};

/**
 * Build an ArtCommand packet.
 * @param command ASCII command string sent to Art-Net nodes.
 */
export const buildArtCommand = (command: string): Buffer => {
    const commandBuffer = Buffer.from(command, 'ascii');
    const buffer = Buffer.alloc(14 + commandBuffer.length + 1);
    writeHeader(buffer, OpCode.OpCommand);
    buffer.writeUInt8(0, 12);
    buffer.writeUInt8(0, 13);
    commandBuffer.copy(buffer, 14);
    buffer.writeUInt8(0, 14 + commandBuffer.length);
    return buffer;
};

/**
 * Build an ArtTrigger packet.
 * @param trigger Trigger fields.
 */
export const buildArtTrigger = (trigger: ArtTrigger): Buffer => {
    const payload = trigger.payload ? Buffer.from(trigger.payload) : Buffer.alloc(0);
    const buffer = Buffer.alloc(18 + payload.length);
    writeHeader(buffer, OpCode.OpTrigger);
    buffer.writeUInt8(0, 12);
    buffer.writeUInt8(trigger.key & 0xff, 13);
    buffer.writeUInt8(trigger.subKey & 0xff, 14);
    buffer.writeUInt8(0, 15);
    buffer.writeUInt16BE(payload.length, 16);
    payload.copy(buffer, 18);
    return buffer;
};

/**
 * Parse an ArtPollReply buffer into a typed object.
 * @param buffer Raw UDP payload.
 * @returns Parsed reply or `null` when payload is not an ArtPollReply.
 */
export const parseArtPollReply = (buffer: Buffer): ArtPollReply | null => {
    // Spec: consumers shall accept as valid a packet of 207 bytes or larger.
    if (buffer.length < 207) return null;
    const id = buffer.toString('ascii', 0, 8);
    if (id !== ARTNET_ID) return null;
    const opcode = buffer.readUInt16LE(8);
    if (opcode !== OpCode.OpPollReply) return null;
    const ip = `${buffer[10]}.${buffer[11]}.${buffer[12]}.${buffer[13]}`;
    // Port is transmitted low byte first per spec.
    const port = buffer.readUInt16LE(14);
    const netSwitch = buffer[18];
    const subSwitch = buffer[19];
    const status1 = buffer[23];
    const shortName = readNullTerminatedString(buffer, 26, 18);
    const longName = readNullTerminatedString(buffer, 44, 64);
    const nodeReport = readNullTerminatedString(buffer, 108, 64);
    const numPorts = buffer.readUInt16BE(172);
    const swIn = Array.from(buffer.subarray(186, 190));
    const swOut = Array.from(buffer.subarray(190, 194));
    const status2 = buffer.length > 212 ? buffer[212] : undefined;
    const status3 = buffer.length > 217 ? buffer[217] : undefined;
    return {
        ip,
        port,
        shortName,
        longName,
        nodeReport,
        numPorts,
        swIn,
        swOut,
        netSwitch,
        subSwitch,
        status1,
        status2,
        status3,
    };
};

/** Options for {@link buildArtPollReply} — a single-output-port device/responder reply. */
export type ArtPollReplyOptions = {
    /** This node's IPv4 address, dotted-quad. */
    ip: string;
    port?: number;
    /** Max 17 ASCII chars (18-byte field, null-terminated). */
    shortName?: string;
    /** Max 63 ASCII chars (64-byte field, null-terminated). */
    longName?: string;
    nodeReport?: string;
    /** 1-based universe advertised on the single output port. */
    universe: number;
    mac?: Buffer;
    style?: NodeStyle;
    /** ESTA manufacturer code (16-bit) — typically the responder's RDM UID manufacturer id. */
    estaManufacturer?: number;
};

/**
 * Build an ArtPollReply advertising one output port (i.e. a device that
 * receives DMX — a fixture), so `ArtNetDiscovery.pollOnce()` and similar
 * controllers can find it.
 *
 * NOTE: this covers the fields needed for basic discovery and status
 * (IP/port, name/report, port config, RDM-capable flag). A few rarely-used
 * optional fields (detailed Status2/Status3 capability bits, per-port
 * GoodOutput detail beyond "active") are left at sensible defaults rather
 * than exhaustively spec-verified — real controllers don't require them
 * for basic discovery/RDM-over-Art-Net interop.
 */
export const buildArtPollReply = (options: ArtPollReplyOptions): Buffer => {
    const buffer = Buffer.alloc(239);
    buffer.write(ARTNET_ID, 0, 'ascii');
    buffer.writeUInt16LE(OpCode.OpPollReply, 8);

    const ipParts = options.ip.split('.').map((part) => Number(part) & 0xff);
    for (let i = 0; i < 4; i++) buffer.writeUInt8(ipParts[i] ?? 0, 10 + i);
    buffer.writeUInt16LE(options.port ?? ARTNET_PORT, 14); // Port: transmitted low byte first
    buffer.writeUInt16BE(ARTNET_PROTOCOL_VERSION, 16);

    const addr = splitUniverseAddress(options.universe);
    const subNet = (addr.subUni >> 4) & 0x0f;
    const uni = addr.subUni & 0x0f;
    buffer.writeUInt8(addr.net, 18); // NetSwitch
    buffer.writeUInt8(subNet, 19); // SubSwitch
    buffer.writeUInt16BE(0xffff, 20); // Oem: unknown/not registered
    buffer.writeUInt8(0, 22); // UbeaVersion
    buffer.writeUInt8(0x02, 23); // Status1: RDM-capable flag set
    buffer.writeUInt16BE(options.estaManufacturer ?? 0x7a70, 24); // EstaMan

    Buffer.from((options.shortName ?? 'node-dmx').substring(0, 17), 'ascii').copy(buffer, 26);
    Buffer.from((options.longName ?? 'node-dmx simulated fixture').substring(0, 63), 'ascii').copy(buffer, 44);
    Buffer.from((options.nodeReport ?? '').substring(0, 63), 'ascii').copy(buffer, 108);

    buffer.writeUInt16BE(1, 172); // NumPorts
    buffer.writeUInt8(0x80, 174); // PortTypes[0]: port exists, DMX512 output
    buffer.writeUInt8(0, 178); // GoodInput[0]
    buffer.writeUInt8(0x80, 182); // GoodOutput[0]: data present/active
    buffer.writeUInt8(0, 186); // SwIn[0]
    buffer.writeUInt8(uni, 190); // SwOut[0]

    buffer.writeUInt8(options.style ?? NodeStyle.StNode, 200);
    if (options.mac) options.mac.copy(buffer, 201, 0, 6);
    for (let i = 0; i < 4; i++) buffer.writeUInt8(ipParts[i] ?? 0, 207 + i); // BindIp

    return buffer;
};
