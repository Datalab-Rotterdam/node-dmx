/**
 * Structured RDMnet error taxonomy.
 * @module rdmnet/errors
 */
import {BrokerStatusCode} from './broker';

export type RdmnetErrorDomain = 'transport' | 'broker' | 'rpt' | 'ept' | 'llrp' | 'negotiation' | 'timeout';

export type RdmnetErrorCode =
    | 'BROKER_REJECTED'
    | 'BROKER_INVALID_SCOPE'
    | 'BROKER_UNAUTHORIZED'
    | 'BROKER_ALREADY_CONNECTED'
    | 'BROKER_INVALID_REQUEST'
    | 'STREAM_FRAMING_ERROR'
    | 'BROKER_DECODE_ERROR'
    | 'RPT_DECODE_ERROR'
    | 'EPT_DECODE_ERROR'
    | 'LLRP_DECODE_ERROR'
    | 'NEGOTIATION_ROLE_MISMATCH'
    | 'NEGOTIATION_PROFILE_MISMATCH'
    | 'RESPONSE_TIMEOUT'
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

const BROKER_STATUS_ERROR_META: Record<BrokerStatusCode, {code: RdmnetErrorCode; message: string}> = {
    [BrokerStatusCode.Ok]: {code: 'PROTOCOL_ERROR', message: 'Broker returned OK in error path'},
    [BrokerStatusCode.Rejected]: {code: 'BROKER_REJECTED', message: 'Broker rejected request'},
    [BrokerStatusCode.InvalidScope]: {code: 'BROKER_INVALID_SCOPE', message: 'Broker scope is invalid'},
    [BrokerStatusCode.Unauthorized]: {code: 'BROKER_UNAUTHORIZED', message: 'Broker authorization failed'},
    [BrokerStatusCode.AlreadyConnected]: {code: 'BROKER_ALREADY_CONNECTED', message: 'Broker reports client already connected'},
    [BrokerStatusCode.InvalidRequest]: {code: 'BROKER_INVALID_REQUEST', message: 'Broker reports request is invalid'},
};

export const mapBrokerStatusToError = (
    status: BrokerStatusCode,
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
