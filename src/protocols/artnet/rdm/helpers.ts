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
    /**
     * Transaction number. When omitted, the transport's
     * `nextTransactionNumber()` is used if available (send helpers), otherwise
     * a module-wide auto-incrementing counter (0-255, wrapping).
     */
    transactionNumber?: number;
    /** Port id (defaults to 1). */
    portId?: number;
    /** Sub-device id (defaults to 0). */
    subDevice?: number;
};

let sharedTransactionCounter = 0;

/**
 * Return the next value of the module-wide RDM transaction counter
 * (0-255, wrapping). Used when a request has no explicit transaction number
 * and the transport does not provide its own counter.
 */
export function nextRdmTransactionNumber(): number {
    const tn = sharedTransactionCounter;
    sharedTransactionCounter = (tn + 1) & 0xff;
    return tn;
}

function resolveTransactionNumber(options: RdmRequestOptions, transport?: RdmTransport): number {
    if (options.transactionNumber !== undefined) return options.transactionNumber & 0xff;
    const fromTransport = transport?.nextTransactionNumber?.();
    if (fromTransport !== undefined) return fromTransport & 0xff;
    return nextRdmTransactionNumber();
}

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
        transactionNumber: resolveTransactionNumber(options),
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
        transactionNumber: resolveTransactionNumber(options),
        portId: options.portId ?? 1,
        subDevice: options.subDevice ?? 0,
        commandClass: RdmCommandClass.SET_COMMAND,
        pid,
        parameterData,
    };
}

/**
 * Convenience wrapper: build and send a GET request through a transport.
 * @param parameterData Optional GET payload (e.g. DMX_PERSONALITY_DESCRIPTION index).
 */
export async function sendGet(
    transport: RdmTransport,
    destinationUid: UID,
    pid: number,
    options: RdmRequestOptions,
    transportOptions?: RdmTransportOptions,
    parameterData?: Buffer,
): Promise<RdmResponse | null> {
    const transactionNumber = resolveTransactionNumber(options, transport);
    const request = buildGetRequest(destinationUid, pid, {...options, transactionNumber}, parameterData);
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
    const transactionNumber = resolveTransactionNumber(options, transport);
    const request = buildSetRequest(destinationUid, pid, {...options, transactionNumber}, parameterData);
    return transport.send(request, transportOptions);
}
