import http from 'http';
import crypto from 'crypto';
import { execSync } from 'child_process';

export interface OidcTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
}

interface OidcDiscovery {
    authorization_endpoint: string;
    token_endpoint: string;
}

export interface OidcClientOptions {
    issuer: string;
    clientId: string;
    scopes?: string;
    audience?: string;
    callbackPort?: number;
}

export class OidcClient {
    private issuer: string;
    private clientId: string;
    private scopes: string;
    private audience?: string;
    private callbackPort?: number;
    private discovery!: OidcDiscovery;

    constructor(options: OidcClientOptions) {
        this.issuer = options.issuer;
        this.clientId = options.clientId;
        this.scopes = options.scopes || 'openid';
        this.audience = options.audience;
        this.callbackPort = options.callbackPort;
    }

    async init(): Promise<void> {
        const discoveryUrl = this.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
        const response = await fetch(discoveryUrl);
        if (!response.ok)
            throw new Error('failed to fetch OIDC discovery document from ' + discoveryUrl);
        this.discovery = await response.json() as OidcDiscovery;
        if (!this.discovery.authorization_endpoint || !this.discovery.token_endpoint)
            throw new Error('OIDC discovery document is missing required endpoints (authorization_endpoint, token_endpoint)');
    }

    async authorize(): Promise<OidcTokens> {
        const codeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

        const { code, redirectUri } = await this.listenForCallback(codeChallenge);

        return this.exchangeCode(code, codeVerifier, redirectUri);
    }

    async refreshToken(refreshToken: string): Promise<OidcTokens> {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.clientId,
            refresh_token: refreshToken,
        });

        const response = await fetch(this.discovery.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!response.ok)
            throw new Error('token refresh failed (HTTP ' + response.status + ')');

        const tokens = this.parseTokenResponse(await response.json());
        // Preserve the original refresh token if the provider didn't issue a new one
        if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
        return tokens;
    }

    private listenForCallback(codeChallenge: string): Promise<{ code: string; redirectUri: string }> {
        return new Promise((resolve, reject) => {
            let expectedState: string;
            let redirectUri: string;

            const server = http.createServer((req, res) => {
                const url = new URL(req.url!, 'http://127.0.0.1');

                if (url.pathname !== '/callback') {
                    res.writeHead(404);
                    res.end();
                    return;
                }

                const returnedState = url.searchParams.get('state');

                if (!returnedState || returnedState !== expectedState) {
                    res.writeHead(400);
                    res.end('state mismatch');
                    return;
                }

                const error = url.searchParams.get('error');

                if (error) {
                    const desc = url.searchParams.get('error_description') || error;
                    const safeDesc = desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<html><body><h1>Authentication failed</h1><p>' + safeDesc + '</p><p>You can close this tab.</p></body></html>');
                    server.close();
                    reject(new Error('OIDC authorization failed: ' + desc));
                    return;
                }

                const code = url.searchParams.get('code');

                if (!code) {
                    res.writeHead(400);
                    res.end('missing code parameter');
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<html><body><h1>Authenticated</h1><p>You can close this tab and return to the terminal.</p></body></html>');
                server.close();

                resolve({ code, redirectUri });
            });

            server.on('error', (err: Error) => {
                reject(new Error('failed to start OIDC callback server: ' + err.message));
            });

            server.listen(this.callbackPort || 0, '127.0.0.1', () => {
                const port = (server.address() as { port: number }).port;
                redirectUri = 'http://127.0.0.1:' + port + '/callback';
                expectedState = crypto.randomBytes(16).toString('hex');

                const params = new URLSearchParams({
                    response_type: 'code',
                    client_id: this.clientId,
                    redirect_uri: redirectUri,
                    scope: this.scopes,
                    state: expectedState,
                    code_challenge: codeChallenge,
                    code_challenge_method: 'S256',
                });
                if (this.audience) params.set('audience', this.audience);

                const authUrl = this.discovery.authorization_endpoint + '?' + params.toString();

                process.stderr.write('\nOpening browser for authentication...\n');
                process.stderr.write('If the browser does not open, visit:\n  ' + authUrl + '\n\n');

                try {
                    this.openBrowser(authUrl);
                } catch {
                    // browser open failed, user can use the printed URL
                }
            });

            setTimeout(() => {
                server.close();
                reject(new Error('OIDC authorization timed out after 120 seconds'));
            }, 120_000);
        });
    }

    private async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<OidcTokens> {
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.clientId,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
        });

        const response = await fetch(this.discovery.token_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error('token exchange failed (HTTP ' + response.status + '): ' + text);
        }

        return this.parseTokenResponse(await response.json());
    }

    private parseTokenResponse(data: any): OidcTokens {
        if (!data.access_token)
            throw new Error('token response is missing access_token');
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
        };
    }

    private openBrowser(url: string): void {
        const platform = process.platform;
        if (platform === 'darwin') execSync('open ' + JSON.stringify(url));
        else if (platform === 'linux') execSync('xdg-open ' + JSON.stringify(url));
        else if (platform === 'win32') execSync('start "" ' + JSON.stringify(url));
    }
}
