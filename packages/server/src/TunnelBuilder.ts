import crypto from 'crypto';
import debugFactory from 'debug';

import { HttpError } from './Errors';
import { Tunnel } from './Tunnel';
import { TunnelStore } from './TunnelStore';
import type { ClientHttpConnection } from './ClientHttpConnection';
import type { Server } from './Server';

const ACCEPTABLE_CLOCK_DRIFT_MS = 60000;

export class TunnelBuilder {
    log: debugFactory.Debugger;
    tunnelStore: TunnelStore;
    server!: Server;

    static instance = new TunnelBuilder();

    constructor() {
        this.log = debugFactory('tunnel-builder');
        this.tunnelStore = TunnelStore.instance;
    }

    setServer(server: Server): void {
        this.server = server;
    }

    async handleCreateRequest(httpConnection: ClientHttpConnection, initialData: Buffer): Promise<Tunnel | undefined> {
        this.log('building tunnel for connection ' + httpConnection.id);

        await this.verifyAuthorization(httpConnection);

        const url = new URL(httpConnection.requestMeta!.url, 'http://x/');
        let subdomain = url.searchParams.get('subdomain');
        if (subdomain) {
            subdomain = subdomain.toLowerCase();
            this.validateSubdomain(subdomain);
        } else {
            subdomain = this.generateSubdomain();
        }

        this.tunnelStore.tunnels[subdomain] = {
            cxn: httpConnection,
            socket: httpConnection.socket
        };

        httpConnection.socket.on('close', () => {
            delete this.tunnelStore.tunnels[subdomain!];
        });

        const fakeRequest = {
            headers: httpConnection.requestHeaders!,
            httpVersion: httpConnection.requestMeta!.httpVersion,
            method: httpConnection.requestMeta!.method,
            socket: httpConnection.socket,
            url: httpConnection.requestMeta!.url
        };

        let tunnel: Tunnel | undefined;

        // this currently doesn't actually do anything async, so the return of this function indicates its done and the CB has been executed
        this.server.wss.handleUpgrade(fakeRequest as any, httpConnection.socket, initialData, (ws) => {
            this.tunnelStore.tunnels[subdomain!].ws = ws;

            tunnel = new Tunnel(ws, subdomain!);
            this.tunnelStore.tunnels[subdomain!].tunnel = tunnel;

            this.log('created tunnel ' + tunnel.id + ' for connection ' + httpConnection.id + ' with subdomain: ' + subdomain);
        });

        return tunnel;
    }

    async verifyAuthorization(httpConnection: ClientHttpConnection): Promise<true> {
        const authRequired = this.server.options.authKey || this.server.oidcVerifier;
        if (!authRequired) return true;

        const authHeader = httpConnection.requestHeaders!.authorization;
        if (!authHeader)
            throw new HttpError(401, 'Unauthorized', 'no authorization header present');

        if (authHeader.startsWith('TPoT-1 '))
            return this.verifyStaticKeyAuth(authHeader.substring(7));

        if (authHeader.startsWith('Bearer '))
            return this.verifyOidcAuth(authHeader.substring(7));

        throw new HttpError(401, 'Unauthorized', 'unsupported authorization scheme');
    }

    private verifyStaticKeyAuth(encodedAuth: string): Promise<true> {
        if (!this.server.options.authKey)
            throw new HttpError(401, 'Unauthorized', 'static key auth is not enabled');

        const decodedAuthIn = Buffer.from(encodedAuth, 'base64').toString('utf8');
        const matches = decodedAuthIn.match(/^(.+)\n([0-9]+)\n(.+)$/);
        if (!matches)
            throw new HttpError(401, 'Unauthorized', 'invalid authorization string');

        const now = Date.now();
        const requestTs = parseInt(matches[2]);
        if (requestTs < now - ACCEPTABLE_CLOCK_DRIFT_MS)
            throw new HttpError(401, 'Unauthorized', 'authorization too far in the past');
        if (requestTs > now + ACCEPTABLE_CLOCK_DRIFT_MS)
            throw new HttpError(401, 'Unauthorized', 'authorization too far in the future');

        return new Promise((resolve, reject) => {
            const saltString = matches[1] + '\n' + matches[2];
            const salt = crypto.createHash('md5').update(saltString).digest().toString('hex');

            crypto.pbkdf2(this.server.options.authKey!, salt, 32768, 128, 'sha256', (err, buffer) => {
                if (err) return reject(err);
                const token = buffer.toString('base64');
                const isMatch = token === matches[3];
                if (!isMatch) {
                    this.log('computed token does not match');
                    return reject(new HttpError(401, 'Unauthorized', 'invalid credentials'));
                }
                resolve(true);
            });
        });
    }

    private async verifyOidcAuth(token: string): Promise<true> {
        if (!this.server.oidcVerifier)
            throw new HttpError(401, 'Unauthorized', 'OIDC auth is not enabled');

        try {
            await this.server.oidcVerifier.verify(token);
            return true;
        } catch (err: any) {
            this.log('OIDC verification failed: %s', err.message);
            throw new HttpError(401, 'Unauthorized', 'invalid token');
        }
    }

    validateSubdomain(subdomain: string): void {
        if (!/^[a-z0-9-]{1,24}$/.test(subdomain) || subdomain.charAt(0) === '-')
            throw new HttpError(400, 'Bad Request', 'requested subdomain is invalid');

        if (this.tunnelStore.tunnels[subdomain])
            throw new HttpError(409, 'Conflict', 'subdomain is already in use');
    }

    generateSubdomain(): string {
        let subdomain: string;

        do {
            subdomain = Math.random().toString(36).substring(2, 10);
        }
        while (this.tunnelStore.tunnels[subdomain]);

        return subdomain;
    }
}
