/**
 * RDMnet broker/session message helpers.
 * @module rdmnet/broker
 */

export enum BrokerVector {
    ConnectRequest = 0x00000001,
    ConnectReply = 0x00000002,
    ClientBindRequest = 0x00000003,
    ClientBindReply = 0x00000004,
    Heartbeat = 0x00000005,
    Disconnect = 0x00000006,
    ClientListRequest = 0x00000007,
    ClientListReply = 0x00000008,
    EndpointListRequest = 0x00000009,
    EndpointListReply = 0x0000000a,
}

export enum BrokerClientRole {
    Controller = 0x01,
    Device = 0x02,
    Monitor = 0x03,
}

export enum BrokerStatusCode {
    Ok = 0x0000,
    Rejected = 0x0001,
    InvalidScope = 0x0002,
    Unauthorized = 0x0003,
    AlreadyConnected = 0x0004,
    InvalidRequest = 0x0005,
}

export enum BrokerDisconnectReason {
    Graceful = 0x0000,
    BrokerShutdown = 0x0001,
    Timeout = 0x0002,
    ProtocolError = 0x0003,
}

export enum BrokerSessionState {
    Disconnected = 'disconnected',
    TcpConnected = 'tcp_connected',
    Connecting = 'broker_connecting',
    Connected = 'broker_connected',
    Binding = 'broker_binding',
    Bound = 'broker_bound',
    Error = 'broker_error',
}

export class BrokerStatusError extends Error {
    public readonly code: BrokerStatusCode;

    constructor(code: BrokerStatusCode, message?: string) {
        super(message ?? `Broker returned status code ${code}`);
        this.name = 'BrokerStatusError';
        this.code = code;
    }
}

export type BrokerConnectRequest = {
    vector: BrokerVector.ConnectRequest;
    sequence: number;
    role: BrokerClientRole;
    scope: string;
};

export type BrokerConnectReply = {
    vector: BrokerVector.ConnectReply;
    sequence: number;
    statusCode: BrokerStatusCode;
    clientId: number;
    text?: string;
};

export type BrokerBindRequest = {
    vector: BrokerVector.ClientBindRequest;
    sequence: number;
    endpointId: number;
    requestedRole?: BrokerClientRole;
    profiles?: number[];
};

export type BrokerBindReply = {
    vector: BrokerVector.ClientBindReply;
    sequence: number;
    statusCode: BrokerStatusCode;
    endpointId: number;
    negotiatedRole?: BrokerClientRole;
    negotiatedProfile?: number;
    text?: string;
};

export type BrokerHeartbeatMessage = {
    vector: BrokerVector.Heartbeat;
    sequence: number;
};

export type BrokerDisconnectMessage = {
    vector: BrokerVector.Disconnect;
    sequence: number;
    reason: BrokerDisconnectReason;
    text?: string;
};

export type BrokerClientListRequest = {
    vector: BrokerVector.ClientListRequest;
    sequence: number;
};

export type BrokerClientListReply = {
    vector: BrokerVector.ClientListReply;
    sequence: number;
    statusCode: BrokerStatusCode;
    clients: number[];
};

export type BrokerEndpointListRequest = {
    vector: BrokerVector.EndpointListRequest;
    sequence: number;
};

export type BrokerEndpointListReply = {
    vector: BrokerVector.EndpointListReply;
    sequence: number;
    statusCode: BrokerStatusCode;
    endpoints: number[];
};

export type BrokerMessage =
    | BrokerConnectRequest
    | BrokerConnectReply
    | BrokerBindRequest
    | BrokerBindReply
    | BrokerHeartbeatMessage
    | BrokerDisconnectMessage
    | BrokerClientListRequest
    | BrokerClientListReply
    | BrokerEndpointListRequest
    | BrokerEndpointListReply;

const VALID_BROKER_ROLES = new Set<number>([
    BrokerClientRole.Controller,
    BrokerClientRole.Device,
    BrokerClientRole.Monitor,
]);

const VALID_BROKER_STATUS_CODES = new Set<number>([
    BrokerStatusCode.Ok,
    BrokerStatusCode.Rejected,
    BrokerStatusCode.InvalidScope,
    BrokerStatusCode.Unauthorized,
    BrokerStatusCode.AlreadyConnected,
    BrokerStatusCode.InvalidRequest,
]);

const VALID_BROKER_DISCONNECT_REASONS = new Set<number>([
    BrokerDisconnectReason.Graceful,
    BrokerDisconnectReason.BrokerShutdown,
    BrokerDisconnectReason.Timeout,
    BrokerDisconnectReason.ProtocolError,
]);

function writeTextBlock(buffer: Buffer, offset: number, text?: string): number {
    const bytes = Buffer.from(text ?? '', 'utf8');
    buffer.writeUInt16BE(bytes.length & 0xffff, offset);
    bytes.copy(buffer, offset + 2);
    return 2 + bytes.length;
}

function readTextBlock(buffer: Buffer, offset: number): string {
    if (offset + 2 > buffer.length) return '';
    const length = buffer.readUInt16BE(offset);
    if (offset + 2 + length > buffer.length) {
        throw new RangeError('Broker text block exceeds packet length');
    }
    return buffer.toString('utf8', offset + 2, offset + 2 + length);
}

export const encodeBrokerMessage = (message: BrokerMessage): Buffer => {
    if (message.vector === BrokerVector.ConnectRequest) {
        const scopeBytes = Buffer.from(message.scope, 'utf8');
        const out = Buffer.alloc(12 + scopeBytes.length);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt8(message.role & 0xff, 8);
        out.writeUInt8(0, 9);
        out.writeUInt16BE(scopeBytes.length & 0xffff, 10);
        scopeBytes.copy(out, 12);
        return out;
    }

    if (message.vector === BrokerVector.ConnectReply) {
        const textBytes = Buffer.from(message.text ?? '', 'utf8');
        const out = Buffer.alloc(14 + textBytes.length);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.statusCode & 0xffff, 8);
        out.writeUInt32BE(message.clientId >>> 0, 10);
        textBytes.copy(out, 14);
        return out;
    }

    if (message.vector === BrokerVector.ClientBindRequest) {
        const profiles = message.profiles ?? [];
        if (profiles.length > 255) {
            throw new RangeError(`Broker bind profiles max length is 255, got ${profiles.length}`);
        }
        const out = Buffer.alloc(12 + profiles.length * 2);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.endpointId & 0xffff, 8);
        out.writeUInt8((message.requestedRole ?? BrokerClientRole.Controller) & 0xff, 10);
        out.writeUInt8(profiles.length & 0xff, 11);
        for (let i = 0; i < profiles.length; i++) {
            out.writeUInt16BE(profiles[i]! & 0xffff, 12 + i * 2);
        }
        return out;
    }

    if (message.vector === BrokerVector.ClientBindReply) {
        const textBytes = Buffer.from(message.text ?? '', 'utf8');
        const out = Buffer.alloc(18 + textBytes.length);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.statusCode & 0xffff, 8);
        out.writeUInt16BE(message.endpointId & 0xffff, 10);
        out.writeUInt8((message.negotiatedRole ?? BrokerClientRole.Controller) & 0xff, 12);
        out.writeUInt8(0, 13);
        out.writeUInt16BE((message.negotiatedProfile ?? 0) & 0xffff, 14);
        out.writeUInt16BE(textBytes.length & 0xffff, 16);
        textBytes.copy(out, 18);
        return out;
    }

    if (message.vector === BrokerVector.Heartbeat) {
        const out = Buffer.alloc(8);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        return out;
    }

    if (message.vector === BrokerVector.ClientListRequest || message.vector === BrokerVector.EndpointListRequest) {
        const out = Buffer.alloc(8);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        return out;
    }

    if (message.vector === BrokerVector.ClientListReply) {
        if (message.clients.length > 255) {
            throw new RangeError(`Broker client list max length is 255, got ${message.clients.length}`);
        }
        const out = Buffer.alloc(11 + message.clients.length * 4);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.statusCode & 0xffff, 8);
        out.writeUInt8(message.clients.length & 0xff, 10);
        for (let i = 0; i < message.clients.length; i++) {
            out.writeUInt32BE(message.clients[i]! >>> 0, 11 + i * 4);
        }
        return out;
    }

    if (message.vector === BrokerVector.EndpointListReply) {
        if (message.endpoints.length > 255) {
            throw new RangeError(`Broker endpoint list max length is 255, got ${message.endpoints.length}`);
        }
        const out = Buffer.alloc(11 + message.endpoints.length * 2);
        out.writeUInt32BE(message.vector, 0);
        out.writeUInt32BE(message.sequence >>> 0, 4);
        out.writeUInt16BE(message.statusCode & 0xffff, 8);
        out.writeUInt8(message.endpoints.length & 0xff, 10);
        for (let i = 0; i < message.endpoints.length; i++) {
            out.writeUInt16BE(message.endpoints[i]! & 0xffff, 11 + i * 2);
        }
        return out;
    }

    const out = Buffer.alloc(12 + Buffer.byteLength(message.text ?? '', 'utf8'));
    out.writeUInt32BE(message.vector, 0);
    out.writeUInt32BE(message.sequence >>> 0, 4);
    out.writeUInt16BE(message.reason & 0xffff, 8);
    writeTextBlock(out, 10, message.text);
    return out;
};

export const decodeBrokerMessage = (buffer: Buffer): BrokerMessage => {
    if (buffer.length < 8) {
        throw new RangeError(`Broker message too short: ${buffer.length}`);
    }
    const vector = buffer.readUInt32BE(0);
    const sequence = buffer.readUInt32BE(4);

    if (vector === BrokerVector.ConnectRequest) {
        if (buffer.length < 12) throw new RangeError('Broker connect request too short');
        const roleRaw = buffer.readUInt8(8);
        if (!VALID_BROKER_ROLES.has(roleRaw)) {
            throw new RangeError(`Broker connect request has invalid role ${roleRaw}`);
        }
        if (buffer.readUInt8(9) !== 0) {
            throw new RangeError('Broker connect request reserved byte must be 0');
        }
        const scopeLength = buffer.readUInt16BE(10);
        if (12 + scopeLength > buffer.length) throw new RangeError('Broker connect request scope exceeds packet length');
        if (12 + scopeLength !== buffer.length) throw new RangeError('Broker connect request has trailing bytes');
        return {
            vector,
            sequence,
            role: roleRaw as BrokerClientRole,
            scope: buffer.toString('utf8', 12, 12 + scopeLength),
        };
    }

    if (vector === BrokerVector.ConnectReply) {
        if (buffer.length < 14) throw new RangeError('Broker connect reply too short');
        const statusCode = buffer.readUInt16BE(8);
        if (!VALID_BROKER_STATUS_CODES.has(statusCode)) {
            throw new RangeError(`Broker connect reply has invalid status code ${statusCode}`);
        }
        return {
            vector,
            sequence,
            statusCode: statusCode as BrokerStatusCode,
            clientId: buffer.readUInt32BE(10),
            text: buffer.length > 14 ? buffer.toString('utf8', 14) : '',
        };
    }

    if (vector === BrokerVector.ClientBindRequest) {
        if (buffer.length < 12) throw new RangeError('Broker bind request too short');
        const requestedRole = buffer.readUInt8(10);
        if (!VALID_BROKER_ROLES.has(requestedRole)) {
            throw new RangeError(`Broker bind request has invalid role ${requestedRole}`);
        }
        const profileCount = buffer.readUInt8(11);
        if (12 + profileCount * 2 > buffer.length) {
            throw new RangeError('Broker bind request profile list exceeds packet length');
        }
        if (12 + profileCount * 2 !== buffer.length) {
            throw new RangeError('Broker bind request has trailing bytes');
        }
        const profiles: number[] = [];
        for (let i = 0; i < profileCount; i++) {
            profiles.push(buffer.readUInt16BE(12 + i * 2));
        }
        return {
            vector,
            sequence,
            endpointId: buffer.readUInt16BE(8),
            requestedRole: requestedRole as BrokerClientRole,
            profiles,
        };
    }

    if (vector === BrokerVector.ClientBindReply) {
        if (buffer.length < 18) throw new RangeError('Broker bind reply too short');
        const statusCode = buffer.readUInt16BE(8);
        if (!VALID_BROKER_STATUS_CODES.has(statusCode)) {
            throw new RangeError(`Broker bind reply has invalid status code ${statusCode}`);
        }
        const negotiatedRole = buffer.readUInt8(12);
        if (!VALID_BROKER_ROLES.has(negotiatedRole)) {
            throw new RangeError(`Broker bind reply has invalid role ${negotiatedRole}`);
        }
        if (buffer.readUInt8(13) !== 0) {
            throw new RangeError('Broker bind reply reserved byte must be 0');
        }
        const textLength = buffer.readUInt16BE(16);
        if (18 + textLength > buffer.length) throw new RangeError('Broker bind reply text exceeds packet length');
        if (18 + textLength !== buffer.length) throw new RangeError('Broker bind reply has trailing bytes');
        return {
            vector,
            sequence,
            statusCode: statusCode as BrokerStatusCode,
            endpointId: buffer.readUInt16BE(10),
            negotiatedRole: negotiatedRole as BrokerClientRole,
            negotiatedProfile: buffer.readUInt16BE(14),
            text: buffer.toString('utf8', 18, 18 + textLength),
        };
    }

    if (vector === BrokerVector.Heartbeat) {
        if (buffer.length !== 8) throw new RangeError('Broker heartbeat has invalid length');
        return {vector, sequence};
    }

    if (vector === BrokerVector.ClientListRequest || vector === BrokerVector.EndpointListRequest) {
        if (buffer.length !== 8) throw new RangeError('Broker list request has invalid length');
        return {vector, sequence};
    }

    if (vector === BrokerVector.ClientListReply) {
        if (buffer.length < 11) throw new RangeError('Broker client list reply too short');
        const statusCode = buffer.readUInt16BE(8);
        if (!VALID_BROKER_STATUS_CODES.has(statusCode)) {
            throw new RangeError(`Broker client list reply has invalid status code ${statusCode}`);
        }
        const count = buffer.readUInt8(10);
        if (11 + count * 4 > buffer.length) throw new RangeError('Broker client list reply exceeds packet length');
        if (11 + count * 4 !== buffer.length) throw new RangeError('Broker client list reply has trailing bytes');
        const clients: number[] = [];
        for (let i = 0; i < count; i++) {
            clients.push(buffer.readUInt32BE(11 + i * 4));
        }
        return {
            vector,
            sequence,
            statusCode: statusCode as BrokerStatusCode,
            clients,
        };
    }

    if (vector === BrokerVector.EndpointListReply) {
        if (buffer.length < 11) throw new RangeError('Broker endpoint list reply too short');
        const statusCode = buffer.readUInt16BE(8);
        if (!VALID_BROKER_STATUS_CODES.has(statusCode)) {
            throw new RangeError(`Broker endpoint list reply has invalid status code ${statusCode}`);
        }
        const count = buffer.readUInt8(10);
        if (11 + count * 2 > buffer.length) throw new RangeError('Broker endpoint list reply exceeds packet length');
        if (11 + count * 2 !== buffer.length) throw new RangeError('Broker endpoint list reply has trailing bytes');
        const endpoints: number[] = [];
        for (let i = 0; i < count; i++) {
            endpoints.push(buffer.readUInt16BE(11 + i * 2));
        }
        return {
            vector,
            sequence,
            statusCode: statusCode as BrokerStatusCode,
            endpoints,
        };
    }

    if (vector === BrokerVector.Disconnect) {
        if (buffer.length < 12) throw new RangeError('Broker disconnect too short');
        const reason = buffer.readUInt16BE(8);
        if (!VALID_BROKER_DISCONNECT_REASONS.has(reason)) {
            throw new RangeError(`Broker disconnect has invalid reason ${reason}`);
        }
        const textLength = buffer.readUInt16BE(10);
        if (12 + textLength > buffer.length) throw new RangeError('Broker disconnect text exceeds packet length');
        if (12 + textLength !== buffer.length) throw new RangeError('Broker disconnect has trailing bytes');
        return {
            vector,
            sequence,
            reason: reason as BrokerDisconnectReason,
            text: readTextBlock(buffer, 10),
        };
    }

    throw new Error(`Unsupported broker vector 0x${vector.toString(16)}`);
};
