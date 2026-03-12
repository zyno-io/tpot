import { EventEmitter } from 'events';
import net from 'net';

import { TunnelBuilder } from './TunnelBuilder';
import { TunnelStore } from './TunnelStore';
import { HttpError, TunnelError } from './Errors';
import type { Server } from './Server';

const HEADER_LIMIT = 8192;

export interface RequestMeta {
    method: string;
    url: string;
    httpVersion: string;
}

export class ClientHttpConnection extends EventEmitter {
    server: Server;
    socket: net.Socket;
    id: number;
    log: ReturnType<ReturnType<typeof import('debug')['default']>['extend']>;

    initialDataLen = 0;
    initialData: Buffer[] | Buffer = [];
    requestMetaTerminalOffset: number | null = null;
    requestMeta: RequestMeta | null = null;
    requestHeadersTerminalOffset: number | null = null;
    requestHeaders: Record<string, string> | null = null;

    isEstablished = false;

    constructor(server: Server, socket: net.Socket, id: number) {
        super();

        this.server = server;
        this.socket = socket;
        this.id = id;

        this.log = this.server.log.extend('http-cxn-' + this.id);
        this.log('http connection from ' + this.socket.remoteAddress + ':' + this.socket.remotePort);

        this.socket.on('error', this.handleSocketError.bind(this));
        this.socket.on('close', this.handleSocketClosed.bind(this));
        this.socket.once('data', this.handleSocketInitialData.bind(this));
    }

    handleSocketError(err: Error): void {
        this.log('socket encountered error:', err);
        this.socket.destroy();
    }

    handleSocketClosed(hadError: boolean): void {
        if (hadError) return this.log('socket closed with error');
        if (!this.isEstablished) return this.log('socket closed before establishing any meaningful connection');
        this.log('socket closed');
    }

    async handleSocketInitialData(data: Buffer): Promise<void> {
        this.appendInitialData(data);

        try {
            this.extractInitialData();
            this.verifyHeaderLength();

            if (!this.requestHeadersTerminalOffset) {
                this.socket.once('data', this.handleSocketInitialData.bind(this));
                return;
            }

            await this.processInitialData();
        } catch (err) {
            if (err instanceof HttpError) return this.handleHttpError(err);
            if (err instanceof TunnelError) return this.handleTunnelError(err);
            throw err;
        }
    }

    appendInitialData(data: Buffer): void {
        (this.initialData as Buffer[]).push(data);
        this.initialDataLen += data.length;
    }

    extractInitialData(): void {
        const buffer = Buffer.concat(this.initialData as Buffer[]);

        if (!this.requestMetaTerminalOffset) {
            const firstCrLfIndex = buffer.indexOf('\r\n');
            if (firstCrLfIndex < 0) return;

            this.requestMetaTerminalOffset = firstCrLfIndex;
            const requestLine = buffer.subarray(0, this.requestMetaTerminalOffset).toString('utf8');
            const requestLineComponents = requestLine.match(/^([A-Z]+) ([^ ]+) HTTP\/(1\.[01])$/);
            if (!requestLineComponents) throw new HttpError(400, 'Bad Request');

            this.requestMeta = {
                method: requestLineComponents[1],
                url: requestLineComponents[2],
                httpVersion: requestLineComponents[3]
            };
        }

        const headerEndIndex = buffer.indexOf('\r\n\r\n', this.requestMetaTerminalOffset);
        if (headerEndIndex < 0) return;

        this.requestHeadersTerminalOffset = headerEndIndex;
    }

    verifyHeaderLength(): void {
        const headerLength = this.requestHeadersTerminalOffset ?? this.initialDataLen;
        if (headerLength > HEADER_LIMIT)
            throw new HttpError(413, 'Request Entity Too Large', 'headers exceeded maximum allowed length');
    }

    async processInitialData(): Promise<void> {
        this.initialData = Buffer.concat(this.initialData as Buffer[]);

        const headersData = this.initialData.subarray(this.requestMetaTerminalOffset! + 2, this.requestHeadersTerminalOffset!);
        const headersString = headersData.toString('utf8');

        const headers: Record<string, string> = {};
        this.requestHeaders = headers;

        headersString.split(/\r\n/g).forEach(line => {
            const colonOffset = line.indexOf(':');
            if (colonOffset < 0) throw new HttpError(400, 'Bad Request', 'invalid header');
            const key = line.substring(0, colonOffset).toLowerCase();
            const value = line.substring(colonOffset + 1).trimStart();

            if (headers[key])
                headers[key] += '\n' + value;
            else
                headers[key] = value;
        });

        if (!headers.host) throw new HttpError(400, 'Bad Request', 'missing host header');

        const httpHost = headers.host.replace(/:.*$/, '').toLowerCase();
        this.log('request:', headers.host, this.requestMeta!.method, this.requestMeta!.url);

        if (this.server.options.domains.includes(httpHost))
            return await this.handleDirectRequest();

        for (const suffix of this.server.options.domainSuffixes!) {
            if (httpHost.endsWith(suffix)) {
                const subdomain = httpHost.slice(0, -suffix.length);
                return this.handleSubdomainRequest(subdomain);
            }
        }

        throw new HttpError(404, 'Not Found');
    }

    async handleDirectRequest(): Promise<void> {
        if (this.requestMeta!.url === '/tpot-auth' && this.requestMeta!.method === 'GET')
            return this.handleAuthConfigRequest();

        if (!/^\/create-tpot($|\?)/.test(this.requestMeta!.url))
            throw new HttpError(404, 'Not Found');
        if (this.requestMeta!.method !== 'GET')
            throw new HttpError(405, 'Method Not Allowed');
        if (this.requestMeta!.httpVersion !== '1.1')
            throw new HttpError(400, 'Bad Request', 'incorrect http version');
        if (!this.requestHeaders!.connection || !this.requestHeaders!.connection.toLowerCase().includes('upgrade'))
            throw new HttpError(400, 'Bad Request', 'incorrect connection header');
        if (!this.requestHeaders!.upgrade || this.requestHeaders!.upgrade.toLowerCase() !== 'websocket')
            throw new HttpError(400, 'Bad Request', 'incorrect upgrade header');

        const bodyData = (this.initialData as Buffer).subarray(this.requestHeadersTerminalOffset! + 4);
        const tunnel = await TunnelBuilder.instance.handleCreateRequest(this, bodyData);

        if (!tunnel) return;

        this.isEstablished = true;
    }

    handleAuthConfigRequest(): void {
        const config: Record<string, any> = {};

        if (this.server.options.authKey) {
            config.method = 'static_key';
        } else if (this.server.options.oidcDiscoveryUrl) {
            config.method = 'oidc';
            config.oidcIssuer = this.server.options.oidcDiscoveryUrl;
            if (this.server.options.oidcClientId) config.oidcClientId = this.server.options.oidcClientId;
            if (this.server.options.oidcScopes) config.oidcScopes = this.server.options.oidcScopes;
            if (this.server.options.oidcAudience) config.oidcAudience = this.server.options.oidcAudience;
        } else {
            config.method = 'none';
        }

        const body = JSON.stringify(config);
        this.socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
        this.socket.end();
    }

    handleSubdomainRequest(subdomain: string): void {
        const entity = TunnelStore.instance.tunnels[subdomain];

        if (!entity) throw new HttpError(503, 'tunnel not found');
        if (!entity.tunnel) throw new HttpError(503, 'tunnel not ready');

        const isUpgrade = this.requestHeaders!.upgrade?.toLowerCase() === 'websocket';
        const initialData = isUpgrade ? this.initialData as Buffer : this.forceConnectionClose();
        entity.tunnel.handleNewConnection(this, initialData);

        this.isEstablished = true;
    }

    forceConnectionClose(): Buffer {
        const data = this.initialData as Buffer;
        const headerStart = this.requestMetaTerminalOffset! + 2;
        const headerEnd = this.requestHeadersTerminalOffset!;
        const headersString = data.subarray(headerStart, headerEnd).toString('utf8');

        const connectionMatch = headersString.match(/^connection:.*$/mi);
        let newHeaders: string;
        if (connectionMatch) {
            newHeaders = headersString.substring(0, connectionMatch.index!) +
                'Connection: close' +
                headersString.substring(connectionMatch.index! + connectionMatch[0].length);
        } else {
            newHeaders = headersString + '\r\nConnection: close';
        }

        return Buffer.concat([
            data.subarray(0, headerStart),
            Buffer.from(newHeaders),
            data.subarray(headerEnd),
        ]);
    }

    handleHttpError({ statusCode, message, extendedMessage }: { statusCode: number; message: string; extendedMessage?: string }): void {
        const displayMessage = extendedMessage ? `${message} (${extendedMessage})` : message;
        this.log('ERR: ' + statusCode + ' ' + displayMessage);
        this.socket.write('HTTP/1.1 ' + statusCode + ' ' + message + '\r\nContent-Type: text/plain\r\nContent-Length: ' + Buffer.byteLength(displayMessage) + '\r\n\r\n' + displayMessage);
        this.socket.end();
    }

    handleTunnelError({ message }: { message: string }): void {
        this.handleHttpError({
            statusCode: 503,
            message
        });
    }
}
