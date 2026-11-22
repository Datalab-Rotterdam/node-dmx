/**
 * Structured RDMnet error taxonomy.
 * @module rdmnet/errors
 */
import {ConnectionStatusCode} from './broker';

export type RdmnetErrorDomain = 'transport' | 'broker' | 'rpt' | 'ept' | 'llrp' | 'timeout';

export type RdmnetErrorCode =
    | 'BROKER_SCOPE_MISMATCH'
    | 'BROKER_CAPACITY_EXCEEDED'
    | 'BROKER_DUPLICATE_UID'
    | 'BROKER_INVALID_CLIENT_ENTRY'
    | 'BROKER_INVALID_UID'
    | 'STREAM_FRAMING_ERROR'
    | 'BROKER_DECODE_ERROR'
    | 'RPT_DECODE_ERROR'
    | 'EPT_DECODE_ERROR'
    | 'LLRP_DECODE_ERROR'
    | 'RESPONSE_TIMEOUT'
    | 'HEARTBEAT_TIMEOUT'
    | 'PROTOCOL_ERROR';

export class RdmnetError extends Error {
    public readonly domain: RdmnetErrorDomain;
    public readonly code: RdmnetErrorCode;
    public readonly statusCode?: number;
    public readonly details?: Record<string, unknown>;

    constructor(params: {
        message: string;
        domain: RdmnetErrorDomain;
        code: RdmnetErrorCode;
        statusCode?: number;
        details?: Record<string, unknown>;
    }) {
        super(params.message);
        this.name = 'RdmnetError';
        this.domain = params.domain;
        this.code = params.code;
        this.statusCode = params.statusCode;
        this.details = params.details;
    }
}

const BROKER_STATUS_ERROR_META: Record<ConnectionStatusCode, {code: RdmnetErrorCode; message: string}> = {
    [ConnectionStatusCode.Ok]: {code: 'PROTOCOL_ERROR', message: 'Broker returned OK in error path'},
    [ConnectionStatusCode.ScopeMismatch]: {code: 'BROKER_SCOPE_MISMATCH', message: 'Broker scope does not match'},
    [ConnectionStatusCode.CapacityExceeded]: {code: 'BROKER_CAPACITY_EXCEEDED', message: 'Broker capacity exceeded'},
    [ConnectionStatusCode.DuplicateUid]: {code: 'BROKER_DUPLICATE_UID', message: 'Broker reports duplicate UID'},
    [ConnectionStatusCode.InvalidClientEntry]: {code: 'BROKER_INVALID_CLIENT_ENTRY', message: 'Broker reports invalid client entry'},
    [ConnectionStatusCode.InvalidUid]: {code: 'BROKER_INVALID_UID', message: 'Broker reports invalid UID'},
};

export const mapBrokerStatusToError = (
    status: ConnectionStatusCode,
    fallbackMessage: string,
    details?: Record<string, unknown>,
): RdmnetError => {
    const meta = BROKER_STATUS_ERROR_META[status] ?? {
        code: 'PROTOCOL_ERROR' as RdmnetErrorCode,
        message: fallbackMessage,
    };
    return new RdmnetError({
        message: fallbackMessage || meta.message,
        domain: 'broker',
        code: meta.code,
        statusCode: status,
        details,
    });
};
