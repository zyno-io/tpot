import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import WebSocket, { WebSocketServer } from 'ws';

import { Server } from '@zyno-io/tpot-server/dist/Server';
import { TunnelStore } from '@zyno-io/tpot-server/dist/TunnelStore';
import { TunnelBuilder } from '@zyno-io/tpot-server/dist/TunnelBuilder';
import { Client } from 'tpot/dist/Client';

const DOMAIN = 'localhost';

function httpRequest(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/** Send a raw HTTP request via TCP to avoid any Node http client header magic. */
function rawRequest(port: number, raw: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
        let data = '';
        socket.on('data', chunk => data += chunk);
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
        setTimeout(() => { socket.destroy(); reject(new Error('rawRequest timeout')); }, 5000);
    });
}

/** Send raw TCP data in multiple segments with a delay between each. */
function rawSegmentedRequest(port: number, segments: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', async () => {
            for (const segment of segments) {
                socket.write(segment);
                await new Promise(r => setTimeout(r, 20));
            }
        });
        let data = '';
        socket.on('data', chunk => data += chunk);
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
        setTimeout(() => { socket.destroy(); reject(new Error('rawSegmentedRequest timeout')); }, 5000);
    });
}

function waitForListening(server: net.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server listen timeout')), 5000);
        server.once('listening', () => { clearTimeout(timer); resolve(); });
    });
}

interface TestEnv {
    upstream?: http.Server;
    server?: Server;
    client?: Client;
}

function teardown(env: TestEnv): () => Promise<void> {
    return async () => {
        if (env.client?.pingInterval) clearInterval(env.client.pingInterval);
        if (env.client?.ws) env.client.ws.close();
        if (env.server?.netServer) env.server.netServer.close();
        if (env.server?.wss) env.server.wss.close();
        if (env.upstream) env.upstream.close();
        await new Promise(r => setTimeout(r, 50));
    };
}

function resetSingletons(): void {
    TunnelStore.instance.tunnels = {};
    TunnelBuilder.instance = new TunnelBuilder();
}

async function startServer(domains: string | string[], opts?: { authKey?: string; oidcIssuer?: string; oidcClientId?: string; oidcScopes?: string }): Promise<Server> {
    resetSingletons();
    const server = new Server();
    server.configure({ domains: Array.isArray(domains) ? domains : [domains], port: 0, ...opts });
    await server.init();
    await waitForListening(server.netServer);
    return server;
}

function serverPort(server: Server): number {
    return (server.netServer.address() as net.AddressInfo).port;
}

async function startClient(server: Server, upstreamPort: number, opts?: { authKey?: string; subdomain?: string; rewriteHost?: string | false }): Promise<Client> {
    const port = serverPort(server);
    const client = new Client();
    client.handleWsDisconnected = () => {};
    client.configure({
        server: `http://${DOMAIN}:${port}` as any,
        target: `http://127.0.0.1:${upstreamPort}` as any,
        rewriteHost: `127.0.0.1:${upstreamPort}`,
        ...opts,
    });
    await client.init();
    return client;
}

function extractSubdomain(client: Client): string {
    const match = client.tunnelUrl!.match(/^http:\/\/([^.]+)\./);
    assert.ok(match, 'tunnel URL should contain a subdomain');
    return match![1];
}

describe('E2E: client ↔ server', () => {
    const env: TestEnv = {};
    let upstreamPort: number;
    let sPort: number;
    let tunnelSubdomain: string;

    before(async () => {
        env.upstream = http.createServer((req, res) => {
            if (req.url === '/hello') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('world');
                return;
            }
            if (req.url === '/echo') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    res.writeHead(200, {
                        'Content-Type': 'text/plain',
                        'X-Echo-Method': req.method!,
                        'X-Echo-Host': req.headers.host || '',
                    });
                    res.end(body);
                });
                return;
            }
            if (req.url === '/large') {
                const payload = Buffer.alloc(64 * 1024, 'A');
                res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) });
                res.end(payload);
                return;
            }
            res.writeHead(404);
            res.end('not found');
        });
        await new Promise<void>(r => env.upstream!.listen(0, '127.0.0.1', r));
        upstreamPort = (env.upstream.address() as net.AddressInfo).port;

        env.server = await startServer(DOMAIN);
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, upstreamPort);
        assert.ok(env.client.tunnelUrl);
        tunnelSubdomain = extractSubdomain(env.client);
    });

    after(teardown(env));

    it('should tunnel a simple GET request', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/hello',
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'world');
    });

    it('should tunnel a POST request with body', async () => {
        const payload = 'test-body-content';
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/echo',
            method: 'POST',
            headers: {
                Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}`,
                'Content-Type': 'text/plain',
                'Content-Length': String(Buffer.byteLength(payload)),
            },
        }, payload);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, payload);
        assert.equal(res.headers['x-echo-method'], 'POST');
    });

    it('should rewrite the Host header to the upstream target', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/echo',
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['x-echo-host'], `127.0.0.1:${upstreamPort}`);
    });

    it('should handle large responses', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/large',
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.length, 64 * 1024);
    });

    it('should return 503 for unknown subdomains', async () => {
        const raw = `GET / HTTP/1.1\r\nHost: nonexistent.${DOMAIN}:${sPort}\r\nConnection: close\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 503'), `expected 503 response, got: ${response.substring(0, 60)}`);
    });

    it('should return 404 for direct domain requests to unknown paths', async () => {
        const raw = `GET /unknown HTTP/1.1\r\nHost: ${DOMAIN}:${sPort}\r\nConnection: close\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 404'), `expected 404 response, got: ${response.substring(0, 60)}`);
    });

    it('should handle multiple concurrent requests', async () => {
        const requests = Array.from({ length: 5 }, (_, i) =>
            httpRequest({
                hostname: '127.0.0.1',
                port: sPort,
                path: '/echo',
                method: 'POST',
                headers: {
                    Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}`,
                    'Content-Type': 'text/plain',
                    'Content-Length': String(Buffer.byteLength(`msg-${i}`)),
                },
            }, `msg-${i}`)
        );
        const results = await Promise.all(requests);
        const bodies = results.map(r => r.body).sort();
        assert.deepEqual(bodies, ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
    });
});

describe('E2E: authenticated tunnel', () => {
    const env: TestEnv = {};
    let sPort: number;
    let tunnelSubdomain: string;
    const AUTH_KEY = 'this-is-a-test-auth-key-that-is-long-enough';

    before(async () => {
        env.upstream = http.createServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('authenticated');
        });
        await new Promise<void>(r => env.upstream!.listen(0, '127.0.0.1', r));
        const upstreamPort = (env.upstream.address() as net.AddressInfo).port;

        env.server = await startServer(DOMAIN, { authKey: AUTH_KEY });
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, upstreamPort, { authKey: AUTH_KEY });
        assert.ok(env.client.tunnelUrl);
        tunnelSubdomain = extractSubdomain(env.client);
    });

    after(teardown(env));

    it('should tunnel requests when authenticated', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/',
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'authenticated');
    });
});

describe('E2E: custom subdomain', () => {
    const env: TestEnv = {};
    let sPort: number;

    before(async () => {
        env.upstream = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('ok');
        });
        await new Promise<void>(r => env.upstream!.listen(0, '127.0.0.1', r));
        const upstreamPort = (env.upstream.address() as net.AddressInfo).port;

        env.server = await startServer(DOMAIN);
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, upstreamPort, { subdomain: 'my-tunnel' });
    });

    after(teardown(env));

    it('should assign the requested subdomain', () => {
        assert.ok(env.client!.tunnelUrl!.includes('my-tunnel.'));
    });

    it('should be reachable via the custom subdomain', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/',
            headers: { Host: `my-tunnel.${DOMAIN}:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'ok');
    });
});

describe('E2E: multiple domains', () => {
    const env: TestEnv = {};
    let sPort: number;
    let tunnelSubdomain: string;

    before(async () => {
        env.upstream = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('multi');
        });
        await new Promise<void>(r => env.upstream!.listen(0, '127.0.0.1', r));
        const upstreamPort = (env.upstream.address() as net.AddressInfo).port;

        env.server = await startServer(['localhost', '127.0.0.1']);
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, upstreamPort);
        assert.ok(env.client.tunnelUrl);
        tunnelSubdomain = extractSubdomain(env.client);
    });

    after(teardown(env));

    it('should accept requests via the first domain', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/',
            headers: { Host: `${tunnelSubdomain}.localhost:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'multi');
    });

    it('should accept requests via the second domain', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/',
            headers: { Host: `${tunnelSubdomain}.127.0.0.1:${sPort}` },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body, 'multi');
    });

    it('should accept direct requests to any configured domain', async () => {
        const raw = `GET /unknown HTTP/1.1\r\nHost: 127.0.0.1:${sPort}\r\nConnection: close\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 404'), `expected 404 for direct request, got: ${response.substring(0, 60)}`);
    });

    it('should reject requests to unconfigured domains', async () => {
        const raw = `GET / HTTP/1.1\r\nHost: ${tunnelSubdomain}.other.test:${sPort}\r\nConnection: close\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 404'), `expected 404 for unknown domain, got: ${response.substring(0, 60)}`);
    });
});

describe('E2E: upstream not reachable', () => {
    const env: TestEnv = {};
    let sPort: number;
    let tunnelSubdomain: string;

    before(async () => {
        env.server = await startServer(DOMAIN);
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, 1); // port 1 — nothing listening
        assert.ok(env.client.tunnelUrl);
        tunnelSubdomain = extractSubdomain(env.client);
    });

    after(teardown(env));

    it('should return 503 when upstream cannot connect', async () => {
        const raw = `GET / HTTP/1.1\r\nHost: ${tunnelSubdomain}.${DOMAIN}:${sPort}\r\nConnection: close\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 503'), `expected 503, got: ${response.substring(0, 60)}`);
    });
});

describe('E2E: HTTP parsing edge cases', () => {
    const env: TestEnv = {};
    let sPort: number;
    let tunnelSubdomain: string;

    before(async () => {
        env.upstream = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                res.writeHead(200, {
                    'Content-Type': 'text/plain',
                    'X-Echo-Host': req.headers.host || '',
                    'X-Echo-Connection': req.headers.connection || '',
                });
                res.end(body || 'ok');
            });
        });
        await new Promise<void>(r => env.upstream!.listen(0, '127.0.0.1', r));
        const upstreamPort = (env.upstream.address() as net.AddressInfo).port;

        env.server = await startServer(DOMAIN);
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, upstreamPort);
        assert.ok(env.client.tunnelUrl);
        tunnelSubdomain = extractSubdomain(env.client);
    });

    after(teardown(env));

    it('should accept headers without space after colon', async () => {
        const raw = `GET / HTTP/1.1\r\nHost:${tunnelSubdomain}.${DOMAIN}:${sPort}\r\nConnection:close\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 200'), `expected 200, got: ${response.substring(0, 60)}`);
    });

    it('should detect header terminator split across TCP segments', async () => {
        const response = await rawSegmentedRequest(sPort, [
            `GET / HTTP/1.1\r\nHost: ${tunnelSubdomain}.${DOMAIN}:${sPort}\r\n`,
            `Connection: close\r\n`,
            `\r\n`,
        ]);
        assert.ok(response.startsWith('HTTP/1.1 200'), `expected 200, got: ${response.substring(0, 60)}`);
    });

    it('should detect request line CRLF split across TCP segments', async () => {
        const response = await rawSegmentedRequest(sPort, [
            `GET / HTTP/1.1`,
            `\r\nHost: ${tunnelSubdomain}.${DOMAIN}:${sPort}\r\nConnection: close\r\n\r\n`,
        ]);
        assert.ok(response.startsWith('HTTP/1.1 200'), `expected 200, got: ${response.substring(0, 60)}`);
    });

    it('should not reject requests whose headers are small but body pushes total size over limit', async () => {
        const body = 'X'.repeat(10000);
        const raw = `POST / HTTP/1.1\r\nHost: ${tunnelSubdomain}.${DOMAIN}:${sPort}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
        const response = await rawRequest(sPort, raw);
        assert.ok(!response.startsWith('HTTP/1.1 413'), `expected non-413, got: ${response.substring(0, 60)}`);
    });

    it('should enforce header size limit even after request line is parsed', async () => {
        const bigHeader = 'X-Padding: ' + 'A'.repeat(8200);
        const raw = `GET / HTTP/1.1\r\nHost: ${tunnelSubdomain}.${DOMAIN}:${sPort}\r\n${bigHeader}\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 413'), `expected 413, got: ${response.substring(0, 60)}`);
    });

    it('should return 400 for /create-tpot without Connection header', async () => {
        const raw = `GET /create-tpot HTTP/1.1\r\nHost: ${DOMAIN}:${sPort}\r\nUpgrade: websocket\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 400'), `expected 400, got: ${response.substring(0, 60)}`);
    });

    it('should return 400 for /create-tpot without Upgrade header', async () => {
        const raw = `GET /create-tpot HTTP/1.1\r\nHost: ${DOMAIN}:${sPort}\r\nConnection: upgrade\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 400'), `expected 400, got: ${response.substring(0, 60)}`);
    });

    it('should accept Connection header with multiple values including upgrade', async () => {
        // This tests that "keep-alive, Upgrade" is accepted (Bug 6 fix)
        // We can't fully complete a WS handshake here, but we should NOT get 400 for the connection header.
        // We'll get 400 for missing Sec-WebSocket-Key or similar, but the Connection check should pass.
        const raw = `GET /create-tpot HTTP/1.1\r\nHost: ${DOMAIN}:${sPort}\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        // Should not be "incorrect connection header"
        assert.ok(!response.includes('incorrect connection header'), `Connection: keep-alive, Upgrade should be accepted`);
    });

    it('should force Connection: close on tunneled requests', async () => {
        const res = await httpRequest({
            hostname: '127.0.0.1',
            port: sPort,
            path: '/',
            headers: {
                Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}`,
                Connection: 'keep-alive',
            },
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['x-echo-connection'], 'close');
    });

    it('should add Connection: close when no Connection header is sent', async () => {
        // Use raw request to avoid Node http client adding Connection: keep-alive
        const raw = `GET / HTTP/1.1\r\nHost: ${tunnelSubdomain}.${DOMAIN}:${sPort}\r\n\r\n`;
        const response = await rawRequest(sPort, raw);
        assert.ok(response.startsWith('HTTP/1.1 200'), `expected 200, got: ${response.substring(0, 60)}`);
        const connectionHeader = response.match(/x-echo-connection: (.*)\r\n/i);
        assert.ok(connectionHeader, 'response should include x-echo-connection header');
        assert.equal(connectionHeader![1], 'close');
    });
});

describe('E2E: tunneled WebSocket connections', () => {
    const env: TestEnv = {};
    let sPort: number;
    let tunnelSubdomain: string;
    let wss: WebSocketServer;

    before(async () => {
        env.upstream = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('http-ok');
        });
        wss = new WebSocketServer({ server: env.upstream });
        wss.on('connection', (ws) => {
            ws.on('message', (msg) => {
                ws.send('echo:' + msg.toString());
            });
        });
        await new Promise<void>(r => env.upstream!.listen(0, '127.0.0.1', r));
        const upstreamPort = (env.upstream.address() as net.AddressInfo).port;

        env.server = await startServer(DOMAIN);
        sPort = serverPort(env.server);

        env.client = await startClient(env.server, upstreamPort);
        assert.ok(env.client.tunnelUrl);
        tunnelSubdomain = extractSubdomain(env.client);
    });

    after(async () => {
        wss.close();
        await teardown(env)();
    });

    it('should tunnel a WebSocket connection and exchange messages', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${sPort}/ws`, {
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });

        const opened = new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('ws open timeout')), 5000);
        });

        await opened;

        const reply = new Promise<string>((resolve, reject) => {
            ws.on('message', (data) => resolve(data.toString()));
            ws.on('error', reject);
            setTimeout(() => reject(new Error('ws message timeout')), 5000);
        });

        ws.send('hello');
        const response = await reply;
        assert.equal(response, 'echo:hello');

        ws.close();
    });

    it('should exchange multiple WebSocket messages', async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${sPort}/ws`, {
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });

        await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('ws open timeout')), 5000);
        });

        const messages: string[] = [];
        const allReceived = new Promise<void>((resolve, reject) => {
            ws.on('message', (data) => {
                messages.push(data.toString());
                if (messages.length === 3) resolve();
            });
            setTimeout(() => reject(new Error('ws messages timeout')), 5000);
        });

        ws.send('one');
        ws.send('two');
        ws.send('three');

        await allReceived;
        assert.deepEqual(messages, ['echo:one', 'echo:two', 'echo:three']);

        ws.close();
    });

    it('should preserve Connection: Upgrade header (not rewrite to close)', async () => {
        // If Connection were rewritten to "close", the upstream WS server would reject the handshake.
        // A successful open proves the header was preserved.
        const ws = new WebSocket(`ws://127.0.0.1:${sPort}/ws`, {
            headers: { Host: `${tunnelSubdomain}.${DOMAIN}:${sPort}` },
        });

        await new Promise<void>((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('ws open timeout')), 5000);
        });

        // Send a message to confirm the connection is fully functional
        const reply = new Promise<string>((resolve, reject) => {
            ws.on('message', (data) => resolve(data.toString()));
            setTimeout(() => reject(new Error('ws message timeout')), 5000);
        });
        ws.send('upgrade-test');
        assert.equal(await reply, 'echo:upgrade-test');

        ws.close();
    });
});

describe('E2E: /tpot-auth endpoint', () => {
    it('should return method:none when no auth configured', async () => {
        const env: any = {};
        env.server = await startServer(DOMAIN);
        const port = serverPort(env.server);

        const res = await httpRequest({ hostname: '127.0.0.1', port, path: '/tpot-auth', headers: { Host: DOMAIN } });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.method, 'none');

        env.server.netServer.close();
    });

    it('should return method:static_key when authKey configured', async () => {
        const env: any = {};
        env.server = await startServer(DOMAIN, { authKey: 'a'.repeat(32) });
        const port = serverPort(env.server);

        const res = await httpRequest({ hostname: '127.0.0.1', port, path: '/tpot-auth', headers: { Host: DOMAIN } });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.method, 'static_key');
        assert.equal(body.oidcIssuer, undefined);

        env.server.netServer.close();
    });

    it('should return OIDC config when oidcDiscoveryUrl configured', async () => {
        // Start server without OIDC (to avoid real discovery fetch), then set options directly
        resetSingletons();
        const server = new Server();
        server.configure({ domains: [DOMAIN], port: 0 });
        await server.init();
        await waitForListening(server.netServer);

        // Set OIDC options after init to avoid discovery fetch
        server.options.oidcDiscoveryUrl = 'https://example.com/';
        server.options.oidcClientId = 'test-client-id';
        server.options.oidcScopes = 'openid profile';
        server.options.oidcAudience = 'test-audience';

        const port = serverPort(server);

        const res = await httpRequest({ hostname: '127.0.0.1', port, path: '/tpot-auth', headers: { Host: DOMAIN } });
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.method, 'oidc');
        assert.equal(body.oidcIssuer, 'https://example.com/');
        assert.equal(body.oidcClientId, 'test-client-id');
        assert.equal(body.oidcScopes, 'openid profile');
        assert.equal(body.oidcAudience, 'test-audience');

        server.netServer.close();
    });
});
