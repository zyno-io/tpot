import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, TunnelError } from '../Errors';

describe('HttpError', () => {
    it('should be an instance of Error', () => {
        const err = new HttpError(404, 'Not Found');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof HttpError);
    });

    it('should preserve statusCode and message', () => {
        const err = new HttpError(503, 'Service Unavailable');
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, 'Service Unavailable');
    });

    it('should preserve extendedMessage', () => {
        const err = new HttpError(400, 'Bad Request', 'missing host header');
        assert.equal(err.extendedMessage, 'missing host header');
    });

    it('should have undefined extendedMessage when not provided', () => {
        const err = new HttpError(404, 'Not Found');
        assert.equal(err.extendedMessage, undefined);
    });
});

describe('TunnelError', () => {
    it('should be an instance of Error', () => {
        const err = new TunnelError('tunnel broke');
        assert.ok(err instanceof Error);
        assert.ok(err instanceof TunnelError);
    });

    it('should preserve message', () => {
        const err = new TunnelError('something failed');
        assert.equal(err.message, 'something failed');
    });
});
