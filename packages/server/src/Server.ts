import net from 'net';
import debugFactory from 'debug';
import WebSocket from 'ws';

import { ClientHttpConnection } from './ClientHttpConnection';
import { OidcVerifier } from './OidcVerifier';
import { TunnelBuilder } from './TunnelBuilder';

export interface ServerOptions {
    domains: string[];
    authKey?: string;
    oidcDiscoveryUrl?: string;
    oidcIssuer?: string;
    oidcAudience?: string;
    oidcClientId?: string;
    oidcScopes?: string;
    oidcRequiredClaims?: Record<string, string>;
    port?: number | string;
    domainSuffixes?: string[];
}

export class Server {
    options: ServerOptions = { domains: [] };
    oidcVerifier: OidcVerifier | null = null;
    cxnCount = 0;
    log!: debugFactory.Debugger;
    wss!: WebSocket.Server;
    netServer!: net.Server;

    configure(options: Partial<ServerOptions>): void {
        Object.assign(this.options, options);
    }

    async init(): Promise<void> {
        this.options.domainSuffixes = this.options.domains.map(d => '.' + d);

        this.log = debugFactory('server');

        if (this.options.oidcDiscoveryUrl) {
            this.oidcVerifier = new OidcVerifier({
                discoveryUrl: this.options.oidcDiscoveryUrl,
                issuer: this.options.oidcIssuer,
                audience: this.options.oidcAudience,
                requiredClaims: this.options.oidcRequiredClaims,
            });
            await this.oidcVerifier.init();
        }

        this.wss = new WebSocket.Server({ noServer: true });

        this.netServer = net.createServer();
        this.netServer.on('error', this.handleServerError.bind(this));
        this.netServer.on('listening', this.handleServerListening.bind(this));
        this.netServer.on('connection', this.handleServerConnection.bind(this));
        this.netServer.listen(this.options.port != null ? Number(this.options.port) : 3000, '0.0.0.0');

        TunnelBuilder.instance.setServer(this);
    }

    /******************
     * MAIN SOCKET
     *****************/

    handleServerError(err: Error): void {
        this.log('server error', err);
        process.exit(-1);
    }

    handleServerListening(): void {
        const address = this.netServer.address() as net.AddressInfo;
        this.log('server listening on http://' + address.address + ':' + address.port);
    }

    handleServerConnection(socket: net.Socket): void {
        const cxnId = ++this.cxnCount;
        new ClientHttpConnection(this, socket, cxnId);
    }
}
