import {EventEmitter} from 'events';
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';

class MockSocket extends EventEmitter {
    public writes: Buffer[] = [];
    public ended = false;
    public destroyed = false;

    public write(chunk: Buffer | Uint8Array, cb?: (err?: Error | null) => void): boolean {
        this.writes.push(Buffer.from(chunk));
        cb?.(null);
        return true;
    }

    public end(): void {
        this.ended = true;
        this.destroyed = true;
        this.emit('close', false);
    }

    public destroy(error?: Error): this {
        this.destroyed = true;
        if (error) this.emit('error', error);
        this.emit('close', !!error);
        return this;
    }
}

class MockTlsSocket extends MockSocket {
    public authorized = true;
    public authorizationError: Error | null = null;
}

const sockets: MockSocket[] = [];
const tlsSockets: MockTlsSocket[] = [];

vi.mock('net', () => ({
    createConnection: vi.fn(() => {
        const socket = new MockSocket();
        sockets.push(socket);
        return socket;
    }),
}));

vi.mock('tls', () => ({
    connect: vi.fn(() => {
        const socket = new MockTlsSocket();
        tlsSockets.push(socket);
        return socket;
    }),
}));

import {
    BrokerClientRole,
    BrokerDisconnectReason,
    BrokerSessionState,
    BrokerStatusCode,
    BrokerVector,
    buildRdmnetPacket,
    decodeEptMessage,
    decodeLlrpMessage,
    decodeBrokerMessage,
    encodeBrokerMessage,
    encodeEptMessage,
    encodeLlrpMessage,
    decodeRptMessage,
    encodeRptMessage,
    EptVector,
    extractRdmnetPackets,
    makeCid,
    parseRdmnetPacket,
    RdmCommandClass,
    RdmnetClient,
    RdmnetError,
    RdmnetRootVector,
    RdmResponseType,
    LlrpVector,
    RptVector,
} from '../src';

beforeEach(() => {
    sockets.length = 0;
    tlsSockets.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('RDMnet packet helpers', () => {
    it('builds and parses root-layer packets', () => {
        const cid = Buffer.alloc(16, 0x11);
        const built = buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: Buffer.from([1, 2, 3]),
            cid,
        });
        const parsed = parseRdmnetPacket(built);

        expect(parsed.vector).toBe(RdmnetRootVector.Rpt);
        expect(parsed.cid).toEqual(cid);
        expect(Array.from(parsed.data)).toEqual([1, 2, 3]);
    });

    it('extracts full packets from concatenated stream and keeps remainder', () => {
        const a = buildRdmnetPacket({vector: 1, data: Buffer.from([1])});
        const b = buildRdmnetPacket({vector: 2, data: Buffer.from([2, 3])});
        const stream = Buffer.concat([a, b.subarray(0, b.length - 1)]);
        const extracted = extractRdmnetPackets(stream);

        expect(extracted.packets.length).toBe(1);
        expect(extracted.packets[0]?.vector).toBe(1);
        expect(extracted.remainder.length).toBe(b.length - 1);
    });

    it('creates valid 16-byte CIDs', () => {
        expect(makeCid().length).toBe(16);
    });

    it('rejects invalid root layer length values', () => {
        const packet = buildRdmnetPacket({vector: 1, data: Buffer.alloc(0)});
        packet.writeUInt16BE(0x7001, 16);
        expect(() => parseRdmnetPacket(packet)).toThrow(RangeError);
    });

    it('rejects invalid root layer flags', () => {
        const packet = buildRdmnetPacket({vector: 1, data: Buffer.alloc(0)});
        packet.writeUInt16BE(0x6000 | ((packet.readUInt16BE(16)) & 0x0fff), 16);
        expect(() => parseRdmnetPacket(packet)).toThrow(/Invalid RDMnet flags/);
    });

    it('rejects root packets with trailing bytes', () => {
        const packet = buildRdmnetPacket({vector: 1, data: Buffer.from([1, 2, 3])});
        expect(() => parseRdmnetPacket(Buffer.concat([packet, Buffer.from([0])]))).toThrow(/trailing bytes/);
    });
});

describe('RPT helpers', () => {
    it('encodes and decodes status messages', () => {
        const encoded = encodeRptMessage({
            vector: RptVector.Status,
            sequence: 10,
            statusCode: 200,
            text: 'ok',
        });
        const decoded = decodeRptMessage(encoded);
        expect(decoded).toEqual({
            vector: RptVector.Status,
            sequence: 10,
            statusCode: 200,
            text: 'ok',
        });
    });

    it('encodes and decodes endpoint advertisement and ack', () => {
        const adv = encodeRptMessage({
            vector: RptVector.EndpointAdvertisement,
            sequence: 20,
            endpointId: 1,
            role: BrokerClientRole.Controller,
            profiles: [0x0100, 0x0101],
        });
        expect(decodeRptMessage(adv)).toEqual({
            vector: RptVector.EndpointAdvertisement,
            sequence: 20,
            endpointId: 1,
            role: BrokerClientRole.Controller,
            profiles: [0x0100, 0x0101],
        });

        const ack = encodeRptMessage({
            vector: RptVector.EndpointAdvertisementAck,
            sequence: 20,
            endpointId: 1,
            accepted: true,
            statusCode: 0,
        });
        expect(decodeRptMessage(ack)).toEqual({
            vector: RptVector.EndpointAdvertisementAck,
            sequence: 20,
            endpointId: 1,
            accepted: true,
            statusCode: 0,
        });
    });

    it('rejects RPT payloads with trailing bytes', () => {
        const status = encodeRptMessage({
            vector: RptVector.Status,
            sequence: 1,
            statusCode: 0,
            text: 'ok',
        });
        expect(() => decodeRptMessage(Buffer.concat([status, Buffer.from([0])]))).toThrow(/trailing bytes/);
    });

    it('rejects RPT endpoint ack with invalid accepted flag', () => {
        const ack = Buffer.from(encodeRptMessage({
            vector: RptVector.EndpointAdvertisementAck,
            sequence: 1,
            endpointId: 1,
            accepted: true,
            statusCode: 0,
        }));
        ack.writeUInt8(2, 10);
        expect(() => decodeRptMessage(ack)).toThrow(/invalid accepted flag/);
    });
});

describe('Broker helpers', () => {
    it('encodes and decodes broker connect request/reply', () => {
        const request = encodeBrokerMessage({
            vector: BrokerVector.ConnectRequest,
            sequence: 10,
            role: BrokerClientRole.Controller,
            scope: 'default',
        });
        expect(decodeBrokerMessage(request)).toEqual({
            vector: BrokerVector.ConnectRequest,
            sequence: 10,
            role: BrokerClientRole.Controller,
            scope: 'default',
        });

        const reply = encodeBrokerMessage({
            vector: BrokerVector.ConnectReply,
            sequence: 10,
            statusCode: BrokerStatusCode.Ok,
            clientId: 42,
            text: 'accepted',
        });
        expect(decodeBrokerMessage(reply)).toEqual({
            vector: BrokerVector.ConnectReply,
            sequence: 10,
            statusCode: BrokerStatusCode.Ok,
            clientId: 42,
            text: 'accepted',
        });
    });

    it('encodes and decodes broker client/endpoint list messages', () => {
        const clientListRequest = encodeBrokerMessage({
            vector: BrokerVector.ClientListRequest,
            sequence: 33,
        });
        expect(decodeBrokerMessage(clientListRequest)).toEqual({
            vector: BrokerVector.ClientListRequest,
            sequence: 33,
        });

        const clientListReply = encodeBrokerMessage({
            vector: BrokerVector.ClientListReply,
            sequence: 33,
            statusCode: BrokerStatusCode.Ok,
            clients: [1001, 1002],
        });
        expect(decodeBrokerMessage(clientListReply)).toEqual({
            vector: BrokerVector.ClientListReply,
            sequence: 33,
            statusCode: BrokerStatusCode.Ok,
            clients: [1001, 1002],
        });

        const endpointListRequest = encodeBrokerMessage({
            vector: BrokerVector.EndpointListRequest,
            sequence: 44,
        });
        expect(decodeBrokerMessage(endpointListRequest)).toEqual({
            vector: BrokerVector.EndpointListRequest,
            sequence: 44,
        });

        const endpointListReply = encodeBrokerMessage({
            vector: BrokerVector.EndpointListReply,
            sequence: 44,
            statusCode: BrokerStatusCode.Ok,
            endpoints: [1, 2, 3],
        });
        expect(decodeBrokerMessage(endpointListReply)).toEqual({
            vector: BrokerVector.EndpointListReply,
            sequence: 44,
            statusCode: BrokerStatusCode.Ok,
            endpoints: [1, 2, 3],
        });
    });

    it('rejects broker frames with invalid reserved fields and trailing bytes', () => {
        const connectRequest = Buffer.from(encodeBrokerMessage({
            vector: BrokerVector.ConnectRequest,
            sequence: 1,
            role: BrokerClientRole.Controller,
            scope: 'default',
        }));
        connectRequest.writeUInt8(1, 9);
        expect(() => decodeBrokerMessage(connectRequest)).toThrow(/reserved byte/);

        const heartbeat = Buffer.concat([
            encodeBrokerMessage({vector: BrokerVector.Heartbeat, sequence: 2}),
            Buffer.from([0]),
        ]);
        expect(() => decodeBrokerMessage(heartbeat)).toThrow(/invalid length/);
    });
});

describe('EPT/LLRP helpers', () => {
    it('encodes and decodes EPT data/status messages', () => {
        const data = encodeEptMessage({
            vector: EptVector.Data,
            sequence: 5,
            manufacturerId: 0x7a70,
            protocolId: 1,
            payload: Buffer.from([1, 2, 3]),
        });
        expect(decodeEptMessage(data)).toEqual({
            vector: EptVector.Data,
            sequence: 5,
            manufacturerId: 0x7a70,
            protocolId: 1,
            payload: Buffer.from([1, 2, 3]),
        });

        const status = encodeEptMessage({
            vector: EptVector.Status,
            sequence: 6,
            statusCode: 200,
            text: 'ok',
        });
        expect(decodeEptMessage(status)).toEqual({
            vector: EptVector.Status,
            sequence: 6,
            statusCode: 200,
            text: 'ok',
        });
    });

    it('encodes and decodes LLRP probe/rdm messages', () => {
        const probe = encodeLlrpMessage({
            vector: LlrpVector.ProbeRequest,
            sequence: 1,
            lowerUid: Buffer.from([0, 0, 0, 0, 0, 0]),
            upperUid: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        });
        expect(decodeLlrpMessage(probe)).toEqual({
            vector: LlrpVector.ProbeRequest,
            sequence: 1,
            lowerUid: Buffer.from([0, 0, 0, 0, 0, 0]),
            upperUid: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        });

        const rdm = encodeLlrpMessage({
            vector: LlrpVector.RdmCommand,
            sequence: 2,
            targetUid: Buffer.from([1, 2, 3, 4, 5, 6]),
            rdm: Buffer.from([0xcc, 0x01, 0x18]),
        });
        expect(decodeLlrpMessage(rdm)).toEqual({
            vector: LlrpVector.RdmCommand,
            sequence: 2,
            targetUid: Buffer.from([1, 2, 3, 4, 5, 6]),
            rdm: Buffer.from([0xcc, 0x01, 0x18]),
        });
    });

    it('rejects EPT/LLRP payloads with trailing bytes', () => {
        const ept = Buffer.concat([
            encodeEptMessage({
                vector: EptVector.Status,
                sequence: 1,
                statusCode: 0,
                text: 'ok',
            }),
            Buffer.from([0]),
        ]);
        expect(() => decodeEptMessage(ept)).toThrow(/trailing bytes/);

        const llrp = Buffer.concat([
            encodeLlrpMessage({
                vector: LlrpVector.ProbeReply,
                sequence: 1,
                targetUid: Buffer.from([1, 2, 3, 4, 5, 6]),
            }),
            Buffer.from([0]),
        ]);
        expect(() => decodeLlrpMessage(llrp)).toThrow(/trailing bytes/);
    });
});

describe('RdmnetClient', () => {
    it('connects, sends, receives and disconnects', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connected = new Promise<void>((resolve) => client.once('connect', () => resolve()));

        const connectPromise = client.connect();
        const socket = sockets[0];
        expect(socket).toBeDefined();
        socket.emit('connect');
        await connectPromise;
        await connected;

        await client.sendPacket({
            vector: RdmnetRootVector.Broker,
            data: Buffer.from([9]),
        });
        expect(socket.writes.length).toBe(1);

        const message = new Promise<number>((resolve) => {
            client.once('message', (packet) => resolve(packet.vector));
        });
        const inbound = buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            data: encodeLlrpMessage({
                vector: LlrpVector.ProbeReply,
                sequence: 1,
                targetUid: Buffer.from([1, 2, 3, 4, 5, 6]),
            }),
        });
        socket.emit('data', inbound);
        await expect(message).resolves.toBe(RdmnetRootVector.Llrp);

        client.disconnect();
        expect(socket.ended).toBe(true);
    });

    it('connects over TLS and emits secureConnect', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', transport: 'tls'});
        const secureEvent = new Promise<[boolean, Error | string | null | undefined]>((resolve) => {
            client.once('secureConnect', (authorized, authError) => resolve([authorized, authError]));
        });

        const connectPromise = client.connect();
        const tlsSocket = tlsSockets[0];
        expect(tlsSocket).toBeDefined();
        tlsSocket.emit('secureConnect');
        await connectPromise;
        await expect(secureEvent).resolves.toEqual([true, null]);
    });

    it('rejects unauthorized TLS peer when strict authorization is enabled', async () => {
        const client = new RdmnetClient({
            host: '127.0.0.1',
            transport: 'tls',
            requireTlsAuthorization: true,
        });
        const connectPromise = client.connect();
        const tlsSocket = tlsSockets[0];
        expect(tlsSocket).toBeDefined();
        tlsSocket.authorized = false;
        tlsSocket.authorizationError = new Error('self signed certificate');
        tlsSocket.emit('secureConnect');
        await expect(connectPromise).rejects.toThrow(/TLS peer authorization failed/);
    });

    it('supports request/response matching', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const response = client.sendRequest(
            {vector: RdmnetRootVector.Broker, data: Buffer.from([1])},
            (packet) => packet.vector === RdmnetRootVector.Rpt,
            1000,
        );
        await Promise.resolve();
        expect(socket.writes.length).toBe(1);
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.Status,
                sequence: 1,
                statusCode: 0,
                text: '',
            }),
        }));

        await expect(response).resolves.toMatchObject({vector: RdmnetRootVector.Rpt});
    });

    it('emits reconnecting and retries when autoReconnect is enabled', async () => {
        vi.useFakeTimers();
        const client = new RdmnetClient({
            host: '127.0.0.1',
            autoReconnect: true,
            reconnectDelayMs: 100,
            reconnectMaxDelayMs: 100,
        });
        const reconnecting = new Promise<number>((resolve) => {
            client.once('reconnecting', (attempt) => resolve(attempt));
        });

        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        socket.emit('close', true);
        await expect(reconnecting).resolves.toBe(1);

        await vi.advanceTimersByTimeAsync(101);
        expect(sockets.length).toBe(2);
    });

    it('supports correlated rdmTransaction over RPT', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const request = {
            destinationUid: {manufacturerId: 0x1234, deviceId: 0x01020304},
            sourceUid: {manufacturerId: 0x5678, deviceId: 0x05060708},
            transactionNumber: 1,
            portId: 1,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: 0x0060,
            parameterData: Buffer.alloc(0),
        };

        const transaction = client.rdmTransaction(request, 1, 1000);
        await Promise.resolve();
        expect(socket.writes.length).toBe(1);

        const sentRoot = parseRdmnetPacket(socket.writes[0]);
        const sentRpt = decodeRptMessage(sentRoot.data);
        expect(sentRpt.vector).toBe(RptVector.RdmCommand);
        if (sentRpt.vector !== RptVector.RdmCommand) {
            throw new Error('Expected RPT RDM command');
        }

        const inboundRpt = encodeRptMessage({
            vector: RptVector.RdmResponse,
            sequence: sentRpt.sequence,
            endpointId: 1,
            response: {
                destinationUid: request.sourceUid,
                sourceUid: request.destinationUid,
                transactionNumber: request.transactionNumber,
                responseType: RdmResponseType.ACK,
                messageCount: 0,
                subDevice: 0,
                commandClass: RdmCommandClass.GET_COMMAND_RESPONSE,
                pid: request.pid,
                parameterData: Buffer.from([1, 2, 3, 4]),
            },
        });
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: inboundRpt,
        }));

        await expect(transaction).resolves.toMatchObject({
            transactionNumber: 1,
            pid: 0x0060,
        });
    });

    it('runs broker session state machine through connect+bind', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const stateChanges: BrokerSessionState[] = [];
        client.on('brokerState', (state) => stateChanges.push(state));

        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.TcpConnected);

        const sessionStart = client.startBrokerSession({scope: 'default', endpointId: 1, autoBind: true});
        await Promise.resolve();
        expect(socket.writes.length).toBe(1);
        const connectReqRoot = parseRdmnetPacket(socket.writes[0]);
        const connectReq = decodeBrokerMessage(connectReqRoot.data);
        expect(connectReq.vector).toBe(BrokerVector.ConnectRequest);
        if (connectReq.vector !== BrokerVector.ConnectRequest) throw new Error('Expected connect request');

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                sequence: connectReq.sequence,
                statusCode: BrokerStatusCode.Ok,
                clientId: 99,
                text: 'ok',
            }),
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(socket.writes.length).toBe(2);

        const bindReqRoot = parseRdmnetPacket(socket.writes[1]);
        const bindReq = decodeBrokerMessage(bindReqRoot.data);
        expect(bindReq.vector).toBe(BrokerVector.ClientBindRequest);
        if (bindReq.vector !== BrokerVector.ClientBindRequest) throw new Error('Expected bind request');
        expect(bindReq.requestedRole).toBe(BrokerClientRole.Controller);

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ClientBindReply,
                sequence: bindReq.sequence,
                statusCode: BrokerStatusCode.Ok,
                endpointId: bindReq.endpointId,
                negotiatedRole: BrokerClientRole.Controller,
                negotiatedProfile: 0x0100,
                text: 'bound',
            }),
        }));

        await sessionStart;
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Bound);
        expect(client.getBrokerClientId()).toBe(99);
        expect(client.getBrokerNegotiatedRole()).toBe(BrokerClientRole.Controller);
        expect(client.getBrokerNegotiatedProfile()).toBe(0x0100);
        expect(stateChanges).toContain(BrokerSessionState.Connecting);
        expect(stateChanges).toContain(BrokerSessionState.Binding);
        expect(stateChanges).toContain(BrokerSessionState.Bound);
    });

    it('throws mapped RdmnetError when broker rejects connect', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const sessionStart = client.startBrokerSession({scope: 'invalid', autoBind: false});
        await Promise.resolve();
        const reqRoot = parseRdmnetPacket(socket.writes[0]);
        const req = decodeBrokerMessage(reqRoot.data);
        if (req.vector !== BrokerVector.ConnectRequest) throw new Error('Expected connect request');

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                sequence: req.sequence,
                statusCode: BrokerStatusCode.InvalidScope,
                clientId: 0,
                text: 'scope not found',
            }),
        }));

        await expect(sessionStart).rejects.toMatchObject({
            name: 'RdmnetError',
            domain: 'broker',
            code: 'BROKER_INVALID_SCOPE',
        });
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Error);
    });

    it('sends broker disconnect and returns to tcp_connected state', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const sessionStart = client.startBrokerSession({autoBind: false});
        await Promise.resolve();
        const reqRoot = parseRdmnetPacket(socket.writes[0]);
        const req = decodeBrokerMessage(reqRoot.data);
        if (req.vector !== BrokerVector.ConnectRequest) throw new Error('Expected connect request');
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                sequence: req.sequence,
                statusCode: BrokerStatusCode.Ok,
                clientId: 10,
            }),
        }));
        await sessionStart;

        await client.stopBrokerSession(BrokerDisconnectReason.Graceful, 'bye');
        const disconnectRoot = parseRdmnetPacket(socket.writes[socket.writes.length - 1]);
        const disconnect = decodeBrokerMessage(disconnectRoot.data);
        expect(disconnect.vector).toBe(BrokerVector.Disconnect);
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.TcpConnected);
    });

    it('sends and receives EPT messages', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        await client.sendEptMessage({
            vector: EptVector.Data,
            sequence: 1,
            manufacturerId: 0x7a70,
            protocolId: 1,
            payload: Buffer.from([9, 8, 7]),
        });
        const outbound = parseRdmnetPacket(socket.writes[0]);
        expect(outbound.vector).toBe(RdmnetRootVector.Ept);

        const inboundPromise = new Promise((resolve) => client.once('eptMessage', resolve));
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Ept,
            data: encodeEptMessage({
                vector: EptVector.Status,
                sequence: 2,
                statusCode: 100,
                text: 'ack',
            }),
        }));
        await expect(inboundPromise).resolves.toMatchObject({vector: EptVector.Status});
    });

    it('sends and receives LLRP messages', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        await client.sendLlrpMessage({
            vector: LlrpVector.ProbeReply,
            sequence: 1,
            targetUid: Buffer.from([1, 1, 1, 1, 1, 1]),
        });
        const outbound = parseRdmnetPacket(socket.writes[0]);
        expect(outbound.vector).toBe(RdmnetRootVector.Llrp);

        const inboundPromise = new Promise((resolve) => client.once('llrpMessage', resolve));
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            data: encodeLlrpMessage({
                vector: LlrpVector.ProbeReply,
                sequence: 3,
                targetUid: Buffer.from([2, 2, 2, 2, 2, 2]),
            }),
        }));
        await expect(inboundPromise).resolves.toMatchObject({vector: LlrpVector.ProbeReply});
    });

    it('collects LLRP probe replies within timeout window', async () => {
        vi.useFakeTimers();
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const lower = Buffer.from([0, 0, 0, 0, 0, 0]);
        const upper = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        const probePromise = client.discoverLlrpTargets(lower, upper, 100);
        await Promise.resolve();
        expect(socket.writes.length).toBe(1);

        const probeRoot = parseRdmnetPacket(socket.writes[0]);
        const probe = decodeLlrpMessage(probeRoot.data);
        expect(probe.vector).toBe(LlrpVector.ProbeRequest);
        if (probe.vector !== LlrpVector.ProbeRequest) throw new Error('Expected probe request');

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            data: encodeLlrpMessage({
                vector: LlrpVector.ProbeReply,
                sequence: probe.sequence,
                targetUid: Buffer.from([1, 2, 3, 4, 5, 6]),
            }),
        }));
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            data: encodeLlrpMessage({
                vector: LlrpVector.ProbeReply,
                sequence: probe.sequence,
                targetUid: Buffer.from([1, 2, 3, 4, 5, 6]),
            }),
        }));
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            data: encodeLlrpMessage({
                vector: LlrpVector.ProbeReply,
                sequence: probe.sequence,
                targetUid: Buffer.from([6, 5, 4, 3, 2, 1]),
            }),
        }));

        await vi.advanceTimersByTimeAsync(101);
        await expect(probePromise).resolves.toHaveLength(2);
    });

    it('emits structured decode errors for malformed protocol payloads', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const errorPromise = new Promise((resolve) => client.once('error', resolve));
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Llrp,
            data: Buffer.alloc(0),
        }));
        const err = await errorPromise;
        expect(err).toBeInstanceOf(RdmnetError);
        expect(err).toMatchObject({
            domain: 'llrp',
            code: 'LLRP_DECODE_ERROR',
        });
    });

    it('supports endpoint advertisement request/ack flow', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const sequence = await client.sendEndpointAdvertisement(1, BrokerClientRole.Controller, [0x0100]);
        const outbound = parseRdmnetPacket(socket.writes[0]);
        const rpt = decodeRptMessage(outbound.data);
        expect(rpt.vector).toBe(RptVector.EndpointAdvertisement);

        const ackPromise = client.waitForEndpointAdvertisementAck(sequence, 1, 1000);
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.EndpointAdvertisementAck,
                sequence,
                endpointId: 1,
                accepted: true,
                statusCode: 0,
            }),
        }));
        await expect(ackPromise).resolves.toMatchObject({accepted: true, statusCode: 0});
        expect(client.getEndpointCapabilities(1)).toMatchObject({
            endpointId: 1,
            role: BrokerClientRole.Controller,
            profiles: [0x0100],
            source: 'local_advertisement',
        });
    });

    it('rejects broker negotiation when profile is outside requested set', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const sessionStart = client.startBrokerSession({
            autoBind: true,
            endpointRole: BrokerClientRole.Controller,
            profiles: [0x0100],
            strictNegotiation: true,
        });
        await Promise.resolve();
        const connectReqRoot = parseRdmnetPacket(socket.writes[0]);
        const connectReq = decodeBrokerMessage(connectReqRoot.data);
        if (connectReq.vector !== BrokerVector.ConnectRequest) throw new Error('Expected connect request');
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                sequence: connectReq.sequence,
                statusCode: BrokerStatusCode.Ok,
                clientId: 55,
            }),
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const bindReqRoot = parseRdmnetPacket(socket.writes[1]);
        const bindReq = decodeBrokerMessage(bindReqRoot.data);
        if (bindReq.vector !== BrokerVector.ClientBindRequest) throw new Error('Expected bind request');
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ClientBindReply,
                sequence: bindReq.sequence,
                statusCode: BrokerStatusCode.Ok,
                endpointId: bindReq.endpointId,
                negotiatedRole: BrokerClientRole.Controller,
                negotiatedProfile: 0x0200,
                text: 'different profile',
            }),
        }));

        await expect(sessionStart).rejects.toMatchObject({
            name: 'RdmnetError',
            domain: 'negotiation',
            code: 'NEGOTIATION_PROFILE_MISMATCH',
        });
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Error);
    });

    it('tracks remote endpoint capability advertisements and clears on disconnect', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const updates: number[] = [];
        client.on('endpointCapabilitiesUpdated', (endpointId) => updates.push(endpointId));
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.EndpointAdvertisement,
                sequence: 9,
                endpointId: 7,
                role: BrokerClientRole.Monitor,
                profiles: [0x0200, 0x0201],
            }),
        }));

        const caps = client.getEndpointCapabilities(7);
        expect(caps).toMatchObject({
            endpointId: 7,
            role: BrokerClientRole.Monitor,
            profiles: [0x0200, 0x0201],
            source: 'remote_advertisement',
        });
        expect(updates).toEqual([7]);
        expect(client.listEndpointCapabilities().length).toBe(1);

        client.disconnect();
        expect(client.listEndpointCapabilities()).toEqual([]);
    });

    it('requests broker client and endpoint lists', async () => {
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const clientListPromise = client.requestBrokerClientList(1000);
        await Promise.resolve();
        const clientReqRoot = parseRdmnetPacket(socket.writes[0]);
        const clientReq = decodeBrokerMessage(clientReqRoot.data);
        expect(clientReq.vector).toBe(BrokerVector.ClientListRequest);
        if (clientReq.vector !== BrokerVector.ClientListRequest) throw new Error('Expected client list request');
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ClientListReply,
                sequence: clientReq.sequence,
                statusCode: BrokerStatusCode.Ok,
                clients: [11, 22],
            }),
        }));
        await expect(clientListPromise).resolves.toEqual([11, 22]);

        const endpointListPromise = client.requestBrokerEndpointList(1000);
        await Promise.resolve();
        const endpointReqRoot = parseRdmnetPacket(socket.writes[1]);
        const endpointReq = decodeBrokerMessage(endpointReqRoot.data);
        expect(endpointReq.vector).toBe(BrokerVector.EndpointListRequest);
        if (endpointReq.vector !== BrokerVector.EndpointListRequest) throw new Error('Expected endpoint list request');
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.EndpointListReply,
                sequence: endpointReq.sequence,
                statusCode: BrokerStatusCode.Ok,
                endpoints: [1, 3, 5],
            }),
        }));
        await expect(endpointListPromise).resolves.toEqual([1, 3, 5]);
    });

    it('returns structured timeout errors from waitForMessage', async () => {
        vi.useFakeTimers();
        const client = new RdmnetClient({host: '127.0.0.1'});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const wait = client.waitForMessage(() => false, 10);
        const assertion = expect(wait).rejects.toMatchObject({
            domain: 'timeout',
            code: 'RESPONSE_TIMEOUT',
        });
        await vi.advanceTimersByTimeAsync(11);
        await assertion;
    });
});
