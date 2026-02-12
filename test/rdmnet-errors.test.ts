import {describe, expect, it} from 'vitest';

import {BrokerStatusCode, mapBrokerStatusToError, RdmnetError} from '../src';

describe('RDMnet errors', () => {
    it('maps broker status codes to structured RdmnetError', () => {
        const err = mapBrokerStatusToError(
            BrokerStatusCode.Unauthorized,
            'auth failed',
            {phase: 'connect'},
        );
        expect(err).toBeInstanceOf(RdmnetError);
        expect(err).toMatchObject({
            domain: 'broker',
            code: 'BROKER_UNAUTHORIZED',
            statusCode: BrokerStatusCode.Unauthorized,
        });
        expect(err.details).toEqual({phase: 'connect'});
    });
});
