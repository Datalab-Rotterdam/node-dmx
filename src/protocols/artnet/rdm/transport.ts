/**
 * RDM transport interface abstraction (used by discovery/helpers).
 * @module artnet/rdm/transport
 */
import type {UID} from './uid';
import type {RdmRequest, RdmResponse} from './types';

export type RdmTransportOptions = {
    /** Per-request timeout in milliseconds. */
    timeoutMs?: number;
};

/** Result payload for DISC_UNIQUE_BRANCH scan calls. */
export type DiscoveryUniqueBranchResult = {
    /** Raw response frames returned by the transport. */
    responses: Buffer[];
};

export interface RdmTransport {
    /** Send one standard RDM request and return decoded response (or null on timeout). */
    send(request: RdmRequest, options?: RdmTransportOptions): Promise<RdmResponse | null>;
    /** Execute DISC_UNIQUE_BRANCH for an inclusive UID range. */
    sendDiscoveryUniqueBranch(
        lower: UID,
        upper: UID,
        options?: RdmTransportOptions,
    ): Promise<DiscoveryUniqueBranchResult>;
    /** Optional transport-native DISC_MUTE helper. */
    sendMute?(uid: UID, options?: RdmTransportOptions): Promise<boolean>;
    /** Optional transport-native DISC_UN_MUTE helper. */
    sendUnMute?(uid: UID, options?: RdmTransportOptions): Promise<boolean>;
}
