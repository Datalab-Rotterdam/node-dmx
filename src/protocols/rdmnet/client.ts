/**
 * ANSI E1.33 (RDMnet) TCP client.
 * @module rdmnet/client
 */
import * as net from 'net';
import type {Socket} from 'net';
import * as tls from 'tls';
import type {ConnectionOptions as TlsConnectionOptions} from 'tls';
import {EventEmitter} from 'events';

import {
    RDMNET_DEFAULT_HEARTBEAT_MS,
    RDMNET_DEFAULT_MAX_BUFFER_BYTES,
    RDMNET_DEFAULT_PORT,
    RDMNET_DEFAULT_RECONNECT_DELAY_MS,
    RDMNET_DEFAULT_RECONNECT_MAX_DELAY_MS,
    RDMNET_DEFAULT_REQUEST_TIMEOUT_MS,
    RdmnetRootVector,
} from './constants';
import {
    buildRdmnetPacket,
    extractRdmnetPackets,
    makeCid,
    type RdmnetPacket,
    type RdmnetPacketOptions,
} from './packet';
import {
    type BrokerMessage,
    BrokerVector,
    ClientProtocol,
    ConnectionStatusCode,
    DEFAULT_SCOPE,
    DisconnectReason,
    E133_VERSION,
    decodeBrokerMessage,
    encodeBrokerMessage,
    RptClientType,
    type RptClientEntry,
} from './broker';
import {mapBrokerStatusToError, RdmnetError} from './errors';
import {decodeEptMessage, encodeEptMessage, type EptMessage} from './ept-llrp';
import {
    decodeRptMessage,
    encodeRptMessage,
    RptStatusCode,
    RptVector,
    type RptHeader,
    type RptMessage,
    type RptNotificationMessage,
} from './rpt';
import type {RdmResponder} from '../artnet/rdm/responder';
import type {RdmRequest, RdmResponse} from '../artnet/rdm/types';
import {uidToString, type UID} from '../artnet/rdm/uid';

/** Client-side connection/session lifecycle state (not a wire concept — local bookkeeping only). */
export enum BrokerSessionState {
    Disconnected = 'disconnected',
    TcpConnected = 'tcp_connected',
    Connecting = 'connecting',
    Connected = 'connected',
    Error = 'error',
}

/**
 * Configuration for a {@link RdmnetClient}.
 */
export type RdmnetClientOptions = {
    /** Broker hostname or IP address. */
    host: string;
    /** Broker TCP/TLS port. Defaults to {@link RDMNET_DEFAULT_PORT}. */
    port?: number;
    /** Optional local interface address to bind for outbound connections. */
    localAddress?: string;
    /** Transport mode. Use `'tls'` for secure sockets. Defaults to `'tcp'`. */
    transport?: 'tcp' | 'tls';
    /**
     * TLS options forwarded to Node's `tls.connect()` when `transport` is `'tls'`.
     * Use this for CA/certificate/key/cipher policy configuration.
     */
    tls?: Omit<TlsConnectionOptions, 'host' | 'port'>;
    /**
     * Require successful TLS peer authorization before the client is considered connected.
     * Defaults to `true` when `transport` is `'tls'`.
     */
    requireTlsAuthorization?: boolean;
    /**
     * Optional post-connect hook for environment-specific auth/profile checks.
     * Throwing rejects `connect()`.
     */
    postConnectAuth?: (context: {
        transport: 'tcp' | 'tls';
        socket: Socket;
        host: string;
        port: number;
        authorized?: boolean;
        authorizationError?: Error | string | null;
    }) => Promise<void> | void;
    /** This component's RDM UID — required, carried in every Broker Client Entry / RPT header. */
    uid: UID;
    /** Optional fixed CID. Must be 16 bytes when provided. */
    cid?: Buffer;
    /** RPT client type advertised at Connect. Defaults to `Controller`. */
    clientType?: RptClientType;
    /** Enable reconnect behavior after unexpected disconnects. Default: `true`. */
    autoReconnect?: boolean;
    /** Initial reconnect backoff delay in milliseconds. */
    reconnectDelayMs?: number;
    /** Maximum reconnect backoff delay in milliseconds. */
    reconnectMaxDelayMs?: number;
    /** Interval for keepalive heartbeats (Broker Null message) in milliseconds. */
    heartbeatIntervalMs?: number;
    /** Default timeout for request/response operations. */
    requestTimeoutMs?: number;
    /** Maximum buffered stream bytes before framing-corruption protection triggers. */
    maxBufferBytes?: number;
};

/**
 * Broker session startup options used by {@link RdmnetClient.startBrokerSession}.
 */
export type BrokerSessionOptions = {
    /** Broker scope name. Defaults to {@link DEFAULT_SCOPE}. */
    scope?: string;
    e133Version?: number;
    /** E1.33 search domain (mDNS domain used for broker discovery). */
    searchDomain?: string;
    /** Request incremental (Add/Remove/Change) client-list updates instead of full re-sends. */
    incrementalUpdates?: boolean;
    /** Per-session timeout override. */
    timeoutMs?: number;
};

/**
 * Typed event map emitted by {@link RdmnetClient}.
 */
export interface RdmnetClientEvents {
    /** Emitted after transport and optional auth checks succeed. */
    connect: [];
    /** Emitted for TLS transport when handshake completes. */
    secureConnect: [authorized: boolean, authorizationError?: Error | string | null];
    /** Emitted when socket closes. */
    disconnect: [hadError: boolean];
    /** Emitted before automatic reconnect attempts. */
    reconnecting: [attempt: number, delayMs: number];
    /** Emitted for each successful heartbeat write. */
    heartbeat: [];
    /** Emitted for every parsed ACN root packet. */
    message: [packet: RdmnetPacket];
    /** Emitted for decoded broker payloads. */
    brokerMessage: [message: BrokerMessage];
    /** Emitted when broker session state changes. */
    brokerState: [state: BrokerSessionState];
    /** Emitted when the locally cached known-client list changes. */
    clientListUpdated: [];
    /** Emitted for decoded EPT messages. */
    eptMessage: [message: EptMessage];
    /** Emitted for decoded RPT messages. */
    rptMessage: [message: RptMessage];
    /** Emitted for decoded RPT Notification messages (RDM responses). */
    rdmNotification: [message: RptNotificationMessage];
    /** Emitted for transport/protocol/timeout/decode errors. */
    error: [error: Error];
}

/**
 * Predicate used to correlate inbound root packets with a pending request.
 */
export type MessageMatcher = (packet: RdmnetPacket) => boolean;
type Waiter = {
    matcher: MessageMatcher;
    resolve: (packet: RdmnetPacket) => void;
    reject: (error: Error) => void;
    timeoutId: NodeJS.Timeout;
};

/**
 * ANSI E1.33 (RDMnet) Broker/RPT TCP client.
 *
 * Root layer framing, Broker PDU, and RPT PDU are all wire-compatible with
 * third-party E1.33 brokers/controllers/devices (see `rdmnet/broker` and
 * `rdmnet/rpt` for the verified byte layouts). LLRP is intentionally not
 * exposed here — per ANSI E1.33 §6 it is an independent UDP multicast
 * transport, not something carried over this TCP connection; see
 * `LlrpManager`/`LlrpTarget` in `rdmnet/llrp-transport`.
 */
export class RdmnetClient extends EventEmitter<RdmnetClientEvents> {
    private readonly cid: Buffer;
    private readonly uid: UID;
    private readonly clientType: RptClientType;
    private readonly autoReconnect: boolean;
    private readonly reconnectDelayMs: number;
    private readonly reconnectMaxDelayMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly requestTimeoutMs: number;
    private readonly maxBufferBytes: number;
    private readonly transport: 'tcp' | 'tls';
    private readonly tlsOptions: Omit<TlsConnectionOptions, 'host' | 'port'>;
    private readonly requireTlsAuthorization: boolean;
    private readonly postConnectAuth?: RdmnetClientOptions['postConnectAuth'];

    private socket: Socket | null = null;
    private streamBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    private connectPromise: Promise<void> | null = null;
    private manualClose = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private waiters: Waiter[] = [];
    private rptSequence = 0;

    private brokerState: BrokerSessionState = BrokerSessionState.Disconnected;
    private brokerUid: UID | null = null;
    private brokerScope = DEFAULT_SCOPE;
    private knownClients = new Map<string, RptClientEntry>();

    constructor(private readonly options: RdmnetClientOptions) {
        super();
        this.cid = options.cid ? Buffer.from(options.cid) : makeCid();
        if (this.cid.length !== 16) {
            throw new RangeError(`RDMnet CID must be 16 bytes, got ${this.cid.length}`);
        }
        this.uid = options.uid;
        this.clientType = options.clientType ?? RptClientType.Controller;

        this.autoReconnect = options.autoReconnect ?? true;
        this.reconnectDelayMs = options.reconnectDelayMs ?? RDMNET_DEFAULT_RECONNECT_DELAY_MS;
        this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RDMNET_DEFAULT_RECONNECT_MAX_DELAY_MS;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? RDMNET_DEFAULT_HEARTBEAT_MS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? RDMNET_DEFAULT_REQUEST_TIMEOUT_MS;
        this.maxBufferBytes = options.maxBufferBytes ?? RDMNET_DEFAULT_MAX_BUFFER_BYTES;
        this.transport = options.transport ?? 'tcp';
        this.tlsOptions = options.tls ?? {};
        this.requireTlsAuthorization = options.requireTlsAuthorization ?? this.transport === 'tls';
        this.postConnectAuth = options.postConnectAuth;
    }

    /**
     * Establishes the transport connection.
     *
     * For TLS mode this waits for handshake, validates authorization policy,
     * and executes optional {@link RdmnetClientOptions.postConnectAuth}.
     */
    public async connect(): Promise<void> {
        if (this.isConnected()) return;
        if (this.connectPromise) return this.connectPromise;

        this.manualClose = false;
        this.connectPromise = this.connectInternal();
        try {
            await this.connectPromise;
        } finally {
            this.connectPromise = null;
        }
    }

    /** Returns `true` when the underlying socket is open. */
    public isConnected(): boolean {
        return !!this.socket && !this.socket.destroyed;
    }

    /** Returns the local RDMnet CID used by this client. */
    public getCid(): Buffer {
        return Buffer.from(this.cid);
    }

    /** Returns this component's RDM UID. */
    public getUid(): UID {
        return this.uid;
    }

    /** Returns current broker session state. */
    public getBrokerSessionState(): BrokerSessionState {
        return this.brokerState;
    }

    /** Returns the Broker's own UID once connected, else `null`. */
    public getBrokerUid(): UID | null {
        return this.brokerUid;
    }

    /** Returns a snapshot of the locally cached known-client list (seeded/updated by Broker list messages). */
    public listKnownClients(): RptClientEntry[] {
        return Array.from(this.knownClients.values());
    }

    /** Looks up one cached known client by UID. */
    public getKnownClient(uid: UID): RptClientEntry | null {
        return this.knownClients.get(uidToString(uid)) ?? null;
    }

    /** Gracefully closes the socket and resets session state. */
    public disconnect(): void {
        this.manualClose = true;
        this.stopReconnectTimer();
        this.stopHeartbeat();
        this.rejectAllWaiters(new Error('RDMnet client disconnected'));
        this.socket?.end();
        this.socket = null;
        this.setBrokerState(BrokerSessionState.Disconnected);
        this.brokerUid = null;
        this.knownClients.clear();
    }

    /** Sends one ACN root packet. */
    public async sendPacket(options: RdmnetPacketOptions): Promise<void> {
        const packet = buildRdmnetPacket({
            ...options,
            cid: options.cid ?? this.cid,
        });
        await this.sendRaw(packet);
    }

    /**
     * Sends a packet and resolves with the first inbound packet matching `matcher`.
     */
    public async sendRequest(
        options: RdmnetPacketOptions,
        matcher: MessageMatcher,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<RdmnetPacket> {
        await this.connect();
        const wait = this.waitForMessage(matcher, timeoutMs);
        await this.sendPacket(options);
        return wait;
    }

    /**
     * Waits for an inbound packet matching `matcher`.
     * Rejects with `RdmnetError(code=RESPONSE_TIMEOUT)` on timeout.
     */
    public waitForMessage(matcher: MessageMatcher, timeoutMs = this.requestTimeoutMs): Promise<RdmnetPacket> {
        return new Promise<RdmnetPacket>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.waiters = this.waiters.filter((w) => w.timeoutId !== timeoutId);
                reject(new RdmnetError({
                    message: `RDMnet response timed out after ${timeoutMs}ms`,
                    domain: 'timeout',
                    code: 'RESPONSE_TIMEOUT',
                }));
            }, timeoutMs);

            this.waiters.push({matcher, resolve, reject, timeoutId});
        });
    }

    /** Waits for a decoded broker message matching a type guard. */
    public waitForBrokerMessage<T extends BrokerMessage>(
        matcher: (message: BrokerMessage) => message is T,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<T> {
        return this.waitForMessage((packet) => {
            if (packet.vector !== RdmnetRootVector.Broker) return false;
            try {
                return matcher(decodeBrokerMessage(packet.data));
            } catch {
                return false;
            }
        }, timeoutMs).then((packet) => decodeBrokerMessage(packet.data) as T);
    }

    /** Waits for a decoded EPT message matching a type guard. */
    public waitForEptMessage<T extends EptMessage>(
        matcher: (message: EptMessage) => message is T,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<T> {
        return this.waitForMessage((packet) => {
            if (packet.vector !== RdmnetRootVector.Ept) return false;
            try {
                return matcher(decodeEptMessage(packet.data));
            } catch {
                return false;
            }
        }, timeoutMs).then((packet) => decodeEptMessage(packet.data) as T);
    }

    /** Sends raw bytes to the connected transport socket. */
    public async sendRaw(data: Buffer | Uint8Array): Promise<void> {
        if (!this.socket) {
            throw new Error('RDMnet socket is not connected');
        }
        const payload = Buffer.from(data);
        await new Promise<void>((resolve, reject) => {
            this.socket!.write(payload, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /** Encodes and sends one broker payload. */
    public async sendBrokerMessage(message: BrokerMessage): Promise<void> {
        await this.sendPacket({
            vector: RdmnetRootVector.Broker,
            data: encodeBrokerMessage(message),
        });
    }

    /** Encodes and sends one EPT payload. */
    public async sendEptMessage(message: EptMessage): Promise<void> {
        await this.sendPacket({
            vector: RdmnetRootVector.Ept,
            data: encodeEptMessage(message),
        });
    }

    /**
     * Sends the Broker Connect message (with this client's RPT Client Entry)
     * and waits for Connect Reply.
     */
    public async startBrokerSession(options: BrokerSessionOptions = {}): Promise<void> {
        await this.connect();
        if (this.brokerState === BrokerSessionState.Connected) return;
        if (this.brokerState !== BrokerSessionState.TcpConnected && this.brokerState !== BrokerSessionState.Error) {
            throw new Error(`Cannot start broker session from state "${this.brokerState}"`);
        }

        const scope = options.scope ?? this.brokerScope;
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
        this.brokerScope = scope;

        this.setBrokerState(BrokerSessionState.Connecting);
        const connectReplyPromise = this.waitForBrokerMessage(
            (message): message is Extract<BrokerMessage, {vector: BrokerVector.ConnectReply}> =>
                message.vector === BrokerVector.ConnectReply,
            timeoutMs,
        );
        await this.sendBrokerMessage({
            vector: BrokerVector.Connect,
            scope,
            e133Version: options.e133Version ?? E133_VERSION,
            searchDomain: options.searchDomain,
            incrementalUpdates: options.incrementalUpdates,
            clientEntry: {
                clientProtocol: ClientProtocol.Rpt,
                cid: this.cid,
                uid: this.uid,
                clientType: this.clientType,
                bindingCid: Buffer.alloc(16),
            },
        });
        const reply = await connectReplyPromise;

        if (reply.connectionStatus !== ConnectionStatusCode.Ok) {
            this.setBrokerState(BrokerSessionState.Error);
            throw mapBrokerStatusToError(reply.connectionStatus, 'Broker connect rejected', {scope});
        }

        this.brokerUid = reply.brokerUid;
        this.setBrokerState(BrokerSessionState.Connected);
    }

    /** Sends broker disconnect and resets broker-bound state. */
    public async stopBrokerSession(reason = DisconnectReason.Shutdown): Promise<void> {
        if (!this.isConnected() || this.brokerState !== BrokerSessionState.Connected) return;
        await this.sendBrokerMessage({vector: BrokerVector.Disconnect, reason});
        this.setBrokerState(BrokerSessionState.TcpConnected);
        this.brokerUid = null;
        this.knownClients.clear();
    }

    /** Requests the Broker's connected-client list and updates the local cache. */
    public async requestClientList(timeoutMs = this.requestTimeoutMs): Promise<RptClientEntry[]> {
        const replyPromise = this.waitForBrokerMessage(
            (message): message is Extract<BrokerMessage, {vector: BrokerVector.ConnectedClientList}> =>
                message.vector === BrokerVector.ConnectedClientList,
            timeoutMs,
        );
        await this.sendBrokerMessage({vector: BrokerVector.FetchClientList});
        const reply = await replyPromise;
        // The generic inbound-packet handler already applied this ConnectedClientList
        // to the cache (see handleBrokerMessage) before this waiter resolved.
        return reply.clients;
    }

    /** Encodes and sends one RPT payload. */
    public async sendRptMessage(message: RptMessage): Promise<void> {
        await this.sendPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage(message),
        });
    }

    /** Builds an RPT header addressed from this client to `destUid`/`destEndpointId`. */
    public buildRptHeader(destUid: UID, destEndpointId = 0, sourceEndpointId = 0): RptHeader {
        return {
            sourceUid: this.uid,
            sourceEndpointId,
            destUid,
            destEndpointId,
            sequenceNumber: this.nextRptSequence(),
        };
    }

    /**
     * Sends an RPT RDM command (Request PDU) and returns the header used
     * (its `sequenceNumber` correlates the eventual Notification/Status).
     */
    public async sendRdmRequest(destUid: UID, request: RdmRequest, destEndpointId = 0): Promise<RptHeader> {
        const header = this.buildRptHeader(destUid, destEndpointId);
        await this.sendRptMessage({vector: RptVector.Request, header, command: request});
        return header;
    }

    /**
     * Sends an RPT RDM command and waits for the correlated Notification
     * (RDM response) or Status (error). Returns the first RDM response when
     * the Notification batches more than one.
     */
    public async rdmTransaction(
        destUid: UID,
        request: RdmRequest,
        options: {destEndpointId?: number; timeoutMs?: number} = {},
    ): Promise<RdmResponse> {
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
        const header = this.buildRptHeader(destUid, options.destEndpointId ?? 0);
        const responsePromise = this.waitForMessage((packet) => {
            if (packet.vector !== RdmnetRootVector.Rpt) return false;
            try {
                const rpt = decodeRptMessage(packet.data);
                return (
                    (rpt.vector === RptVector.Notification || rpt.vector === RptVector.Status)
                    && rpt.header.sequenceNumber === header.sequenceNumber
                );
            } catch {
                return false;
            }
        }, timeoutMs).then((packet) => {
            const rpt = decodeRptMessage(packet.data) as RptMessage;
            if (rpt.vector === RptVector.Status) {
                throw new RdmnetError({
                    message: `RPT status ${RptStatusCode[rpt.statusCode] ?? rpt.statusCode}${rpt.text ? `: ${rpt.text}` : ''}`,
                    domain: 'rpt',
                    code: 'PROTOCOL_ERROR',
                    details: {statusCode: rpt.statusCode, text: rpt.text},
                });
            }
            if (rpt.vector !== RptVector.Notification) {
                throw new Error('Received unexpected RPT message for RDM transaction');
            }
            return rpt.commands[0]!;
        });

        await this.sendRptMessage({vector: RptVector.Request, header, command: request});
        return responsePromise;
    }

    /** Sends an RPT Notification carrying one or more RDM responses (device/responder side). */
    public async sendRdmNotification(header: RptHeader, responses: RdmResponse[]): Promise<void> {
        await this.sendRptMessage({vector: RptVector.Notification, header, commands: responses});
    }

    /** Sends an RPT Status message (device/responder side error report). */
    public async sendRptStatus(header: RptHeader, statusCode: RptStatusCode, text = ''): Promise<void> {
        await this.sendRptMessage({vector: RptVector.Status, header, statusCode, text});
    }

    /**
     * Builds the header for replying to a received Request: source/dest
     * swapped, same sequence number (per RPT routing/correlation rules).
     */
    public replyHeader(requestHeader: RptHeader): RptHeader {
        return {
            sourceUid: requestHeader.destUid,
            sourceEndpointId: requestHeader.destEndpointId,
            destUid: requestHeader.sourceUid,
            destEndpointId: requestHeader.sourceEndpointId,
            sequenceNumber: requestHeader.sequenceNumber,
        };
    }

    /**
     * Wires an {@link RdmResponder} to answer every inbound RPT Request
     * automatically — no manual header-swapping or response-frame building.
     * Call the returned function to stop responding.
     */
    public useRdmResponder(responder: RdmResponder): () => void {
        const handler = (message: RptMessage): void => {
            if (message.vector !== RptVector.Request) return;
            const response = responder.handle(message.command);
            if (!response) return;
            this.sendRdmNotification(this.replyHeader(message.header), [response]).catch((err) => {
                this.emit('error', this.wrapProtocolError(err, 'rpt', 'PROTOCOL_ERROR'));
            });
        };
        this.on('rptMessage', handler);
        return () => this.off('rptMessage', handler);
    }

    private async connectInternal(): Promise<void> {
        const port = this.options.port ?? RDMNET_DEFAULT_PORT;
        const socket = this.transport === 'tls'
            ? tls.connect({
                ...this.tlsOptions,
                host: this.options.host,
                port,
                servername: this.tlsOptions.servername ?? this.options.host,
                rejectUnauthorized: this.tlsOptions.rejectUnauthorized ?? this.requireTlsAuthorization,
            })
            : net.createConnection({
                host: this.options.host,
                port,
                localAddress: this.options.localAddress,
            });
        this.socket = socket;
        this.streamBuffer = Buffer.alloc(0);

        socket.on('data', (chunk) => {
            try {
                const merged = new Uint8Array(this.streamBuffer.length + chunk.length);
                merged.set(this.streamBuffer, 0);
                merged.set(chunk, this.streamBuffer.length);
                this.streamBuffer = Buffer.from(merged);
                if (this.streamBuffer.length > this.maxBufferBytes) {
                    throw new Error(`RDMnet stream buffer exceeded ${this.maxBufferBytes} bytes (possible framing corruption)`);
                }
                const {packets, remainder} = extractRdmnetPackets(this.streamBuffer);
                this.streamBuffer = remainder;

                for (const packet of packets) {
                    if (packet.vector === RdmnetRootVector.Broker) {
                        try {
                            const broker = decodeBrokerMessage(packet.data);
                            this.handleBrokerMessage(broker);
                            this.emit('brokerMessage', broker);
                        } catch (err) {
                            this.emit('error', this.wrapProtocolError(err, 'broker', 'BROKER_DECODE_ERROR', {
                                rootVector: packet.vector,
                            }));
                        }
                    }

                    if (packet.vector === RdmnetRootVector.Ept) {
                        try {
                            this.emit('eptMessage', decodeEptMessage(packet.data));
                        } catch (err) {
                            this.emit('error', this.wrapProtocolError(err, 'ept', 'EPT_DECODE_ERROR', {
                                rootVector: packet.vector,
                            }));
                        }
                    }

                    if (packet.vector === RdmnetRootVector.Rpt) {
                        try {
                            const rpt = decodeRptMessage(packet.data);
                            this.emit('rptMessage', rpt);
                            if (rpt.vector === RptVector.Notification) {
                                this.emit('rdmNotification', rpt);
                            }
                        } catch (err) {
                            this.emit('error', this.wrapProtocolError(err, 'rpt', 'RPT_DECODE_ERROR', {
                                rootVector: packet.vector,
                            }));
                        }
                    }

                    this.resolveWaiters(packet);
                    this.emit('message', packet);
                }
            } catch (err) {
                this.emit('error', this.wrapProtocolError(err, 'transport', 'STREAM_FRAMING_ERROR'));
            }
        });

        socket.on('error', (err) => {
            this.emit('error', this.wrapProtocolError(err, 'transport', 'PROTOCOL_ERROR'));
        });
        socket.on('close', (hadError) => {
            this.stopHeartbeat();
            this.socket = null;
            this.rejectAllWaiters(new Error('RDMnet socket closed'));
            this.setBrokerState(BrokerSessionState.Disconnected);
            this.brokerUid = null;
            this.knownClients.clear();
            this.emit('disconnect', hadError);
            if (!this.manualClose && this.autoReconnect) {
                this.scheduleReconnect();
            }
        });

        const finalizeConnectedState = async (): Promise<void> => {
            if (this.transport === 'tls') {
                const tlsSocket = socket as tls.TLSSocket;
                const authorized = tlsSocket.authorized ?? false;
                const authorizationError = tlsSocket.authorizationError ?? null;
                this.emit('secureConnect', authorized, authorizationError);
                if (this.requireTlsAuthorization && !authorized) {
                    throw new Error(`TLS peer authorization failed: ${authorizationError ?? 'unknown reason'}`);
                }
            }

            if (this.postConnectAuth) {
                await this.postConnectAuth({
                    transport: this.transport,
                    socket,
                    host: this.options.host,
                    port,
                    authorized: this.transport === 'tls' ? (socket as tls.TLSSocket).authorized : undefined,
                    authorizationError: this.transport === 'tls'
                        ? ((socket as tls.TLSSocket).authorizationError ?? null)
                        : undefined,
                });
            }

            this.reconnectAttempts = 0;
            this.stopReconnectTimer();
            this.startHeartbeat();
            this.setBrokerState(BrokerSessionState.TcpConnected);
            this.emit('connect');
        };

        await new Promise<void>((resolve, reject) => {
            const onConnected = (): void => {
                void finalizeConnectedState().then(resolve).catch((err) => {
                    socket.destroy();
                    reject(err);
                });
            };
            socket.once(this.transport === 'tls' ? 'secureConnect' : 'connect', onConnected);
            socket.once('error', reject);
        });
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        if (this.heartbeatIntervalMs <= 0) return;
        this.heartbeatTimer = setInterval(() => {
            if (!this.isConnected() || this.brokerState !== BrokerSessionState.Connected) return;
            this.sendBrokerMessage({vector: BrokerVector.Null}).then(() => {
                this.emit('heartbeat');
            }).catch((err) => {
                this.emit('error', this.wrapProtocolError(err, 'transport', 'PROTOCOL_ERROR'));
            });
        }, this.heartbeatIntervalMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectAttempts += 1;
        const delayMs = Math.min(this.reconnectDelayMs * (2 ** (this.reconnectAttempts - 1)), this.reconnectMaxDelayMs);
        this.emit('reconnecting', this.reconnectAttempts, delayMs);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((err) => {
                this.emit('error', this.wrapProtocolError(err, 'transport', 'PROTOCOL_ERROR'));
                if (!this.manualClose && this.autoReconnect) this.scheduleReconnect();
            });
        }, delayMs);
    }

    private stopReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private resolveWaiters(packet: RdmnetPacket): void {
        const matches = this.waiters.filter((w) => w.matcher(packet));
        if (matches.length === 0) return;
        this.waiters = this.waiters.filter((w) => !matches.includes(w));
        for (const waiter of matches) {
            clearTimeout(waiter.timeoutId);
            waiter.resolve(packet);
        }
    }

    private rejectAllWaiters(error: Error): void {
        const waiters = this.waiters.splice(0, this.waiters.length);
        for (const waiter of waiters) {
            clearTimeout(waiter.timeoutId);
            waiter.reject(error);
        }
    }

    private nextRptSequence(): number {
        this.rptSequence = (this.rptSequence + 1) >>> 0;
        if (this.rptSequence === 0) this.rptSequence = 1;
        return this.rptSequence;
    }

    private setBrokerState(next: BrokerSessionState): void {
        if (next === this.brokerState) return;
        this.brokerState = next;
        this.emit('brokerState', next);
    }

    private replaceKnownClients(clients: RptClientEntry[]): void {
        this.knownClients = new Map(clients.map((c) => [uidToString(c.uid), c]));
        this.emit('clientListUpdated');
    }

    private handleBrokerMessage(message: BrokerMessage): void {
        switch (message.vector) {
            case BrokerVector.Disconnect:
                this.setBrokerState(BrokerSessionState.TcpConnected);
                this.brokerUid = null;
                this.knownClients.clear();
                this.emit('clientListUpdated');
                break;
            case BrokerVector.ConnectedClientList:
                this.replaceKnownClients(message.clients);
                break;
            case BrokerVector.ClientAdd:
            case BrokerVector.ClientEntryChange:
                for (const client of message.clients) this.knownClients.set(uidToString(client.uid), client);
                this.emit('clientListUpdated');
                break;
            case BrokerVector.ClientRemove:
                for (const client of message.clients) this.knownClients.delete(uidToString(client.uid));
                this.emit('clientListUpdated');
                break;
            default:
                break;
        }
    }

    private wrapProtocolError(
        err: unknown,
        domain: 'transport' | 'broker' | 'rpt' | 'ept',
        code:
            | 'STREAM_FRAMING_ERROR'
            | 'BROKER_DECODE_ERROR'
            | 'RPT_DECODE_ERROR'
            | 'EPT_DECODE_ERROR'
            | 'PROTOCOL_ERROR',
        details?: Record<string, unknown>,
    ): RdmnetError {
        if (err instanceof RdmnetError) return err;
        const message = err instanceof Error ? err.message : String(err);
        return new RdmnetError({
            message,
            domain,
            code,
            details,
        });
    }
}
