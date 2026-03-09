import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as CODES from '../TunnelControlCodes';

describe('TunnelControlCodes', () => {
    it('should have correct message type codes', () => {
        assert.equal(CODES.MSG_CONTROL, 0x11);
        assert.equal(CODES.MSG_CONVO, 0x12);
    });

    it('should have correct control codes', () => {
        assert.equal(CODES.CONTROL_GREETINGS, 'G'.charCodeAt(0));
        assert.equal(CODES.TYPE_HTTP, 'H'.charCodeAt(0));
        assert.equal(CODES.TYPE_RAW, 'R'.charCodeAt(0));
    });

    it('should have correct conversation codes', () => {
        assert.equal(CODES.CONVO_DATA, 'D'.charCodeAt(0));
        assert.equal(CODES.CONVO_PAUSE, 'P'.charCodeAt(0));
        assert.equal(CODES.CONVO_RESUME, 'C'.charCodeAt(0));
        assert.equal(CODES.CONVO_CLOSED, 'X'.charCodeAt(0));
        assert.equal(CODES.CONVO_NOCONNECT, 'N'.charCodeAt(0));
    });
});
