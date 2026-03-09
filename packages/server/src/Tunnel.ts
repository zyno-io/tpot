import debugFactory from 'debug';
import WebSocket from 'ws';

import { TunnelConversation } from './TunnelConversation';
import { TunnelError } from './Errors';
import * as CONTROL_CODES from './TunnelControlCodes';
import type { ClientHttpConnection } from './ClientHttpConnection';

let tunnelCount = 0;

export class Tunnel {
    conversations: Record<number, TunnelConversation> = {};
    openConversationCount = 0;
    nextConversationId = 0;

    id: number;
    ws: WebSocket;
    subdomain: string;
    log: debugFactory.Debugger;
    lastPingTs = 0;
    checkInterval: ReturnType<typeof setTimeout>;

    constructor(ws: WebSocket, subdomain: string) {
        this.id = ++tunnelCount;
        this.ws = ws;
        this.subdomain = subdomain;

        this.log = debugFactory('tunnel-' + this.id);

        this.ws.on('error', this.handleWsError.bind(this));
        this.ws.on('close', this.handleWsClosed.bind(this));
        this.ws.on('message', this.handleWsMessage.bind(this));
        this.ws.on('ping', this.handleWsPing.bind(this));

        this.checkInterval = setTimeout(this.verifyPingTs.bind(this), 30000);

        this.sendGreeting();
    }


    /******************
     * WEBSOCKET HANDLERS
     *****************/

    handleWsError(err: Error): void {
        this.log('WebSocket error:', err);
    }

    handleWsClosed(code: number, reason: Buffer): void {
        clearInterval(this.checkInterval);
        Object.values(this.conversations).forEach(conversation => conversation.terminate());
        this.log('WebSocket disconnected', code, reason);
    }

    handleWsPing(): void {
        this.lastPingTs = Date.now();
    }

    handleWsMessage(data: WebSocket.RawData): void {
        const buf = data as Buffer;
        try {
            if (buf[0] === CONTROL_CODES.MSG_CONTROL)
                return this.handleControlMessage(buf.subarray(1));
            if (buf[0] === CONTROL_CODES.MSG_CONVO)
                return this.handleConversationMessage(buf.subarray(1));
        } catch (err) {
            if (err instanceof TunnelError) {
                this.log('ERR: ' + err.message);
                return this.ws.close(4180, err.message);
            } else {
                throw err;
            }
        }

        this.ws.close(4180, 'unhandled message type');
    }


    /******************
     * SETUP & PERSISTENCE
     *****************/

    verifyPingTs(): void {
        if (this.lastPingTs + 30000 < Date.now()) {
            this.log('no ping received in a while. terminating.');
            this.ws.terminate();
        }
    }

    sendGreeting(): void {
        const greetingBuffer = Buffer.alloc(9 + this.subdomain.length);
        greetingBuffer.writeUInt8(CONTROL_CODES.MSG_CONTROL, 0);
        greetingBuffer.writeUInt8(CONTROL_CODES.CONTROL_GREETINGS, 1);
        greetingBuffer.write('TPoT/1 ' + this.subdomain, 2);
        this.ws.send(greetingBuffer);
    }


    /******************
     * NEW CONNECTION HANDLING
     *****************/

    handleNewConnection(clientConnection: ClientHttpConnection, initialData: Buffer): void {
        const conversationId = this.generateConversationId();

        const conversation = new TunnelConversation(this, conversationId);
        this.conversations[conversationId] = conversation;

        this.openConversationCount++;
        this.log('created conversation ' + conversationId + ' for connection ' + clientConnection.id + ', now have ' + this.openConversationCount + ' open conversations');

        conversation.once('end', () => {
            this.openConversationCount--;
            delete this.conversations[conversationId];
            this.log('conversation ' + conversationId + ' ended, leaving ' + this.openConversationCount + ' open conversations');
        });

        conversation.handleNewConnection(clientConnection, initialData);
    }

    generateConversationId(): number {
        if (this.openConversationCount === 65535) {
            throw new TunnelError('reached maximum connections');
        }

        let conversationId: number;
        do {
            conversationId = ++this.nextConversationId;

            if (conversationId === 65536) {
                this.nextConversationId = conversationId = 1;
            }
        }
        while (this.conversations[conversationId]);

        return conversationId;
    }


    /******************
     * INBOUND DATA PROCESSING
     *****************/

    handleControlMessage(_data: Buffer): void {
        // none implemented yet
        throw new TunnelError('invalid control message');
    }

    handleConversationMessage(data: Buffer): void {
        const conversationId = data.readUInt16LE(0);
        const conversation = this.conversations[conversationId];

        if (!conversation) {
            // just ignore these for now
            return this.log('received conversation message ' + String.fromCharCode(data[2]) + ' for non-existent conversation ' + conversationId);
        }

        conversation.handleDataFromTunnel(data.subarray(2));
    }
}
