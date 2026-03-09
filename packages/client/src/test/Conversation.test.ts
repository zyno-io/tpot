import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Conversation } from '../Conversation';
import * as CODES from '../TunnelControlCodes';

function createMockClient() {
    const sent: Buffer[] = [];
    return {
        options: {
            target: { host: '127.0.0.1', port: 8080 },
            rewriteHost: '127.0.0.1:8080'
        },
        ws: {
            send(data: Buffer) { sent.push(data); },
            ping() {}
        },
        sent
    };
}

describe('Conversation', () => {
    let client: ReturnType<typeof createMockClient>;
    let conversation: Conversation;

    beforeEach(() => {
        client = createMockClient();
        conversation = new Conversation('test', client as any, 42);
    });

    describe('sendTunnelControlMessage', () => {
        it('should send a 4-byte control message', () => {
            conversation.sendTunnelControlMessage(CODES.CONVO_RESUME);
            assert.equal(client.sent.length, 1);
            const buf = client.sent[0];
            assert.equal(buf.length, 4);
            assert.equal(buf[0], CODES.MSG_CONVO);
            assert.equal(buf.readUInt16LE(1), 42);
            assert.equal(buf[3], CODES.CONVO_RESUME);
        });

        it('should not send when tunnel conversation is closed', () => {
            conversation.isTunnelConvoOpen = false;
            conversation.sendTunnelControlMessage(CODES.CONVO_RESUME);
            assert.equal(client.sent.length, 0);
        });
    });

    describe('forwardDataThroughTunnel', () => {
        it('should send data with 4-byte header', () => {
            const data = Buffer.from('hello');
            conversation.forwardDataThroughTunnel(data);
            assert.equal(client.sent.length, 1);
            const buf = client.sent[0];
            assert.equal(buf.length, 9); // 4 header + 5 data
            assert.equal(buf[0], CODES.MSG_CONVO);
            assert.equal(buf.readUInt16LE(1), 42);
            assert.equal(buf[3], CODES.CONVO_DATA);
            assert.equal(buf.subarray(4).toString(), 'hello');
        });

        it('should track bytes forwarded', () => {
            conversation.forwardDataThroughTunnel(Buffer.from('hello'));
            conversation.forwardDataThroughTunnel(Buffer.from('world'));
            assert.equal(conversation.bytesForwardedThroughTunnel, 10);
        });

        it('should not send when tunnel conversation is closed', () => {
            conversation.isTunnelConvoOpen = false;
            conversation.forwardDataThroughTunnel(Buffer.from('hello'));
            assert.equal(client.sent.length, 0);
        });
    });

    describe('handleDataFromTunnel', () => {
        it('should handle CONVO_CLOSED', () => {
            const data = Buffer.from([CODES.CONVO_CLOSED]);
            conversation.handleDataFromTunnel(data);
            assert.equal(conversation.isTunnelConvoOpen, false);
        });

        it('should throw on unknown control code', () => {
            const data = Buffer.from([0xFF]);
            assert.throws(() => conversation.handleDataFromTunnel(data), /unhandled conversation control code/);
        });
    });

    describe('checkForEnd', () => {
        it('should emit end when both sides are closed', () => {
            let ended = false;
            conversation.on('end', () => { ended = true; });
            conversation.isTunnelConvoOpen = false;
            conversation.isUpstreamConnected = false;
            conversation.checkForEnd();
            assert.ok(ended);
        });

        it('should not emit end when tunnel is still open', () => {
            let ended = false;
            conversation.on('end', () => { ended = true; });
            conversation.isTunnelConvoOpen = true;
            conversation.isUpstreamConnected = false;
            conversation.checkForEnd();
            assert.ok(!ended);
        });

        it('should only emit end once', () => {
            let count = 0;
            conversation.on('end', () => { count++; });
            conversation.isTunnelConvoOpen = false;
            conversation.isUpstreamConnected = false;
            conversation.checkForEnd();
            conversation.checkForEnd();
            assert.equal(count, 1);
        });
    });
});
