/**
 * E1.31 Universe Discovery source (§8): periodically advertises the set of
 * universes a component is currently transmitting, to the well-known
 * discovery multicast group, so controllers can enumerate active sources
 * without joining every possible universe.
 * @module sacn/discovery
 */
import {type Socket, createSocket} from 'dgram';
import {DISCOVERY_INTERVAL_MS, DISCOVERY_UNIVERSE, MAX_UNIVERSES_PER_DISCOVERY_PAGE} from './constants';
import {buildUniverseDiscoveryPacket} from './extended';
import {multicastGroup, randomCid} from './util';

export type UniverseDiscoverySourceOptions = {
    /** 16-byte CID identifying this source. Defaults to a random one. */
    cid?: Buffer;
    /** Source name advertised in the packet (max 64 ASCII chars). */
    sourceName?: string;
    /** UDP port (default 5568). */
    port?: number;
    /** Local multicast interface address. */
    iface?: string;
    /** Resend interval in ms (default {@link DISCOVERY_INTERVAL_MS}, per §8.6). */
    intervalMs?: number;
};

/** Advertises a source's active universe list via periodic Universe Discovery packets. */
export class UniverseDiscoverySource {
    private readonly socket: Socket;
    private readonly cid: Buffer;
    private readonly sourceName?: string;
    private readonly port: number;
    private readonly destinationIp: string;
    private readonly intervalMs: number;
    private universes: number[] = [];
    private timer: NodeJS.Timeout | undefined;

    constructor(options: UniverseDiscoverySourceOptions = {}) {
        this.cid = options.cid ? Buffer.from(options.cid) : randomCid();
        if (this.cid.length !== 16) throw new RangeError(`CID must be 16 bytes, got ${this.cid.length}`);
        this.sourceName = options.sourceName;
        this.port = options.port ?? 5568;
        this.destinationIp = multicastGroup(DISCOVERY_UNIVERSE);
        this.intervalMs = options.intervalMs ?? DISCOVERY_INTERVAL_MS;
        this.socket = createSocket({type: 'udp4'});
        if (options.iface) {
            this.socket.bind(0, () => {
                try {
                    this.socket.setMulticastInterface(options.iface!);
                } catch {
                    // Best-effort; fall back to default interface on failure.
                }
            });
        }
    }

    /** Replaces the advertised universe list (sorted, de-duplicated). */
    public setUniverses(universes: number[]): void {
        this.universes = Array.from(new Set(universes)).sort((a, b) => a - b);
    }

    /** Sends the current universe list as one or more discovery pages immediately. */
    public async advertiseOnce(): Promise<void> {
        const pages: number[][] = [];
        for (let i = 0; i < this.universes.length; i += MAX_UNIVERSES_PER_DISCOVERY_PAGE) {
            pages.push(this.universes.slice(i, i + MAX_UNIVERSES_PER_DISCOVERY_PAGE));
        }
        if (pages.length === 0) pages.push([]);

        const lastPage = pages.length - 1;
        for (let page = 0; page < pages.length; page++) {
            const packet = buildUniverseDiscoveryPacket({
                cid: this.cid,
                sourceName: this.sourceName,
                page,
                lastPage,
                universes: pages[page]!,
            });
            await this.send(packet);
        }
    }

    /** Starts periodic advertisement (sends immediately, then every `intervalMs`). */
    public start(): void {
        this.stop();
        void this.advertiseOnce();
        this.timer = setInterval(() => {
            void this.advertiseOnce();
        }, this.intervalMs);
    }

    /** Stops periodic advertisement without closing the socket. */
    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private send(packet: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.send(packet, this.port, this.destinationIp, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    public close(): void {
        this.stop();
        this.socket.close();
    }
}
