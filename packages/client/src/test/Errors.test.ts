import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClientError } from '../Errors';

describe('ClientError', () => {
    it('should be an instance of Error', () => {
        const err = new ClientError('test error');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof ClientError);
    });

    it('should preserve message', () => {
        const err = new ClientError('something went wrong');
        assert.equal(err.message, 'something went wrong');
    });
});
