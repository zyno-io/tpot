import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelConversation } from '../TunnelConversation';
import * as CODES from '../TunnelControlCodes';
import debugFactory from 'debug';

function createMockTunnel() {
    const sent: Buffer[] = [];
    return {
        ws: {
            send(data: Buffer) { sent.push(data); }
        },
        log: debugFactory('test-tunnel'),
        sent
    };
}

describe('TunnelConversation', () => {
    let tunnel: ReturnType<typeof createMockTunnel>;
    let conversation: TunnelConversation;

    beforeEach(() => {
        tunnel = createMockTunnel();
        conversation = new TunnelConversation(tunnel as any, 7);
    });

    describe('sendTunnelControlMessage', () => {
        it('should send a 4-byte control message', () => {
            conversation.sendTunnelControlMessage(CODES.CONVO_RESUME);
            assert.equal(tunnel.sent.length, 1);
            const buf = tunnel.sent[0];
            assert.equal(buf.length, 4);
            assert.equal(buf[0], CODES.MSG_CONVO);
            assert.equal(buf.readUInt16LE(1), 7);
            assert.equal(buf[3], CODES.CONVO_RESUME);
        });

        it('should not send when tunnel is closed', () => {
            conversation.isTunnelConvoOpen = false;
            conversation.sendTunnelControlMessage(CODES.CONVO_RESUME);
            assert.equal(tunnel.sent.length, 0);
        });
    });

    describe('forwardDataThroughTunnel', () => {
        it('should send data with 4-byte header', () => {
            const data = Buffer.from('test data');
            conversation.forwardDataThroughTunnel(data);
            assert.equal(tunnel.sent.length, 1);
            const buf = tunnel.sent[0];
            assert.equal(buf.length, 4 + data.length);
            assert.equal(buf[0], CODES.MSG_CONVO);
            assert.equal(buf.readUInt16LE(1), 7);
            assert.equal(buf[3], CODES.CONVO_DATA);
            assert.equal(buf.subarray(4).toString(), 'test data');
        });

        it('should track bytes forwarded', () => {
            conversation.forwardDataThroughTunnel(Buffer.from('abc'));
            conversation.forwardDataThroughTunnel(Buffer.from('defgh'));
            assert.equal(conversation.bytesForwardedThroughTunnel, 8);
        });
    });

    describe('handleDataFromTunnel', () => {
        it('should throw on unknown control code', () => {
            assert.throws(
                () => conversation.handleDataFromTunnel(Buffer.from([0xFF])),
                /unhandled conversation control code/
            );
        });
    });

    describe('checkForEnd', () => {
        it('should emit end when both sides are closed', () => {
            let ended = false;
            conversation.on('end', () => { ended = true; });
            conversation.isTunnelConvoOpen = false;
            conversation.isClientConnected = false;
            conversation.checkForEnd();
            assert.ok(ended);
        });

        it('should not emit end when tunnel is still open', () => {
            let ended = false;
            conversation.on('end', () => { ended = true; });
            conversation.isTunnelConvoOpen = true;
            conversation.isClientConnected = false;
            conversation.checkForEnd();
            assert.ok(!ended);
        });

        it('should not emit end when client is still connected', () => {
            let ended = false;
            conversation.on('end', () => { ended = true; });
            conversation.isTunnelConvoOpen = false;
            conversation.isClientConnected = true;
            conversation.checkForEnd();
            assert.ok(!ended);
        });

        it('should only emit end once', () => {
            let count = 0;
            conversation.on('end', () => { count++; });
            conversation.isTunnelConvoOpen = false;
            conversation.isClientConnected = false;
            conversation.checkForEnd();
            conversation.checkForEnd();
            assert.equal(count, 1);
        });
    });

    describe('terminate', () => {
        it('should mark tunnel as closed', () => {
            conversation.isClientConnected = false;
            conversation.terminate();
            assert.equal(conversation.isTunnelConvoOpen, false);
        });
    });
});
