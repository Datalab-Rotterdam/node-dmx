import {describe, expect, it} from 'vitest';

import {ConnectionStatusCode, mapBrokerStatusToError, RdmnetError} from '../src';

describe('RDMnet errors', () => {
    it('maps broker status codes to structured RdmnetError', () => {
        const err = mapBrokerStatusToError(
            ConnectionStatusCode.InvalidUid,
            'invalid uid',
            {phase: 'connect'},
        );
        expect(err).toBeInstanceOf(RdmnetError);
        expect(err).toMatchObject({
            domain: 'broker',
            code: 'BROKER_INVALID_UID',
            statusCode: ConnectionStatusCode.InvalidUid,
        });
        expect(err.details).toEqual({phase: 'connect'});
    });
});
