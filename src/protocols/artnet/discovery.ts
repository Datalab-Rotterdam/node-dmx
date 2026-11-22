/**
 * Art-Net 4 node discovery via ArtPoll/ArtPollReply.
 * @module artnet/discovery
 *
 * Spec reference:
 * - Art-Net 4 Specification (OpPoll, OpPollReply)
 *   https://art-net.org.uk/downloads/art-net.pdf
 */
import {createSocket, type Socket} from 'dgram';
import {EventEmitter} from 'events';
import {ARTNET_PORT} from './constants';
import {buildArtPoll, type ArtPollOptions, parseArtPollReply, type ArtPollReply} from './packet';
import {directedBroadcastAddress} from './util';

export type ArtNetDiscoveryOptions = {
    /** Time window for collecting replies in `pollOnce`. */
    timeoutMs?: number;
    /** Optional local bind address for receiving replies. */
    bindAddress?: string;
    /** UDP port override (default Art-Net port 6454). */
    port?: number;
    /**
     * Local UDP port to receive replies on. Art-Net nodes send ArtPollReply to
     * port 6454, so that is the default (bound with `reuseAddr`). Use `0` for
     * an ephemeral port (only nodes that reply to the source port will be seen).
     */
    listenPort?: number;
    /** Broadcast address to poll. Defaults to the directed broadcast of `bindAddress`, else `255.255.255.255`. */
    broadcastAddress?: string;
};

export interface ArtNetDiscoveryEvents {
    /** Emitted for each valid ArtPollReply packet. */
    reply: [ArtPollReply];
    /** Socket-level errors. */
    error: [Error];
}

/** Utility class for discovering Art-Net nodes via ArtPoll. */
export class ArtNetDiscovery extends EventEmitter<ArtNetDiscoveryEvents> {
    private readonly socket: Socket;
    private readonly ready: Promise<void>;
    private readonly broadcastAddress: string;
    private closed = false;

    /**
     * Create a discovery helper that can send ArtPoll and receive replies.
     * @param options Socket bind and timeout options.
     */
    constructor(options: ArtNetDiscoveryOptions = {}) {
        super();
        this.broadcastAddress = options.broadcastAddress
            ?? (options.bindAddress ? directedBroadcastAddress(options.bindAddress) : undefined)
            ?? '255.255.255.255';
        this.socket = createSocket({type: 'udp4', reuseAddr: true});
        this.socket.on('error', (err) => {
            if (this.listenerCount('error') > 0) this.emit('error', err);
        });
        this.socket.on('message', (msg) => {
            try {
                const reply = parseArtPollReply(msg);
                if (reply) this.emit('reply', reply);
            } catch {
                // Malformed reply from the network: ignore.
            }
        });
        // setBroadcast() throws EBADF until the socket has actually finished
        // binding — bind and wait for it, since a caller may call
        // sendPoll()/pollOnce() on the very next line.
        this.ready = new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            this.socket.once('error', onError);
            const port = options.listenPort ?? ARTNET_PORT;
            this.socket.bind(options.bindAddress ? {address: options.bindAddress, port} : {port}, () => {
                this.socket.off('error', onError);
                try {
                    this.socket.setBroadcast(true);
                    resolve();
                } catch (err) {
                    reject(err as Error);
                }
            });
        });
        this.ready.catch(() => undefined);
    }

    /**
     * Send a poll and collect replies for a short timeout.
     */
    public async pollOnce(
        pollOptions: ArtPollOptions = {},
        options: ArtNetDiscoveryOptions = {},
    ): Promise<ArtPollReply[]> {
        const replies: ArtPollReply[] = [];
        const handler = (reply: ArtPollReply) => replies.push(reply);
        this.on('reply', handler);
        try {
            await this.sendPoll(pollOptions, options);
            const timeout = options.timeoutMs ?? 1000;
            await new Promise((resolve) => setTimeout(resolve, timeout));
        } finally {
            this.off('reply', handler);
        }
        return replies;
    }

    /**
     * Send an ArtPoll packet without waiting for replies.
     */
    public async sendPoll(pollOptions: ArtPollOptions = {}, options: ArtNetDiscoveryOptions = {}): Promise<void> {
        await this.ready;
        const packet = buildArtPoll(pollOptions);
        const port = options.port ?? ARTNET_PORT;
        await new Promise<void>((resolve, reject) => {
            this.socket.send(packet, port, options.broadcastAddress ?? this.broadcastAddress, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    /**
     * Close the UDP socket. Safe to call more than once.
     */
    public close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.socket.close();
        } catch {
            // Already closed.
        }
    }
}
