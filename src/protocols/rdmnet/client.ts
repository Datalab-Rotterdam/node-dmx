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
    BrokerClientRole,
    BrokerDisconnectReason,
    type BrokerMessage,
    BrokerSessionState,
    BrokerStatusCode,
    BrokerVector,
    decodeBrokerMessage,
    encodeBrokerMessage,
} from './broker';
import {mapBrokerStatusToError, RdmnetError} from './errors';
import {
    decodeEptMessage,
    decodeLlrpMessage,
    encodeEptMessage,
    encodeLlrpMessage,
    type EptMessage,
    LlrpVector,
    type LlrpProbeReplyMessage,
    type LlrpMessage,
} from './ept-llrp';
import {decodeRptMessage, encodeRptMessage, RptVector, type RptMessage, type RptRdmResponseMessage} from './rpt';
import type {RdmRequest, RdmResponse} from '../artnet';

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
    /** Optional fixed CID. Must be 16 bytes when provided. */
    cid?: Buffer;
    /** Enable reconnect behavior after unexpected disconnects. Default: `true`. */
    autoReconnect?: boolean;
    /** Initial reconnect backoff delay in milliseconds. */
    reconnectDelayMs?: number;
    /** Maximum reconnect backoff delay in milliseconds. */
    reconnectMaxDelayMs?: number;
    /** Interval for keepalive heartbeats in milliseconds. */
    heartbeatIntervalMs?: number;
    /** Root vector used for generic heartbeat packets while not broker-bound. */
    heartbeatVector?: number;
    /** Default timeout for request/response operations. */
    requestTimeoutMs?: number;
    /** Maximum buffered stream bytes before framing-corruption protection triggers. */
    maxBufferBytes?: number;
};

/**
 * Broker session startup options used by {@link RdmnetClient.startBrokerSession}.
 */
export type BrokerSessionOptions = {
    /** Broker scope name. */
    scope?: string;
    /** Client role used during broker connect. */
    role?: BrokerClientRole;
    /** Local endpoint ID to bind. */
    endpointId?: number;
    /** Whether to issue a bind request after successful connect reply. */
    autoBind?: boolean;
    /** Endpoint role requested during bind. */
    endpointRole?: BrokerClientRole;
    /** Requested profile set for bind negotiation. */
    profiles?: number[];
    /** Validate negotiated role/profile against request. */
    strictNegotiation?: boolean;
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
    /** Emitted when endpoint capability cache entries change. */
    endpointCapabilitiesUpdated: [endpointId: number];
    /** Emitted for decoded EPT messages. */
    eptMessage: [message: EptMessage];
    /** Emitted for decoded LLRP messages. */
    llrpMessage: [message: LlrpMessage];
    /** Emitted for decoded RPT messages. */
    rptMessage: [message: RptMessage];
    /** Emitted for decoded RPT RDM responses. */
    rdmResponse: [message: RptRdmResponseMessage];
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

export type EndpointCapabilities = {
    /** Endpoint identifier. */
    endpointId: number;
    /** Advertised or negotiated role. */
    role: BrokerClientRole | null;
    /** Normalized profile IDs. */
    profiles: number[];
    /** Source of the cached capability entry. */
    source: 'local_advertisement' | 'remote_advertisement' | 'broker_negotiation';
    /** Epoch milliseconds of last update. */
    updatedAt: number;
};

/**
 * Production-ready RDMnet transport client foundation.
 *
 * Supports plain TCP and TLS, broker session management, strict message
 * decoding, and helper APIs for RPT/EPT/LLRP flows.
 */
export class RdmnetClient extends EventEmitter<RdmnetClientEvents> {
    private readonly cid: Buffer;
    private readonly autoReconnect: boolean;
    private readonly reconnectDelayMs: number;
    private readonly reconnectMaxDelayMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly heartbeatVector: number;
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
    private rdmnetSequence = 0;

    private brokerState: BrokerSessionState = BrokerSessionState.Disconnected;
    private brokerClientId: number | null = null;
    private brokerEndpointId = 1;
    private brokerScope = 'default';
    private brokerRole: BrokerClientRole = BrokerClientRole.Controller;
    private brokerNegotiatedRole: BrokerClientRole | null = null;
    private brokerNegotiatedProfile: number | null = null;
    private endpointCapabilities = new Map<number, EndpointCapabilities>();

    constructor(private readonly options: RdmnetClientOptions) {
        super();
        this.cid = options.cid ? Buffer.from(options.cid) : makeCid();
        if (this.cid.length !== 16) {
            throw new RangeError(`RDMnet CID must be 16 bytes, got ${this.cid.length}`);
        }

        this.autoReconnect = options.autoReconnect ?? true;
        this.reconnectDelayMs = options.reconnectDelayMs ?? RDMNET_DEFAULT_RECONNECT_DELAY_MS;
        this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? RDMNET_DEFAULT_RECONNECT_MAX_DELAY_MS;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? RDMNET_DEFAULT_HEARTBEAT_MS;
        this.heartbeatVector = options.heartbeatVector ?? RdmnetRootVector.Broker;
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

    /** Returns current broker state machine value. */
    public getBrokerSessionState(): BrokerSessionState {
        return this.brokerState;
    }

    /** Returns assigned broker client ID or `null` when not connected to a broker session. */
    public getBrokerClientId(): number | null {
        return this.brokerClientId;
    }

    /** Returns negotiated broker role after bind, if available. */
    public getBrokerNegotiatedRole(): BrokerClientRole | null {
        return this.brokerNegotiatedRole;
    }

    /** Returns negotiated broker profile after bind, if available. */
    public getBrokerNegotiatedProfile(): number | null {
        return this.brokerNegotiatedProfile;
    }

    /** Returns cached capabilities for one endpoint, if present. */
    public getEndpointCapabilities(endpointId: number): EndpointCapabilities | null {
        const entry = this.endpointCapabilities.get(endpointId);
        return entry ? {...entry, profiles: [...entry.profiles]} : null;
    }

    /** Lists all cached endpoint capability entries. */
    public listEndpointCapabilities(): EndpointCapabilities[] {
        return Array.from(this.endpointCapabilities.values()).map((entry) => ({
            ...entry,
            profiles: [...entry.profiles],
        }));
    }

    /** Gracefully closes the socket and resets session/cache state. */
    public disconnect(): void {
        this.manualClose = true;
        this.stopReconnectTimer();
        this.stopHeartbeat();
        this.rejectAllWaiters(new Error('RDMnet client disconnected'));
        this.socket?.end();
        this.socket = null;
        this.setBrokerState(BrokerSessionState.Disconnected);
        this.brokerClientId = null;
        this.brokerNegotiatedRole = null;
        this.brokerNegotiatedProfile = null;
        this.endpointCapabilities.clear();
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

    /** Waits for a decoded LLRP message matching a type guard. */
    public waitForLlrpMessage<T extends LlrpMessage>(
        matcher: (message: LlrpMessage) => message is T,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<T> {
        return this.waitForMessage((packet) => {
            if (packet.vector !== RdmnetRootVector.Llrp) return false;
            try {
                return matcher(decodeLlrpMessage(packet.data));
            } catch {
                return false;
            }
        }, timeoutMs).then((packet) => decodeLlrpMessage(packet.data) as T);
    }

    /**
     * Sends an LLRP probe request and returns the generated sequence ID.
     */
    public async sendLlrpProbeRequest(lowerUid: Buffer, upperUid: Buffer): Promise<number> {
        const sequence = this.nextRdmnetSequence();
        await this.sendLlrpMessage({
            vector: LlrpVector.ProbeRequest,
            sequence,
            lowerUid,
            upperUid,
        });
        return sequence;
    }

    /**
     * Sends one LLRP probe request and collects unique probe replies for `timeoutMs`.
     */
    public async discoverLlrpTargets(
        lowerUid: Buffer,
        upperUid: Buffer,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<LlrpProbeReplyMessage[]> {
        if (lowerUid.length !== 6 || upperUid.length !== 6) {
            throw new RangeError('LLRP UID bounds must be 6-byte buffers');
        }
        const found = new Map<string, LlrpProbeReplyMessage>();
        const onMessage = (message: LlrpMessage): void => {
            if (message.vector !== LlrpVector.ProbeReply) return;
            if (message.sequence !== sequence) return;
            found.set(message.targetUid.toString('hex'), message);
        };

        const sequence = this.nextRdmnetSequence();
        this.on('llrpMessage', onMessage);
        await this.sendLlrpMessage({
            vector: LlrpVector.ProbeRequest,
            sequence,
            lowerUid,
            upperUid,
        });
        await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        this.off('llrpMessage', onMessage);
        return Array.from(found.values());
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

    /** Encodes and sends one LLRP payload. */
    public async sendLlrpMessage(message: LlrpMessage): Promise<void> {
        await this.sendPacket({
            vector: RdmnetRootVector.Llrp,
            data: encodeLlrpMessage(message),
        });
    }

    /**
     * Runs broker connect + optional bind flow and updates broker negotiation state.
     */
    public async startBrokerSession(options: BrokerSessionOptions = {}): Promise<void> {
        await this.connect();
        if (this.brokerState === BrokerSessionState.Bound) return;
        if (this.brokerState !== BrokerSessionState.TcpConnected && this.brokerState !== BrokerSessionState.Error) {
            throw new Error(`Cannot start broker session from state "${this.brokerState}"`);
        }

        const scope = options.scope ?? this.brokerScope;
        const role = options.role ?? this.brokerRole;
        const endpointId = options.endpointId ?? this.brokerEndpointId;
        const autoBind = options.autoBind ?? true;
        const endpointRole = options.endpointRole ?? role;
        const profiles = options.profiles ?? [];
        const strictNegotiation = options.strictNegotiation ?? true;
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

        this.brokerScope = scope;
        this.brokerRole = role;
        this.brokerEndpointId = endpointId;

        const connectSeq = this.nextRdmnetSequence();
        this.setBrokerState(BrokerSessionState.Connecting);
        const connectReplyPromise = this.waitForBrokerMessage(
            (message): message is Extract<BrokerMessage, {vector: BrokerVector.ConnectReply}> =>
                message.vector === BrokerVector.ConnectReply && message.sequence === connectSeq,
            timeoutMs,
        );
        await this.sendBrokerMessage({
            vector: BrokerVector.ConnectRequest,
            sequence: connectSeq,
            role,
            scope,
        });
        const connectReply = await connectReplyPromise;

        if (connectReply.statusCode !== BrokerStatusCode.Ok) {
            this.setBrokerState(BrokerSessionState.Error);
            throw mapBrokerStatusToError(
                connectReply.statusCode,
                connectReply.text || 'Broker connect rejected',
                {phase: 'connect', scope},
            );
        }

        this.brokerClientId = connectReply.clientId;
        this.setBrokerState(BrokerSessionState.Connected);
        if (!autoBind) return;

        const bindSeq = this.nextRdmnetSequence();
        this.setBrokerState(BrokerSessionState.Binding);
        const bindReplyPromise = this.waitForBrokerMessage(
            (message): message is Extract<BrokerMessage, {vector: BrokerVector.ClientBindReply}> =>
                message.vector === BrokerVector.ClientBindReply
                && message.sequence === bindSeq
                && message.endpointId === endpointId,
            timeoutMs,
        );
        await this.sendBrokerMessage({
            vector: BrokerVector.ClientBindRequest,
            sequence: bindSeq,
            endpointId,
            requestedRole: endpointRole,
            profiles,
        });
        const bindReply = await bindReplyPromise;

        if (bindReply.statusCode !== BrokerStatusCode.Ok) {
            this.setBrokerState(BrokerSessionState.Error);
            throw mapBrokerStatusToError(
                bindReply.statusCode,
                bindReply.text || 'Broker bind rejected',
                {phase: 'bind', endpointId},
            );
        }

        if (strictNegotiation) {
            const negotiatedRole = bindReply.negotiatedRole ?? endpointRole;
            if (negotiatedRole !== endpointRole) {
                this.setBrokerState(BrokerSessionState.Error);
                throw new RdmnetError({
                    message: `Broker negotiated role ${negotiatedRole} but endpoint requested role ${endpointRole}`,
                    domain: 'negotiation',
                    code: 'NEGOTIATION_ROLE_MISMATCH',
                    details: {requestedRole: endpointRole, negotiatedRole},
                });
            }
            if (profiles.length > 0) {
                const negotiatedProfile = bindReply.negotiatedProfile;
                if (negotiatedProfile === undefined || negotiatedProfile === null || !profiles.includes(negotiatedProfile)) {
                    this.setBrokerState(BrokerSessionState.Error);
                    throw new RdmnetError({
                        message: `Broker negotiated profile ${negotiatedProfile ?? 'none'} not in requested profiles [${profiles.join(', ')}]`,
                        domain: 'negotiation',
                        code: 'NEGOTIATION_PROFILE_MISMATCH',
                        details: {requestedProfiles: profiles, negotiatedProfile},
                    });
                }
            }
        }

        this.brokerNegotiatedRole = bindReply.negotiatedRole ?? endpointRole;
        this.brokerNegotiatedProfile = bindReply.negotiatedProfile ?? null;
        this.updateEndpointCapabilities(
            endpointId,
            this.brokerNegotiatedRole,
            this.brokerNegotiatedProfile === null ? profiles : [this.brokerNegotiatedProfile],
            'broker_negotiation',
        );
        this.setBrokerState(BrokerSessionState.Bound);
    }

    /** Sends broker disconnect and resets broker-bound state. */
    public async stopBrokerSession(reason = BrokerDisconnectReason.Graceful, text = ''): Promise<void> {
        if (!this.isConnected()) return;
        await this.sendBrokerMessage({
            vector: BrokerVector.Disconnect,
            sequence: this.nextRdmnetSequence(),
            reason,
            text,
        });
        this.setBrokerState(BrokerSessionState.TcpConnected);
        this.brokerClientId = null;
        this.brokerNegotiatedRole = null;
        this.brokerNegotiatedProfile = null;
        this.endpointCapabilities.clear();
    }

    /** Requests broker client list and returns client IDs on success. */
    public async requestBrokerClientList(timeoutMs = this.requestTimeoutMs): Promise<number[]> {
        const sequence = this.nextRdmnetSequence();
        const responsePromise = this.waitForBrokerMessage(
            (message): message is Extract<BrokerMessage, {vector: BrokerVector.ClientListReply}> =>
                message.vector === BrokerVector.ClientListReply && message.sequence === sequence,
            timeoutMs,
        );
        await this.sendBrokerMessage({
            vector: BrokerVector.ClientListRequest,
            sequence,
        });
        const reply = await responsePromise;
        if (reply.statusCode !== BrokerStatusCode.Ok) {
            throw mapBrokerStatusToError(reply.statusCode, 'Broker client list request failed');
        }
        return [...reply.clients];
    }

    /** Requests broker endpoint list and returns endpoint IDs on success. */
    public async requestBrokerEndpointList(timeoutMs = this.requestTimeoutMs): Promise<number[]> {
        const sequence = this.nextRdmnetSequence();
        const responsePromise = this.waitForBrokerMessage(
            (message): message is Extract<BrokerMessage, {vector: BrokerVector.EndpointListReply}> =>
                message.vector === BrokerVector.EndpointListReply && message.sequence === sequence,
            timeoutMs,
        );
        await this.sendBrokerMessage({
            vector: BrokerVector.EndpointListRequest,
            sequence,
        });
        const reply = await responsePromise;
        if (reply.statusCode !== BrokerStatusCode.Ok) {
            throw mapBrokerStatusToError(reply.statusCode, 'Broker endpoint list request failed');
        }
        return [...reply.endpoints];
    }

    /** Encodes and sends one RPT payload. */
    public async sendRptMessage(message: RptMessage): Promise<void> {
        await this.sendPacket({
            vector: RdmnetRootVector.Rpt,
            data: encodeRptMessage(message),
        });
    }

    /** Sends an RPT RDM command and returns the generated sequence ID. */
    public async sendRdmCommand(request: RdmRequest, endpointId = 1): Promise<number> {
        const sequence = this.nextRdmnetSequence();
        await this.sendRptMessage({
            vector: RptVector.RdmCommand,
            sequence,
            endpointId,
            request,
        });
        return sequence;
    }

    /**
     * Sends an RPT RDM command and waits for the correlated RDM response.
     */
    public async rdmTransaction(
        request: RdmRequest,
        endpointId = 1,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<RdmResponse> {
        const sequence = this.nextRdmnetSequence();
        const responsePromise = this.waitForMessage((packet) => {
            if (packet.vector !== RdmnetRootVector.Rpt) return false;
            try {
                const rpt = decodeRptMessage(packet.data);
                return rpt.vector === RptVector.RdmResponse && rpt.sequence === sequence;
            } catch {
                return false;
            }
        }, timeoutMs).then((packet) => {
            const rpt = decodeRptMessage(packet.data);
            if (rpt.vector !== RptVector.RdmResponse) {
                throw new Error('Received non-RDM response for RDM transaction');
            }
            return rpt.response;
        });

        await this.sendRptMessage({
            vector: RptVector.RdmCommand,
            sequence,
            endpointId,
            request,
        });
        return responsePromise;
    }

    /** Sends an RPT status message and returns the generated sequence ID. */
    public async sendStatus(statusCode: number, text = ''): Promise<number> {
        const sequence = this.nextRdmnetSequence();
        await this.sendRptMessage({
            vector: RptVector.Status,
            sequence,
            statusCode,
            text,
        });
        return sequence;
    }

    /**
     * Sends an endpoint advertisement and updates local endpoint capability cache.
     */
    public async sendEndpointAdvertisement(
        endpointId: number,
        role: BrokerClientRole,
        profiles: number[],
    ): Promise<number> {
        const sequence = this.nextRdmnetSequence();
        await this.sendRptMessage({
            vector: RptVector.EndpointAdvertisement,
            sequence,
            endpointId,
            role,
            profiles,
        });
        this.updateEndpointCapabilities(endpointId, role, profiles, 'local_advertisement');
        return sequence;
    }

    /**
     * Waits for endpoint advertisement acknowledgement for a specific sequence/endpoint pair.
     */
    public waitForEndpointAdvertisementAck(
        sequence: number,
        endpointId: number,
        timeoutMs = this.requestTimeoutMs,
    ): Promise<Extract<RptMessage, {vector: RptVector.EndpointAdvertisementAck}>> {
        return this.waitForMessage((packet) => {
            if (packet.vector !== RdmnetRootVector.Rpt) return false;
            try {
                const rpt = decodeRptMessage(packet.data);
                return rpt.vector === RptVector.EndpointAdvertisementAck
                    && rpt.sequence === sequence
                    && rpt.endpointId === endpointId;
            } catch {
                return false;
            }
        }, timeoutMs).then((packet) => {
            const rpt = decodeRptMessage(packet.data);
            if (rpt.vector !== RptVector.EndpointAdvertisementAck) {
                throw new Error('Expected endpoint advertisement ack');
            }
            return rpt;
        });
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

                    if (packet.vector === RdmnetRootVector.Llrp) {
                        try {
                            this.emit('llrpMessage', decodeLlrpMessage(packet.data));
                        } catch (err) {
                            this.emit('error', this.wrapProtocolError(err, 'llrp', 'LLRP_DECODE_ERROR', {
                                rootVector: packet.vector,
                            }));
                        }
                    }

                    if (packet.vector === RdmnetRootVector.Rpt) {
                        try {
                            const rpt = decodeRptMessage(packet.data);
                            if (rpt.vector === RptVector.EndpointAdvertisement) {
                                this.updateEndpointCapabilities(
                                    rpt.endpointId,
                                    rpt.role,
                                    rpt.profiles,
                                    'remote_advertisement',
                                );
                            }
                            this.emit('rptMessage', rpt);
                            if (rpt.vector === RptVector.RdmResponse) {
                                this.emit('rdmResponse', rpt);
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
            this.brokerClientId = null;
            this.brokerNegotiatedRole = null;
            this.brokerNegotiatedProfile = null;
            this.endpointCapabilities.clear();
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
            if (!this.isConnected()) return;
            const action = this.brokerState === BrokerSessionState.Connected || this.brokerState === BrokerSessionState.Bound
                ? this.sendBrokerMessage({
                    vector: BrokerVector.Heartbeat,
                    sequence: this.nextRdmnetSequence(),
                })
                : this.sendPacket({
                    vector: this.heartbeatVector,
                    data: Buffer.alloc(0),
                });
            action.then(() => {
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

    private nextRdmnetSequence(): number {
        this.rdmnetSequence = (this.rdmnetSequence + 1) >>> 0;
        if (this.rdmnetSequence === 0) this.rdmnetSequence = 1;
        return this.rdmnetSequence;
    }

    private setBrokerState(next: BrokerSessionState): void {
        if (next === this.brokerState) return;
        this.brokerState = next;
        this.emit('brokerState', next);
    }

    private handleBrokerMessage(message: BrokerMessage): void {
        if (message.vector === BrokerVector.Disconnect) {
            this.setBrokerState(BrokerSessionState.TcpConnected);
            this.brokerClientId = null;
            this.brokerNegotiatedRole = null;
            this.brokerNegotiatedProfile = null;
            this.endpointCapabilities.clear();
        }
    }

    private updateEndpointCapabilities(
        endpointId: number,
        role: BrokerClientRole | null,
        profiles: number[],
        source: EndpointCapabilities['source'],
    ): void {
        const normalizedProfiles = Array.from(new Set(profiles.map((p) => p & 0xffff))).sort((a, b) => a - b);
        const prev = this.endpointCapabilities.get(endpointId);
        const next: EndpointCapabilities = {
            endpointId,
            role,
            profiles: normalizedProfiles,
            source,
            updatedAt: Date.now(),
        };
        const changed = !prev
            || prev.role !== next.role
            || prev.source !== next.source
            || prev.profiles.length !== next.profiles.length
            || prev.profiles.some((p, i) => p !== next.profiles[i]);
        this.endpointCapabilities.set(endpointId, next);
        if (changed) this.emit('endpointCapabilitiesUpdated', endpointId);
    }

    private wrapProtocolError(
        err: unknown,
        domain: 'transport' | 'broker' | 'rpt' | 'ept' | 'llrp',
        code:
            | 'STREAM_FRAMING_ERROR'
            | 'BROKER_DECODE_ERROR'
            | 'RPT_DECODE_ERROR'
            | 'EPT_DECODE_ERROR'
            | 'LLRP_DECODE_ERROR'
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
