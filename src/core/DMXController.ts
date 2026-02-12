/**
 * Core DMX controller that manages universes and sends them over a protocol.
 * @module core/DMXController
 */
import {Sender as SacnSender, type SenderConfiguration, type Options} from '../protocols/sacn';
import {ArtNetSender, type ArtNetSenderConfiguration} from '../protocols';
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
    /** Optional Art-Net sync pulse. */
    sendSync?(): Promise<void>;
};

/**
 * Configuration for the DMX controller.
 */
export type ControllerOptions = {
    /** Which network protocol to use for sending. Defaults to `sacn`. */
    protocol?: 'sacn' | 'artnet';
    /** If true, send a single ArtSync after each flush. */
    artSync?: boolean;
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

type UniverseEntry = {
    universe: Universe;
    sender: DmxSender;
};

/** High-level API for managing universes and sending protocol frames. */
export class DMXController {
    private readonly options: ControllerOptions;
    private readonly universes = new Map<number, UniverseEntry>();

    /**
     * Create a controller that owns universes and network senders.
     * @param options Protocol and network settings.
     */
    constructor(options: ControllerOptions = {}) {
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

        const sender = this.createSender(id);
        const entry: UniverseEntry = {universe: new Universe(id), sender};
        this.universes.set(id, entry);
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
     */
    public async flush(universeId?: number, force = false): Promise<void> {
        if (typeof universeId === 'number') {
            const entry = this.universes.get(universeId);
            if (entry) {
                await this.flushEntry(entry, force);
            }
            return;
        }

        let shouldSync = false;
        for (const entry of this.universes.values()) {
            const flushed = await this.flushEntry(entry, force);
            if (flushed) shouldSync = true;
        }
        if (shouldSync && this.options.artSync) {
            for (const entry of this.universes.values()) {
                if (entry.sender.sendSync) {
                    await entry.sender.sendSync();
                    break;
                }
            }
        }
    }

    private async flushEntry(entry: UniverseEntry, force: boolean): Promise<boolean> {
        if (!force && !entry.universe.consumeDirty()) return false;
        await entry.sender.sendRaw(entry.universe.data, {useRawDmxValues: true});
        return true;
    }

    public close(): void {
        for (const entry of this.universes.values()) {
            entry.sender.close();
        }
        this.universes.clear();
    }

    private createSender(universeId: number): DmxSender {
        if (this.options.senderFactory) {
            return this.options.senderFactory(universeId);
        }

        const protocol = this.options.protocol ?? 'sacn';
        if (protocol === 'artnet') {
            const config: ArtNetSenderConfiguration = {
                universe: universeId,
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
