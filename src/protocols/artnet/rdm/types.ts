import {RdmCommandClass, RdmResponseType} from './constants';
import {UID} from './uid';

/**
 * RDM request/response types.
 * @module artnet/rdm/types
 *
 * Spec reference:
 * - ANSI E1.20 RDM
 *   https://getdlight.com/media/kunena/attachments/42/ANSI_E1-20_2010.pdf
 */
export type RdmRequest = {
    /** Destination device UID. */
    destinationUid: UID;
    /** Controller/source UID. */
    sourceUid: UID;
    /** Transaction number (0-255). */
    transactionNumber: number;
    /** Port id from controller perspective. */
    portId: number;
    /** Queued message counter if used. */
    messageCount?: number;
    /** Sub-device id (0 for root device). */
    subDevice?: number;
    /** RDM command class (GET/SET/DISCOVERY). */
    commandClass: RdmCommandClass;
    /** Parameter ID (PID). */
    pid: number;
    /** Optional parameter data payload. */
    parameterData?: Buffer;
};

export type RdmResponse = {
    /** Destination UID from response (usually controller UID). */
    destinationUid: UID;
    /** Source UID of the responder fixture/device. */
    sourceUid: UID;
    /** Echoed transaction number. */
    transactionNumber: number;
    /** Response status type (ACK/NACK/etc.). */
    responseType: RdmResponseType;
    /** Number of queued messages pending. */
    messageCount: number;
    /** Sub-device id of response. */
    subDevice: number;
    /** Response command class. */
    commandClass: RdmCommandClass;
    /** Response PID. */
    pid: number;
    /** Response parameter payload bytes. */
    parameterData: Buffer;
};

/** One discovered RDM device and whether it was muted during search. */
export type RdmDiscoveryResult = {
    uid: UID;
    muted: boolean;
};
