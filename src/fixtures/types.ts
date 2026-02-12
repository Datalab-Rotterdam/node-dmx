/**
 * Fixture plugin types.
 * @module fixtures/types
 */
import type {UID as RdmUID} from '../protocols/artnet/rdm/uid';

/** Re-exported RDM UID type used by fixture identity APIs. */
export type FixtureUID = RdmUID;

/** Minimum identity information used to find the right fixture plugin. */
export type FixtureIdentity = {
    /** Full RDM UID, if known. */
    uid?: FixtureUID;
    /** ESTA manufacturer id (16-bit). */
    manufacturerId?: number;
    /** Vendor model id (16-bit). */
    modelId?: number;
    /** Current DMX start address (1-512). */
    dmxAddress?: number;
};

/** Arbitrary key/value state object consumed by fixture plugins. */
export type FixtureState = Record<string, unknown>;

/** Context passed to fixture encoders when writing DMX bytes. */
export type EncodeContext = {
    /** Zero-based start index in the universe frame. */
    base: number;
    /** Mutable universe frame buffer. */
    frame: Uint8Array;
    /** Optional render timestamp in milliseconds. */
    nowMs?: number;
};

/** Context passed to fixture decoders when reading DMX bytes. */
export type DecodeContext = {
    /** Zero-based start index in the universe frame. */
    base: number;
    /** Source universe frame buffer. */
    frame: Uint8Array;
};

/** One operating mode/personality of a fixture model. */
export type Personality = {
    /** Stable identifier used in code. */
    id: string;
    /** Human-readable name shown in UIs/docs. */
    name: string;
    /** Number of DMX channels consumed in this personality. */
    channels: number;
};

/** Plugin contract for a fixture model implementation. */
export type FixtureModelPlugin = {
    /** Optional manufacturer id for matching. */
    manufacturerId?: number;
    /** Vendor label. */
    vendor: string;
    /** Model label. */
    model: string;
    /** Available personalities for this model. */
    personalities: Personality[];
    /** Default personality id when none is specified. */
    defaultPersonalityId: string;
    /** Returns `true` when this plugin can represent the fixture identity. */
    match: (id: FixtureIdentity) => boolean;
    /** Encode fixture state into DMX bytes in-place. */
    encode: (args: {
        personalityId: string;
        state: FixtureState;
        ctx: EncodeContext;
    }) => void;
    /** Optional decode path from DMX bytes to state object. */
    decode?: (args: {personalityId: string; ctx: DecodeContext}) => FixtureState;
    /** Optional PID mappers for model-specific RDM data. */
    rdm?: {
        decodePid?: (pid: number, data: Uint8Array) => unknown;
        encodePid?: (pid: number, value: unknown) => Uint8Array;
    };
};

/** Registry abstraction for fixture model plugins. */
export type FixtureRegistry = {
    /** Register a plugin. */
    add(plugin: FixtureModelPlugin): void;
    /** Resolve the first plugin matching a fixture identity. */
    find(identity: FixtureIdentity): FixtureModelPlugin | undefined;
    /** Return all registered plugins. */
    all(): FixtureModelPlugin[];
};
