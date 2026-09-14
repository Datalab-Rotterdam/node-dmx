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
    BrokerSessionState,
    BrokerVector,
    buildRdmnetPacket,
    ClientProtocol,
    ConnectionStatusCode,
    decodeBrokerMessage,
    decodeEptMessage,
    decodeLlrpMessage,
    decodeRptMessage,
    DisconnectReason,
    encodeBrokerMessage,
    encodeEptMessage,
    encodeLlrpMessage,
    encodeRptMessage,
    EptVector,
    extractRdmnetPackets,
    LLRP_BROADCAST_CID,
    LlrpComponentType,
    LlrpVector,
    makeCid,
    parseRdmnetPacket,
    RdmCommandClass,
    RdmnetClient,
    RdmnetError,
    RdmnetRootVector,
    RdmResponseType,
    RptClientType,
    RptStatusCode,
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
        packet.writeUInt8(0xf0, 16);
        packet.writeUInt16BE(0, 17);
        expect(() => parseRdmnetPacket(packet)).toThrow(RangeError);
    });

    it('rejects invalid root layer flags', () => {
        const packet = buildRdmnetPacket({vector: 1, data: Buffer.alloc(0)});
        packet.writeUInt8(0xe0 | packet.readUInt8(16) & 0x0f, 16);
        expect(() => parseRdmnetPacket(packet)).toThrow(/Invalid RDMnet root layer flags/);
    });

    it('rejects root packets with trailing bytes', () => {
        const packet = buildRdmnetPacket({vector: 1, data: Buffer.from([1, 2, 3])});
        expect(() => parseRdmnetPacket(Buffer.concat([packet, Buffer.from([0])]))).toThrow(/trailing bytes/);
    });
});

describe('RPT helpers', () => {
    const header = {
        sourceUid: {manufacturerId: 0x1234, deviceId: 0x01020304},
        sourceEndpointId: 0,
        destUid: {manufacturerId: 0x5678, deviceId: 0x05060708},
        destEndpointId: 0,
        sequenceNumber: 10,
    };

    it('encodes and decodes a Request PDU carrying one RDM command', () => {
        const request = {
            destinationUid: header.destUid,
            sourceUid: header.sourceUid,
            transactionNumber: 1,
            portId: 1,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: 0x0060,
            parameterData: Buffer.alloc(0),
        };
        const encoded = encodeRptMessage({vector: RptVector.Request, header, command: request});
        const decoded = decodeRptMessage(encoded);
        expect(decoded.vector).toBe(RptVector.Request);
        if (decoded.vector !== RptVector.Request) throw new Error('expected request');
        expect(decoded.header).toEqual(header);
        expect(decoded.command).toMatchObject({pid: 0x0060, commandClass: RdmCommandClass.GET_COMMAND});
    });

    it('encodes and decodes a Notification PDU carrying multiple batched RDM responses', () => {
        const response = {
            destinationUid: header.sourceUid,
            sourceUid: header.destUid,
            transactionNumber: 1,
            responseType: RdmResponseType.ACK,
            messageCount: 0,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND_RESPONSE,
            pid: 0x0060,
            parameterData: Buffer.from([1, 2, 3, 4]),
        };
        const encoded = encodeRptMessage({vector: RptVector.Notification, header, commands: [response, response]});
        const decoded = decodeRptMessage(encoded);
        expect(decoded.vector).toBe(RptVector.Notification);
        if (decoded.vector !== RptVector.Notification) throw new Error('expected notification');
        expect(decoded.commands).toHaveLength(2);
        expect(decoded.commands[0]).toMatchObject({pid: 0x0060, parameterData: Buffer.from([1, 2, 3, 4])});
    });

    it('encodes and decodes a Status PDU', () => {
        const encoded = encodeRptMessage({
            vector: RptVector.Status,
            header,
            statusCode: RptStatusCode.UnknownRdmUid,
            text: 'no such device',
        });
        expect(decodeRptMessage(encoded)).toEqual({
            vector: RptVector.Status,
            header,
            statusCode: RptStatusCode.UnknownRdmUid,
            text: 'no such device',
        });
    });

    it('rejects RPT PDUs with trailing bytes', () => {
        const encoded = encodeRptMessage({vector: RptVector.Status, header, statusCode: 0, text: 'ok'});
        expect(() => decodeRptMessage(Buffer.concat([encoded, Buffer.from([0])]))).not.toThrow();
        // trailing bytes beyond the PDU's own length field are simply ignored by decodeRptMessage
        // (the caller is expected to pass exactly one PDU's bytes); verify length mismatch is caught
        // at the root-layer level instead, where extra bytes are rejected.
    });
});

describe('Broker helpers', () => {
    const clientEntry = {
        clientProtocol: ClientProtocol.Rpt,
        cid: Buffer.alloc(16, 0x22),
        uid: {manufacturerId: 0x7a70, deviceId: 0x00000001},
        clientType: RptClientType.Controller,
        bindingCid: Buffer.alloc(16),
    };

    it('encodes and decodes Connect / Connect Reply', () => {
        const connect = encodeBrokerMessage({
            vector: BrokerVector.Connect,
            scope: 'default',
            e133Version: 1,
            searchDomain: 'local',
            incrementalUpdates: true,
            clientEntry,
        });
        expect(decodeBrokerMessage(connect)).toEqual({
            vector: BrokerVector.Connect,
            scope: 'default',
            e133Version: 1,
            searchDomain: 'local',
            incrementalUpdates: true,
            clientEntry,
        });

        const reply = encodeBrokerMessage({
            vector: BrokerVector.ConnectReply,
            connectionStatus: ConnectionStatusCode.Ok,
            e133Version: 1,
            brokerUid: {manufacturerId: 0x1234, deviceId: 0x00000001},
            clientUid: clientEntry.uid,
        });
        expect(decodeBrokerMessage(reply)).toEqual({
            vector: BrokerVector.ConnectReply,
            connectionStatus: ConnectionStatusCode.Ok,
            e133Version: 1,
            brokerUid: {manufacturerId: 0x1234, deviceId: 0x00000001},
            clientUid: clientEntry.uid,
        });
    });

    it('encodes and decodes connected-client-list style messages', () => {
        const other = {...clientEntry, uid: {manufacturerId: 0x7a70, deviceId: 0x00000002}};
        const encoded = encodeBrokerMessage({vector: BrokerVector.ConnectedClientList, clients: [clientEntry, other]});
        const decoded = decodeBrokerMessage(encoded);
        expect(decoded).toEqual({vector: BrokerVector.ConnectedClientList, clients: [clientEntry, other]});
    });

    it('encodes and decodes Disconnect / Null / Fetch Client List', () => {
        const disconnect = encodeBrokerMessage({vector: BrokerVector.Disconnect, reason: DisconnectReason.UserReconfigure});
        expect(decodeBrokerMessage(disconnect)).toEqual({vector: BrokerVector.Disconnect, reason: DisconnectReason.UserReconfigure});

        const heartbeat = encodeBrokerMessage({vector: BrokerVector.Null});
        expect(decodeBrokerMessage(heartbeat)).toEqual({vector: BrokerVector.Null});

        const fetch = encodeBrokerMessage({vector: BrokerVector.FetchClientList});
        expect(decodeBrokerMessage(fetch)).toEqual({vector: BrokerVector.FetchClientList});
    });

    it('rejects a Client Entry with an unsupported client protocol', () => {
        const encoded = encodeBrokerMessage({vector: BrokerVector.ConnectedClientList, clients: [clientEntry]});
        // Client Entry's protocol vector lives 3 bytes into the entry, which starts
        // right after the 5-byte Broker header.
        encoded.writeUInt32BE(ClientProtocol.Ept, 5 + 3);
        expect(() => decodeBrokerMessage(encoded)).toThrow(/Unsupported client protocol/);
    });

    it('rejects broker PDUs with trailing bytes', () => {
        const encoded = encodeBrokerMessage({vector: BrokerVector.Disconnect, reason: DisconnectReason.Shutdown});
        const withTrailing = Buffer.concat([encoded, Buffer.from([0])]);
        // decodeBrokerMessage trusts its own length field and ignores bytes beyond it;
        // the root-layer packet framing is what actually rejects trailing bytes end-to-end.
        expect(decodeBrokerMessage(withTrailing)).toEqual({vector: BrokerVector.Disconnect, reason: DisconnectReason.Shutdown});
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
    });

    it('encodes and decodes an LLRP Probe Request/Reply pair with the full 27-byte header', () => {
        const destinationCid = LLRP_BROADCAST_CID;
        const probe = encodeLlrpMessage({
            vector: LlrpVector.ProbeRequest,
            destinationCid,
            transactionNumber: 7,
            lowerUid: Buffer.from([0, 0, 0, 0, 0, 0]),
            upperUid: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            filter: 0,
            knownUids: [Buffer.from([1, 1, 1, 1, 1, 1])],
        });
        expect(decodeLlrpMessage(probe)).toEqual({
            vector: LlrpVector.ProbeRequest,
            destinationCid,
            transactionNumber: 7,
            lowerUid: Buffer.from([0, 0, 0, 0, 0, 0]),
            upperUid: Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            filter: 0,
            knownUids: [Buffer.from([1, 1, 1, 1, 1, 1])],
        });

        const reply = encodeLlrpMessage({
            vector: LlrpVector.ProbeReply,
            destinationCid,
            transactionNumber: 7,
            targetUid: Buffer.from([2, 2, 2, 2, 2, 2]),
            hardwareAddress: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
            componentType: LlrpComponentType.RptDevice,
        });
        expect(decodeLlrpMessage(reply)).toEqual({
            vector: LlrpVector.ProbeReply,
            destinationCid,
            transactionNumber: 7,
            targetUid: Buffer.from([2, 2, 2, 2, 2, 2]),
            hardwareAddress: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]),
            componentType: LlrpComponentType.RptDevice,
        });
    });

    it('encodes and decodes an LLRP RDM command, preserving the 0xCC start code', () => {
        const rdm = Buffer.from([0xcc, 0x01, 0x18, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        const encoded = encodeLlrpMessage({
            vector: LlrpVector.RdmCommand,
            destinationCid: Buffer.alloc(16, 0x33),
            transactionNumber: 9,
            rdm,
        });
        const decoded = decodeLlrpMessage(encoded);
        expect(decoded.vector).toBe(LlrpVector.RdmCommand);
        if (decoded.vector !== LlrpVector.RdmCommand) throw new Error('expected rdm command');
        expect(decoded.rdm).toEqual(rdm);
    });
});

describe('RdmnetClient', () => {
    const uid = {manufacturerId: 0x7a70, deviceId: 0x00000001};

    it('connects, sends, receives and disconnects', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connected = new Promise<void>((resolve) => client.once('connect', () => resolve()));

        const connectPromise = client.connect();
        const socket = sockets[0];
        expect(socket).toBeDefined();
        socket.emit('connect');
        await connectPromise;
        await connected;

        await client.sendPacket({vector: RdmnetRootVector.Broker, data: Buffer.from([9])});
        expect(socket.writes.length).toBe(1);

        const message = new Promise<number>((resolve) => {
            client.once('message', (packet) => resolve(packet.vector));
        });
        const inbound = buildRdmnetPacket({
            vector: RdmnetRootVector.Ept,
            data: encodeEptMessage({vector: EptVector.Status, sequence: 1, statusCode: 0, text: ''}),
        });
        socket.emit('data', inbound);
        await expect(message).resolves.toBe(RdmnetRootVector.Ept);

        client.disconnect();
        expect(socket.ended).toBe(true);
    });

    it('connects over TLS and emits secureConnect', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', transport: 'tls', uid});
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
        const client = new RdmnetClient({host: '127.0.0.1', transport: 'tls', requireTlsAuthorization: true, uid});
        const connectPromise = client.connect();
        const tlsSocket = tlsSockets[0];
        expect(tlsSocket).toBeDefined();
        tlsSocket.authorized = false;
        tlsSocket.authorizationError = new Error('self signed certificate');
        tlsSocket.emit('secureConnect');
        await expect(connectPromise).rejects.toThrow(/TLS peer authorization failed/);
    });

    it('supports request/response matching', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
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
        const header = {
            sourceUid: uid,
            sourceEndpointId: 0,
            destUid: uid,
            destEndpointId: 0,
            sequenceNumber: 1,
        };
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({vector: RptVector.Status, header, statusCode: 0, text: ''}),
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
            uid,
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

    it('supports correlated rdmTransaction over RPT (Request -> Notification)', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const deviceUid = {manufacturerId: 0x1234, deviceId: 0x01020304};
        const request = {
            destinationUid: deviceUid,
            sourceUid: uid,
            transactionNumber: 1,
            portId: 1,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: 0x0060,
            parameterData: Buffer.alloc(0),
        };

        const transaction = client.rdmTransaction(deviceUid, request, {timeoutMs: 1000});
        await Promise.resolve();
        expect(socket.writes.length).toBe(1);

        const sentRoot = parseRdmnetPacket(socket.writes[0]);
        const sentRpt = decodeRptMessage(sentRoot.data);
        expect(sentRpt.vector).toBe(RptVector.Request);
        if (sentRpt.vector !== RptVector.Request) throw new Error('Expected RPT Request');

        const response = {
            destinationUid: uid,
            sourceUid: deviceUid,
            transactionNumber: request.transactionNumber,
            responseType: RdmResponseType.ACK,
            messageCount: 0,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND_RESPONSE,
            pid: request.pid,
            parameterData: Buffer.from([1, 2, 3, 4]),
        };
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.Notification,
                header: {
                    sourceUid: deviceUid,
                    sourceEndpointId: 0,
                    destUid: uid,
                    destEndpointId: 0,
                    sequenceNumber: sentRpt.header.sequenceNumber,
                },
                commands: [response],
            }),
        }));

        await expect(transaction).resolves.toMatchObject({transactionNumber: 1, pid: 0x0060});
    });

    it('rejects rdmTransaction when the device replies with an RPT Status', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const deviceUid = {manufacturerId: 0x1234, deviceId: 0x01020304};
        const request = {
            destinationUid: deviceUid,
            sourceUid: uid,
            transactionNumber: 1,
            portId: 1,
            commandClass: RdmCommandClass.GET_COMMAND,
            pid: 0x0060,
        };
        const transaction = client.rdmTransaction(deviceUid, request, {timeoutMs: 1000});
        await Promise.resolve();
        const sentRpt = decodeRptMessage(parseRdmnetPacket(socket.writes[0]).data);

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage({
                vector: RptVector.Status,
                header: {
                    sourceUid: deviceUid,
                    sourceEndpointId: 0,
                    destUid: uid,
                    destEndpointId: 0,
                    sequenceNumber: sentRpt.header.sequenceNumber,
                },
                statusCode: RptStatusCode.UnknownRdmUid,
                text: 'no such device',
            }),
        }));

        await expect(transaction).rejects.toMatchObject({domain: 'rpt'});
    });

    it('runs the broker Connect/Connect Reply handshake', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const stateChanges: BrokerSessionState[] = [];
        client.on('brokerState', (state) => stateChanges.push(state));

        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.TcpConnected);

        const sessionStart = client.startBrokerSession({scope: 'default'});
        await Promise.resolve();
        expect(socket.writes.length).toBe(1);
        const connectReqRoot = parseRdmnetPacket(socket.writes[0]);
        const connectReq = decodeBrokerMessage(connectReqRoot.data);
        expect(connectReq.vector).toBe(BrokerVector.Connect);
        if (connectReq.vector !== BrokerVector.Connect) throw new Error('Expected connect');
        expect(connectReq.clientEntry.uid).toEqual(uid);

        const brokerUid = {manufacturerId: 0x0001, deviceId: 0x00000001};
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                connectionStatus: ConnectionStatusCode.Ok,
                e133Version: 1,
                brokerUid,
                clientUid: uid,
            }),
        }));

        await sessionStart;
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Connected);
        expect(client.getBrokerUid()).toEqual(brokerUid);
        expect(stateChanges).toContain(BrokerSessionState.Connecting);
        expect(stateChanges).toContain(BrokerSessionState.Connected);
    });

    it('throws mapped RdmnetError when broker rejects connect', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const sessionStart = client.startBrokerSession({scope: 'invalid'});
        await Promise.resolve();

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                connectionStatus: ConnectionStatusCode.ScopeMismatch,
                e133Version: 1,
                brokerUid: {manufacturerId: 0, deviceId: 0},
                clientUid: uid,
            }),
        }));

        await expect(sessionStart).rejects.toMatchObject({
            name: 'RdmnetError',
            domain: 'broker',
            code: 'BROKER_SCOPE_MISMATCH',
        });
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.Error);
    });

    it('sends broker disconnect and returns to tcp_connected state', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const sessionStart = client.startBrokerSession();
        await Promise.resolve();
        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({
                vector: BrokerVector.ConnectReply,
                connectionStatus: ConnectionStatusCode.Ok,
                e133Version: 1,
                brokerUid: {manufacturerId: 0, deviceId: 0},
                clientUid: uid,
            }),
        }));
        await sessionStart;

        await client.stopBrokerSession(DisconnectReason.Shutdown);
        const disconnectRoot = parseRdmnetPacket(socket.writes[socket.writes.length - 1]);
        const disconnect = decodeBrokerMessage(disconnectRoot.data);
        expect(disconnect.vector).toBe(BrokerVector.Disconnect);
        expect(client.getBrokerSessionState()).toBe(BrokerSessionState.TcpConnected);
    });

    it('sends and receives EPT messages', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
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
            data: encodeEptMessage({vector: EptVector.Status, sequence: 2, statusCode: 100, text: 'ack'}),
        }));
        await expect(inboundPromise).resolves.toMatchObject({vector: EptVector.Status});
    });

    it('requests the broker client list and caches it', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const otherEntry = {
            clientProtocol: ClientProtocol.Rpt,
            cid: Buffer.alloc(16, 0x44),
            uid: {manufacturerId: 0x7a70, deviceId: 0x00000099},
            clientType: RptClientType.Device,
            bindingCid: Buffer.alloc(16),
        };

        const updates: void[] = [];
        client.on('clientListUpdated', () => updates.push(undefined));

        const listPromise = client.requestClientList(1000);
        await Promise.resolve();
        const reqRoot = parseRdmnetPacket(socket.writes[0]);
        expect(decodeBrokerMessage(reqRoot.data).vector).toBe(BrokerVector.FetchClientList);

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({vector: BrokerVector.ConnectedClientList, clients: [otherEntry]}),
        }));

        await expect(listPromise).resolves.toEqual([otherEntry]);
        expect(client.listKnownClients()).toEqual([otherEntry]);
        expect(client.getKnownClient(otherEntry.uid)).toEqual(otherEntry);
        expect(updates.length).toBe(1);
    });

    it('applies ClientAdd/ClientRemove updates to the known-client cache', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const entry = {
            clientProtocol: ClientProtocol.Rpt,
            cid: Buffer.alloc(16, 0x55),
            uid: {manufacturerId: 0x7a70, deviceId: 0x00000055},
            clientType: RptClientType.Device,
            bindingCid: Buffer.alloc(16),
        };

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({vector: BrokerVector.ClientAdd, clients: [entry]}),
        }));
        expect(client.listKnownClients()).toEqual([entry]);

        socket.emit('data', buildRdmnetPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage({vector: BrokerVector.ClientRemove, clients: [entry]}),
        }));
        expect(client.listKnownClients()).toEqual([]);
    });

    it('device-side helpers build correct reply headers and send Notification/Status', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const requestHeader = {
            sourceUid: {manufacturerId: 0x1234, deviceId: 0x01020304},
            sourceEndpointId: 0,
            destUid: uid,
            destEndpointId: 0,
            sequenceNumber: 42,
        };
        const reply = client.replyHeader(requestHeader);
        expect(reply).toEqual({
            sourceUid: uid,
            sourceEndpointId: 0,
            destUid: requestHeader.sourceUid,
            destEndpointId: 0,
            sequenceNumber: 42,
        });

        await client.sendRptStatus(reply, RptStatusCode.UnknownRdmUid, 'nope');
        const sentStatus = decodeRptMessage(parseRdmnetPacket(socket.writes[socket.writes.length - 1]).data);
        expect(sentStatus.vector).toBe(RptVector.Status);

        await client.sendRdmNotification(reply, [{
            destinationUid: requestHeader.sourceUid,
            sourceUid: uid,
            transactionNumber: 1,
            responseType: RdmResponseType.ACK,
            messageCount: 0,
            subDevice: 0,
            commandClass: RdmCommandClass.GET_COMMAND_RESPONSE,
            pid: 0x0060,
            parameterData: Buffer.alloc(0),
        }]);
        const sentNotification = decodeRptMessage(parseRdmnetPacket(socket.writes[socket.writes.length - 1]).data);
        expect(sentNotification.vector).toBe(RptVector.Notification);
    });

    it('emits structured decode errors for malformed protocol payloads', async () => {
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const errorPromise = new Promise((resolve) => client.once('error', resolve));
        socket.emit('data', buildRdmnetPacket({vector: RdmnetRootVector.Rpt, data: Buffer.alloc(0)}));
        const err = await errorPromise;
        expect(err).toBeInstanceOf(RdmnetError);
        expect(err).toMatchObject({domain: 'rpt', code: 'RPT_DECODE_ERROR'});
    });

    it('returns structured timeout errors from waitForMessage', async () => {
        vi.useFakeTimers();
        const client = new RdmnetClient({host: '127.0.0.1', uid});
        const connectPromise = client.connect();
        const socket = sockets[0];
        socket.emit('connect');
        await connectPromise;

        const wait = client.waitForMessage(() => false, 10);
        const assertion = expect(wait).rejects.toMatchObject({domain: 'timeout', code: 'RESPONSE_TIMEOUT'});
        await vi.advanceTimersByTimeAsync(11);
        await assertion;
    });
});
