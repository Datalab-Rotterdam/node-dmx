import {RdmCommandClass} from './constants';
/**
 * Convenience helpers for common RDM GET/SET requests.
 * @module artnet/rdm/helpers
 */
import type {RdmRequest, RdmResponse} from './types';
import type {RdmTransport, RdmTransportOptions} from './transport';
import type {UID} from './uid';

export type RdmRequestOptions = {
    /** Controller UID sent as request source. */
    sourceUid: UID;
    /** Transaction number (defaults to 0). */
    transactionNumber?: number;
    /** Port id (defaults to 1). */
    portId?: number;
    /** Sub-device id (defaults to 0). */
    subDevice?: number;
};

/**
 * Build a GET_COMMAND request object.
 * @param destinationUid Target device UID.
 * @param pid Parameter id.
 * @param options Shared request fields.
 * @param parameterData Optional payload bytes.
 */
export function buildGetRequest(
    destinationUid: UID,
    pid: number,
    options: RdmRequestOptions,
    parameterData?: Buffer,
): RdmRequest {
    return {
        destinationUid,
        sourceUid: options.sourceUid,
        transactionNumber: options.transactionNumber ?? 0,
        portId: options.portId ?? 1,
        subDevice: options.subDevice ?? 0,
        commandClass: RdmCommandClass.GET_COMMAND,
        pid,
        parameterData,
    };
}

/**
 * Build a SET_COMMAND request object.
 * @param destinationUid Target device UID.
 * @param pid Parameter id.
 * @param options Shared request fields.
 * @param parameterData Optional payload bytes.
 */
export function buildSetRequest(
    destinationUid: UID,
    pid: number,
    options: RdmRequestOptions,
    parameterData?: Buffer,
): RdmRequest {
    return {
        destinationUid,
        sourceUid: options.sourceUid,
        transactionNumber: options.transactionNumber ?? 0,
        portId: options.portId ?? 1,
        subDevice: options.subDevice ?? 0,
        commandClass: RdmCommandClass.SET_COMMAND,
        pid,
        parameterData,
    };
}

/**
 * Convenience wrapper: build and send a GET request through a transport.
 */
export async function sendGet(
    transport: RdmTransport,
    destinationUid: UID,
    pid: number,
    options: RdmRequestOptions,
    transportOptions?: RdmTransportOptions,
): Promise<RdmResponse | null> {
    const request = buildGetRequest(destinationUid, pid, options);
    return transport.send(request, transportOptions);
}

/**
 * Convenience wrapper: build and send a SET request through a transport.
 */
export async function sendSet(
    transport: RdmTransport,
    destinationUid: UID,
    pid: number,
    options: RdmRequestOptions,
    parameterData?: Buffer,
    transportOptions?: RdmTransportOptions,
): Promise<RdmResponse | null> {
    const request = buildSetRequest(destinationUid, pid, options, parameterData);
    return transport.send(request, transportOptions);
}
