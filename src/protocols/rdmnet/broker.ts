/**
 * ANSI E1.33 (RDMnet) Broker PDU (root vector {@link RdmnetRootVector.Broker}).
 * @module rdmnet/broker
 *
 * Verified against ETCLabs/RDMnet `src/rdmnet/core/broker_prot.c` and
 * `include/rdmnet/defs.h` (pack functions + field-size constants read
 * directly from source, not guessed).
 */
import type {UID} from '../artnet/rdm/uid';
import {uidFromBuffer, uidToBuffer} from '../artnet/rdm/uid';
import {assertPduFlags, readFixedString, readPduLength, writeFixedString, writePduLength} from './pdu';

/** Broker PDU vectors (defs.h). */
export enum BrokerVector {
    Connect = 0x0001,
    ConnectReply = 0x0002,
    ClientEntryUpdate = 0x0003,
    RedirectV4 = 0x0004,
    RedirectV6 = 0x0005,
    FetchClientList = 0x0006,
    ConnectedClientList = 0x0007,
    ClientAdd = 0x0008,
    ClientRemove = 0x0009,
    ClientEntryChange = 0x000a,
    Disconnect = 0x000e,
    /** Heartbeat/keepalive; empty payload. */
    Null = 0x000f,
}

/** Client Protocol carried in a Client Entry header. Only RPT is implemented. */
export enum ClientProtocol {
    Rpt = 0x00000005,
    Ept = 0x0000000b,
}

/** RPT Client Type (defs.h). */
export enum RptClientType {
    Device = 0x0000,
    Controller = 0x0001,
}

/** Broker Connection Status codes (Connect Reply, defs.h). */
export enum ConnectionStatusCode {
    Ok = 0x0000,
    ScopeMismatch = 0x0001,
    CapacityExceeded = 0x0002,
    DuplicateUid = 0x0003,
    InvalidClientEntry = 0x0004,
    InvalidUid = 0x0005,
}

/** Broker Disconnect reason codes (defs.h). */
export enum DisconnectReason {
    Shutdown = 0x0000,
    CapacityExhausted = 0x0001,
    HardwareFault = 0x0002,
    SoftwareFault = 0x0003,
    SoftwareReset = 0x0004,
    IncorrectScope = 0x0005,
    RptReconfigure = 0x0006,
    LlrpReconfigure = 0x0007,
    UserReconfigure = 0x0008,
}

/** Fixed field widths (E1.33 §6.2.1/6.3.1.2, defs.h). */
export const E133_SCOPE_STRING_PADDED_LENGTH = 63;
export const E133_DOMAIN_STRING_PADDED_LENGTH = 231;
/** Current E1.33 protocol version number. */
export const E133_VERSION = 1;
export const DEFAULT_SCOPE = 'default';

/** Connect Flags bit 0 (Client Connect / Client Entry Update). */
const CONNECT_FLAG_INCREMENTAL_UPDATES = 0x01;

export type RptClientEntry = {
    clientProtocol: ClientProtocol.Rpt;
    /** Component identifier of the client owning this entry. */
    cid: Buffer;
    uid: UID;
    clientType: RptClientType;
    /** All-zero when this client does not act as a proxy for another component. */
    bindingCid: Buffer;
};

export type BrokerConnectMessage = {
    vector: BrokerVector.Connect;
    scope: string;
    e133Version?: number;
    searchDomain?: string;
    incrementalUpdates?: boolean;
    clientEntry: RptClientEntry;
};

export type BrokerConnectReplyMessage = {
    vector: BrokerVector.ConnectReply;
    connectionStatus: ConnectionStatusCode;
    e133Version: number;
    brokerUid: UID;
    clientUid: UID;
};

export type BrokerClientEntryUpdateMessage = {
    vector: BrokerVector.ClientEntryUpdate;
    incrementalUpdates?: boolean;
    clientEntry: RptClientEntry;
};

export type BrokerConnectedClientListMessage = {vector: BrokerVector.ConnectedClientList; clients: RptClientEntry[]};
export type BrokerClientAddMessage = {vector: BrokerVector.ClientAdd; clients: RptClientEntry[]};
export type BrokerClientRemoveMessage = {vector: BrokerVector.ClientRemove; clients: RptClientEntry[]};
export type BrokerClientEntryChangeMessage = {vector: BrokerVector.ClientEntryChange; clients: RptClientEntry[]};
export type BrokerClientListMessage =
    | BrokerConnectedClientListMessage
    | BrokerClientAddMessage
    | BrokerClientRemoveMessage
    | BrokerClientEntryChangeMessage;

export type BrokerFetchClientListMessage = {vector: BrokerVector.FetchClientList};
export type BrokerNullMessage = {vector: BrokerVector.Null};

export type BrokerDisconnectMessage = {
    vector: BrokerVector.Disconnect;
    reason: DisconnectReason;
};

export type BrokerRedirectMessage = {
    vector: BrokerVector.RedirectV4;
    /** Dotted-quad IPv4 address. */
    address: string;
    port: number;
};

export type BrokerMessage =
    | BrokerConnectMessage
    | BrokerConnectReplyMessage
    | BrokerClientEntryUpdateMessage
    | BrokerClientListMessage
    | BrokerFetchClientListMessage
    | BrokerNullMessage
    | BrokerDisconnectMessage
    | BrokerRedirectMessage;

const BROKER_HEADER_LENGTH = 5;
/** Client Entry header: flags+length(3) + client protocol vector(4) + CID(16). */
const CLIENT_ENTRY_HEADER_LENGTH = 23;
/** RPT Client Entry Data: UID(6) + Client Type(1) + Binding CID(16). */
const RPT_CLIENT_ENTRY_DATA_LENGTH = 23;
const RPT_CLIENT_ENTRY_LENGTH = CLIENT_ENTRY_HEADER_LENGTH + RPT_CLIENT_ENTRY_DATA_LENGTH;

function encodeClientEntry(entry: RptClientEntry): Buffer {
    if (entry.cid.length !== 16) throw new RangeError(`Client Entry CID must be 16 bytes, got ${entry.cid.length}`);
    if (entry.bindingCid.length !== 16) {
        throw new RangeError(`Client Entry binding CID must be 16 bytes, got ${entry.bindingCid.length}`);
    }
    const buf = Buffer.alloc(RPT_CLIENT_ENTRY_LENGTH);
    writePduLength(buf, 0, RPT_CLIENT_ENTRY_LENGTH);
    buf.writeUInt32BE(ClientProtocol.Rpt, 3);
    entry.cid.copy(buf, 7);
    uidToBuffer(entry.uid).copy(buf, 23);
    buf.writeUInt8(entry.clientType, 29);
    entry.bindingCid.copy(buf, 30);
    return buf;
}

function decodeClientEntry(buf: Buffer, offset: number): {entry: RptClientEntry; length: number} {
    if (offset + CLIENT_ENTRY_HEADER_LENGTH > buf.length) {
        throw new RangeError('Client Entry header truncated');
    }
    const {flagsNibble, length} = readPduLength(buf, offset);
    assertPduFlags(flagsNibble, 'Client Entry');
    if (offset + length > buf.length) throw new RangeError('Client Entry PDU exceeds buffer');
    const clientProtocol = buf.readUInt32BE(offset + 3);
    const cid = Buffer.from(buf.subarray(offset + 7, offset + 23));
    if (clientProtocol !== ClientProtocol.Rpt) {
        throw new Error(`Unsupported client protocol 0x${clientProtocol.toString(16)} (only RPT client entries are supported)`);
    }
    if (length < RPT_CLIENT_ENTRY_LENGTH) throw new RangeError('RPT Client Entry too short');
    const uid = uidFromBuffer(buf, offset + 23);
    const clientType = buf.readUInt8(offset + 29) as RptClientType;
    const bindingCid = Buffer.from(buf.subarray(offset + 30, offset + 46));
    return {entry: {clientProtocol: ClientProtocol.Rpt, cid, uid, clientType, bindingCid}, length};
}

function writeBrokerHeader(buf: Buffer, vector: BrokerVector, totalLength: number): void {
    writePduLength(buf, 0, totalLength);
    buf.writeUInt16BE(vector, 3);
}

/** Build wire bytes for one Broker message (data placed after the 23-byte root layer by the caller). */
export const encodeBrokerMessage = (message: BrokerMessage): Buffer => {
    switch (message.vector) {
        case BrokerVector.Connect: {
            const entryBuf = encodeClientEntry(message.clientEntry);
            const total =
                BROKER_HEADER_LENGTH +
                E133_SCOPE_STRING_PADDED_LENGTH +
                2 +
                E133_DOMAIN_STRING_PADDED_LENGTH +
                1 +
                entryBuf.length;
            const buf = Buffer.alloc(total);
            writeBrokerHeader(buf, BrokerVector.Connect, total);
            let offset = BROKER_HEADER_LENGTH;
            writeFixedString(buf, offset, E133_SCOPE_STRING_PADDED_LENGTH, message.scope || DEFAULT_SCOPE);
            offset += E133_SCOPE_STRING_PADDED_LENGTH;
            buf.writeUInt16BE(message.e133Version ?? E133_VERSION, offset);
            offset += 2;
            writeFixedString(buf, offset, E133_DOMAIN_STRING_PADDED_LENGTH, message.searchDomain ?? '');
            offset += E133_DOMAIN_STRING_PADDED_LENGTH;
            buf.writeUInt8(message.incrementalUpdates ? CONNECT_FLAG_INCREMENTAL_UPDATES : 0, offset);
            offset += 1;
            entryBuf.copy(buf, offset);
            return buf;
        }
        case BrokerVector.ConnectReply: {
            const total = BROKER_HEADER_LENGTH + 16;
            const buf = Buffer.alloc(total);
            writeBrokerHeader(buf, BrokerVector.ConnectReply, total);
            buf.writeUInt16BE(message.connectionStatus, 5);
            buf.writeUInt16BE(message.e133Version, 7);
            uidToBuffer(message.brokerUid).copy(buf, 9);
            uidToBuffer(message.clientUid).copy(buf, 15);
            return buf;
        }
        case BrokerVector.ClientEntryUpdate: {
            const entryBuf = encodeClientEntry(message.clientEntry);
            const total = BROKER_HEADER_LENGTH + 1 + entryBuf.length;
            const buf = Buffer.alloc(total);
            writeBrokerHeader(buf, BrokerVector.ClientEntryUpdate, total);
            buf.writeUInt8(message.incrementalUpdates ? CONNECT_FLAG_INCREMENTAL_UPDATES : 0, 5);
            entryBuf.copy(buf, 6);
            return buf;
        }
        case BrokerVector.ConnectedClientList:
        case BrokerVector.ClientAdd:
        case BrokerVector.ClientRemove:
        case BrokerVector.ClientEntryChange: {
            const entryBufs = message.clients.map(encodeClientEntry);
            const total = BROKER_HEADER_LENGTH + entryBufs.reduce((sum, b) => sum + b.length, 0);
            const buf = Buffer.alloc(total);
            writeBrokerHeader(buf, message.vector, total);
            let offset = BROKER_HEADER_LENGTH;
            for (const entryBuf of entryBufs) {
                entryBuf.copy(buf, offset);
                offset += entryBuf.length;
            }
            return buf;
        }
        case BrokerVector.FetchClientList:
        case BrokerVector.Null: {
            const buf = Buffer.alloc(BROKER_HEADER_LENGTH);
            writeBrokerHeader(buf, message.vector, BROKER_HEADER_LENGTH);
            return buf;
        }
        case BrokerVector.Disconnect: {
            const buf = Buffer.alloc(BROKER_HEADER_LENGTH + 2);
            writeBrokerHeader(buf, BrokerVector.Disconnect, buf.length);
            buf.writeUInt16BE(message.reason, 5);
            return buf;
        }
        case BrokerVector.RedirectV4: {
            const buf = Buffer.alloc(BROKER_HEADER_LENGTH + 6);
            writeBrokerHeader(buf, BrokerVector.RedirectV4, buf.length);
            const parts = message.address.split('.').map(Number);
            if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
                throw new RangeError(`Invalid IPv4 address "${message.address}"`);
            }
            for (let i = 0; i < 4; i++) buf.writeUInt8(parts[i]!, 5 + i);
            buf.writeUInt16BE(message.port, 9);
            return buf;
        }
        default:
            throw new Error('Unsupported broker message');
    }
};

/** Parse one Broker PDU's bytes (as produced by {@link encodeBrokerMessage}). */
export const decodeBrokerMessage = (buf: Buffer): BrokerMessage => {
    if (buf.length < BROKER_HEADER_LENGTH) throw new RangeError('Broker PDU too short');
    const {flagsNibble, length} = readPduLength(buf, 0);
    assertPduFlags(flagsNibble, 'Broker PDU');
    if (length > buf.length) throw new RangeError('Broker PDU length exceeds buffer');
    const vector = buf.readUInt16BE(3) as BrokerVector;
    const data = buf.subarray(BROKER_HEADER_LENGTH, length);

    switch (vector) {
        case BrokerVector.Connect: {
            const minLen = E133_SCOPE_STRING_PADDED_LENGTH + 2 + E133_DOMAIN_STRING_PADDED_LENGTH + 1;
            if (data.length < minLen) throw new RangeError('Broker Connect message too short');
            let offset = 0;
            const scope = readFixedString(data, offset, E133_SCOPE_STRING_PADDED_LENGTH);
            offset += E133_SCOPE_STRING_PADDED_LENGTH;
            const e133Version = data.readUInt16BE(offset);
            offset += 2;
            const searchDomain = readFixedString(data, offset, E133_DOMAIN_STRING_PADDED_LENGTH);
            offset += E133_DOMAIN_STRING_PADDED_LENGTH;
            const incrementalUpdates = (data.readUInt8(offset) & CONNECT_FLAG_INCREMENTAL_UPDATES) !== 0;
            offset += 1;
            const {entry} = decodeClientEntry(data, offset);
            return {vector, scope, e133Version, searchDomain, incrementalUpdates, clientEntry: entry};
        }
        case BrokerVector.ConnectReply: {
            if (data.length < 16) throw new RangeError('Broker Connect Reply message too short');
            return {
                vector,
                connectionStatus: data.readUInt16BE(0),
                e133Version: data.readUInt16BE(2),
                brokerUid: uidFromBuffer(data, 4),
                clientUid: uidFromBuffer(data, 10),
            };
        }
        case BrokerVector.ClientEntryUpdate: {
            if (data.length < 1) throw new RangeError('Broker Client Entry Update message too short');
            const incrementalUpdates = (data.readUInt8(0) & CONNECT_FLAG_INCREMENTAL_UPDATES) !== 0;
            const {entry} = decodeClientEntry(data, 1);
            return {vector, incrementalUpdates, clientEntry: entry};
        }
        case BrokerVector.ConnectedClientList:
        case BrokerVector.ClientAdd:
        case BrokerVector.ClientRemove:
        case BrokerVector.ClientEntryChange: {
            const clients: RptClientEntry[] = [];
            let offset = 0;
            while (offset < data.length) {
                const {entry, length: entryLength} = decodeClientEntry(data, offset);
                clients.push(entry);
                offset += entryLength;
            }
            return {vector, clients};
        }
        case BrokerVector.FetchClientList:
            return {vector};
        case BrokerVector.Null:
            return {vector};
        case BrokerVector.Disconnect: {
            if (data.length < 2) throw new RangeError('Broker Disconnect message too short');
            return {vector, reason: data.readUInt16BE(0)};
        }
        case BrokerVector.RedirectV4: {
            if (data.length < 6) throw new RangeError('Broker Redirect V4 message too short');
            return {
                vector,
                address: `${data[0]}.${data[1]}.${data[2]}.${data[3]}`,
                port: data.readUInt16BE(4),
            };
        }
        default:
            throw new Error(`Unsupported broker vector 0x${vector.toString(16)}`);
    }
};
