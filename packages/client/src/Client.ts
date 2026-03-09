import debugFactory from 'debug';
import WebSocket from 'ws';

import { ClientError } from './Errors';
import { UrlHelper, UrlComponents } from './UrlHelper';
import { HttpConversation } from './HttpConversation';
import { Conversation } from './Conversation';
import * as CONTROL_CODES from './TunnelControlCodes';

const log = debugFactory('client');

export interface ResolvedClientOptions {
    server: UrlComponents;
    authKey?: string;
    oidcToken?: string;
    subdomain?: string;
    target: UrlComponents;
    rewriteHost: string | false;
}

export class Client {
    isConnected = false;
    readyResolve: (() => void) | null = null;
    options: Partial<ResolvedClientOptions> = {};
    conversations: Record<number, Conversation> = {};
    openConversationCount = 0;
    tunnelUrl: string | null = null;
    ws: WebSocket | null = null;
    pingInterval: ReturnType<typeof setInterval> | null = null;

    configure(options: Partial<ResolvedClientOptions>): void {
        Object.assign(this.options, options);
    }

    init(): Promise<void> {
        return new Promise(resolve => {
            this.readyResolve = resolve;

            const helper = new UrlHelper();

            this.options.server = helper.extractUrlComponents(this.options.server as unknown as string);
            this.options.target = helper.extractUrlComponents(this.options.target as unknown as string);

            if (this.options.rewriteHost === undefined) {
                this.options.rewriteHost = this.options.target.hostWithPort;
            }

            const connectionInfo = helper.getServerConnectionInfo(this.options as { server: UrlComponents; subdomain?: string; authKey?: string; oidcToken?: string });
            this.connect(connectionInfo);
        });
    }

    connect({ url, headers }: { url: string; headers: Record<string, string> }): void {
        this.ws = new WebSocket(url, { headers });
        this.ws.on('error', this.handleWsError.bind(this));
        this.ws.on('close', this.handleWsDisconnected.bind(this));
        this.ws.on('open', this.handleWsConnected.bind(this));
        this.ws.on('message', this.handleWsMessage.bind(this));
    }

    handleWsError(err: Error & { code?: string; message: string }): void {
        log('WebSocket error', err);

        if (!this.isConnected) {
            if (err.code === 'ECONNREFUSED')
                throw new ClientError('The server ' + err.message.replace(/^.*ECONNREFUSED /, '') + ' could not be reached.');

            const httpErrorMatches = err.message.match(/Unexpected server response: ([0-9]{3})/);
            if (httpErrorMatches) {
                if (httpErrorMatches[1] === '401')
                    throw new ClientError('The server did not authorize your request. Please check your authentication credentials (auth key or OIDC token).');
                if (httpErrorMatches[1] === '404')
                    throw new ClientError('The server returned a 404 Not Found. Please check your server URL.');
                if (httpErrorMatches[1] === '409')
                    throw new ClientError('The server returned a 409 Conflict. This likely means the subdomain you requested is already in use.');
            }
        }

        throw err;
    }

    handleWsConnected(): void {
        log('WebSocket connected');
        this.isConnected = true;
        this.pingInterval = setInterval(this.sendPing.bind(this), 15000);
    }

    handleWsDisconnected(code: number, reason: Buffer): void {
        if (this.pingInterval) clearTimeout(this.pingInterval);
        log('WebSocket disconnected', code, reason);
        process.exit(-2);
    }

    handleWsMessage(data: WebSocket.RawData): void {
        if (!(data instanceof Buffer)) throw new Error('received unexpected data from server');
        if (data[0] === CONTROL_CODES.MSG_CONTROL) return this.handleControlMessage(data.subarray(1));
        if (data[0] === CONTROL_CODES.MSG_CONVO) return this.handleConversationMessage(data.subarray(1));
        throw new Error('received unexpected message type code from server');
    }

    sendPing(): void {
        this.ws!.ping();
    }

    handleControlMessage(data: Buffer): void {
        if (data[0] === CONTROL_CODES.TYPE_HTTP) return this.handleNewConversation(HttpConversation, data.subarray(1));
        // raw
        if (data[0] === CONTROL_CODES.CONTROL_GREETINGS) return this.handleServerGreeting(data.subarray(1));
        throw new Error('received unexpected control message from server');
    }

    handleConversationMessage(data: Buffer): void {
        const conversationId = data.readUInt16LE(0);
        const conversation = this.conversations[conversationId];

        if (!conversation) {
            // just ignore these for now
            return log('received conversation message ' + String.fromCharCode(data[2]) + ' for non-existent conversation ' + conversationId);
        }

        conversation.handleDataFromTunnel(data.subarray(2));
    }

    handleServerGreeting(greeting: Buffer): void {
        const greetingStr = greeting.toString('utf8');
        if (greetingStr.substring(0, 7) !== 'TPoT/1 ') throw new Error('received unexpected greeting from server');

        const server = this.options.server as UrlComponents;
        this.tunnelUrl = server.protocol + '://' + greetingStr.substring(7) + '.' + server.hostWithPort;

        this.readyResolve!();
        this.readyResolve = null;
    }

    handleNewConversation(handlerClass: new (client: Client, id: number) => Conversation, data: Buffer): void {
        const conversationId = data.readInt16LE(0);

        if (this.conversations[conversationId])
            throw new Error('server tried to re-use an existing conversation ID');

        const conversation = new handlerClass(this, conversationId);
        this.conversations[conversationId] = conversation;

        this.openConversationCount++;
        log('created conversation ' + conversationId + ', now have ' + this.openConversationCount + ' open conversations');

        conversation.on('end', () => {
            this.openConversationCount--;
            delete this.conversations[conversationId];
            log('conversation ' + conversationId + ' ended, leaving ' + this.openConversationCount + ' open conversations');
        });

        conversation.handleRequest(data.subarray(2));
    }
}
