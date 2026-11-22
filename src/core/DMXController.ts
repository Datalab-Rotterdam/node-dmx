/**
 * Core DMX controller that manages universes and sends them over a protocol.
 * @module core/DMXController
 */
import {EventEmitter} from 'events';
import {Sender as SacnSender, type SenderConfiguration, type Options} from '../protocols/sacn';
import {ArtNetSender, type ArtNetSenderConfiguration} from '../protocols/artnet';
import {Universe} from './Universe';

/**
 * Minimal sender interface used by the controller.
 * Protocol senders (sACN, Art-Net) implement this shape.
 */
export type DmxSender = {
    /** Send a raw 512-byte DMX frame (or smaller). */
    sendRaw(data: Uint8Array | Buffer, options?: Record<string, unknown>): Promise<void>;
    /** Close any open sockets and clean up resources. */
    close(): void;
    /**
     * Optional sync pulse: ArtSync for Art-Net, or an E1.31 Synchronization
     * Packet (to `syncAddress`) for sACN.
     */
    sendSync?(syncAddress?: number): Promise<void>;
};

/**
 * Configuration for the DMX controller.
 */
export type ControllerOptions = {
    /** Which network protocol to use for sending. Defaults to `sacn`. */
    protocol?: 'sacn' | 'artnet';
    /** If true, send a single ArtSync after each flush. */
    artSync?: boolean;
    /**
     * sACN only: universe number used as the E1.31 Synchronization Address.
     * When set, data packets ask receivers to wait for sync, and one
     * Synchronization Packet is sent after each flush.
     */
    sacnSyncUniverse?: number;
    /**
     * Art-Net only: treat universe ids as raw 15-bit Port-Addresses (0-32767,
     * as shown on most Art-Net consoles/nodes) instead of the default 1-based
     * numbering (where universe 1 = Port-Address 0).
     */
    artnetPortAddressing?: boolean;
    /**
     * Resend every universe at least this often (ms), even when unchanged.
     * sACN receivers drop a source after 2.5 s without data (E1.31 §6.7.1)
     * and many Art-Net nodes behave similarly. Set to `0` to disable.
     * @default 1000
     */
    keepAliveMs?: number;
    /** Provide a custom sender factory if you want full control. */
    senderFactory?: (universeId: number) => DmxSender;
    /** UDP port used by protocol sender. */
    port?: number;
    /** Allow multiple listeners/senders on same UDP port. */
    reuseAddr?: boolean;
    /** Keep-alive resend rate in packets/second (sACN sender option). */
    refreshRate?: number;
    /** Local network interface IPv4 address. */
    iface?: string;
    /** Optional unicast destination instead of multicast/broadcast. */
    unicastDestination?: string;
    /** Default E1.31 packet metadata applied to every send. */
    defaultPacketOptions?: Partial<
        Pick<Options, 'cid' | 'sourceName' | 'priority' | 'useRawDmxValues'>
    >;
    /** sACN specific overrides. */
    sacn?: Partial<SenderConfiguration>;
    /** Art-Net specific overrides. */
    artnet?: Partial<ArtNetSenderConfiguration>;
};

export interface DMXControllerEvents {
    /** Background keep-alive send failures. Only emitted when a listener is attached. */
    error: [Error];
}

type UniverseEntry = {
    universe: Universe;
    sender: DmxSender;
    lastSent: number;
};

/** High-level API for managing universes and sending protocol frames. */
export class DMXController extends EventEmitter<DMXControllerEvents> {
    private readonly options: ControllerOptions;
    private readonly universes = new Map<number, UniverseEntry>();
    private keepAliveTimer: NodeJS.Timeout | undefined;
    private keepAliveRunning = false;

    /**
     * Create a controller that owns universes and network senders.
     * @param options Protocol and network settings.
     */
    constructor(options: ControllerOptions = {}) {
        super();
        this.options = options;
    }

    /**
     * Get (or create) a universe by id.
     */
    public universe(id: number): Universe {
        return this.addUniverse(id);
    }

    /**
     * Create a universe if it does not already exist.
     */
    public addUniverse(id: number): Universe {
        const existing = this.universes.get(id);
        if (existing) return existing.universe;

        const universe = new Universe(id, this.universeRange());
        const sender = this.createSender(id);
        const entry: UniverseEntry = {universe, sender, lastSent: 0};
        this.universes.set(id, entry);
        this.startKeepAlive();
        return entry.universe;
    }

    /**
     * Convenience method to set one channel in a specific universe.
     * @param universeId Universe id.
     * @param address Channel address (1-512).
     * @param value Channel value (0-255).
     * @returns The target universe instance.
     */
    public setChannel(universeId: number, address: number, value: number): Universe {
        const universe = this.addUniverse(universeId);
        universe.setChannel(address, value);
        return universe;
    }

    /**
     * Replace the entire universe frame (max 512 bytes).
     */
    public setFrame(universeId: number, frame: Uint8Array | Buffer): Universe {
        const universe = this.addUniverse(universeId);
        universe.setFrame(frame);
        return universe;
    }

    /**
     * Flush a single universe or all universes to the network.
     * Universes are sent concurrently; a sync pulse (ArtSync or E1.31
     * Synchronization) follows when configured and something was sent.
     */
    public async flush(universeId?: number, force = false): Promise<void> {
        const entries = typeof universeId === 'number'
            ? [this.universes.get(universeId)].filter((e): e is UniverseEntry => !!e)
            : [...this.universes.values()];

        const results = await Promise.all(entries.map((entry) => this.flushEntry(entry, force)));
        if (typeof universeId === 'number' || !results.some(Boolean)) return;
        await this.sendSyncPulse();
    }

    /** Close all senders and stop the keep-alive loop. */
    public close(): void {
        this.stopKeepAlive();
        for (const entry of this.universes.values()) {
            entry.sender.close();
        }
        this.universes.clear();
    }

    private async flushEntry(entry: UniverseEntry, force: boolean): Promise<boolean> {
        if (!force && !entry.universe.isDirty()) return false;
        // Consume before the await so changes made during the send aren't lost.
        entry.universe.consumeDirty();
        const options: Record<string, unknown> = {useRawDmxValues: true};
        if (this.sacnSyncUniverse !== undefined) options.syncUniverse = this.sacnSyncUniverse;
        try {
            await entry.sender.sendRaw(entry.universe.data, options);
        } catch (err) {
            entry.universe.markDirty();
            throw err;
        }
        entry.lastSent = Date.now();
        return true;
    }

    private async sendSyncPulse(): Promise<void> {
        const syncUniverse = this.sacnSyncUniverse;
        if (!this.options.artSync && syncUniverse === undefined) return;
        for (const entry of this.universes.values()) {
            if (entry.sender.sendSync) {
                await (syncUniverse !== undefined ? entry.sender.sendSync(syncUniverse) : entry.sender.sendSync());
                return;
            }
        }
    }

    private get sacnSyncUniverse(): number | undefined {
        return (this.options.protocol ?? 'sacn') === 'sacn' ? this.options.sacnSyncUniverse : undefined;
    }

    private get keepAliveMs(): number {
        return this.options.keepAliveMs ?? 1000;
    }

    private startKeepAlive(): void {
        if (this.keepAliveTimer || this.keepAliveMs <= 0) return;
        const tick = Math.max(25, Math.floor(this.keepAliveMs / 4));
        this.keepAliveTimer = setInterval(() => void this.keepAlive(), tick);
        // Real senders hold bound sockets that keep the process alive; the
        // timer itself shouldn't.
        this.keepAliveTimer.unref();
    }

    private stopKeepAlive(): void {
        if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = undefined;
    }

    private async keepAlive(): Promise<void> {
        if (this.keepAliveRunning) return;
        this.keepAliveRunning = true;
        try {
            const now = Date.now();
            const stale = [...this.universes.values()].filter(
                (entry) => entry.lastSent > 0 && now - entry.lastSent >= this.keepAliveMs,
            );
            if (stale.length === 0) return;
            await Promise.all(stale.map((entry) => this.flushEntry(entry, true)));
            await this.sendSyncPulse();
        } catch (err) {
            if (this.listenerCount('error') > 0) this.emit('error', err as Error);
        } finally {
            this.keepAliveRunning = false;
        }
    }

    private universeRange(): {min: number; max: number} {
        if (this.options.protocol === 'artnet') {
            return this.options.artnetPortAddressing ? {min: 0, max: 32767} : {min: 1, max: 32768};
        }
        return {min: 1, max: 63999};
    }

    private createSender(universeId: number): DmxSender {
        if (this.options.senderFactory) {
            return this.options.senderFactory(universeId);
        }

        const protocol = this.options.protocol ?? 'sacn';
        if (protocol === 'artnet') {
            const addressing = this.options.artnetPortAddressing
                ? {portAddress: universeId}
                : {universe: universeId};
            const config: ArtNetSenderConfiguration = {
                ...addressing,
                host: this.options.artnet?.host ?? this.options.unicastDestination,
                port: this.options.artnet?.port ?? this.options.port,
                bindAddress: this.options.artnet?.bindAddress ?? this.options.iface,
                broadcast: this.options.artnet?.broadcast ?? !this.options.unicastDestination,
                physical: this.options.artnet?.physical,
                sequence: this.options.artnet?.sequence ?? true,
            };
            return new ArtNetSender(config);
        }

        const senderConfig: SenderConfiguration = {
            universe: universeId,
            port: this.options.port,
            reuseAddr: this.options.reuseAddr,
            refreshRate: this.options.refreshRate,
            iface: this.options.iface,
            useUnicastDestination: this.options.unicastDestination,
            defaultPacketOptions: this.options.defaultPacketOptions,
            ...this.options.sacn,
        };
        return new SacnSender(senderConfig);
    }
}
