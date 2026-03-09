#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import debug from 'debug';
import { program } from 'commander';

import { ClientError } from './Errors';
import { Client } from './Client';
import { OidcClient } from './OidcClient';
import { TokenCache } from './TokenCache';
import { UrlHelper } from './UrlHelper';

interface Config {
    proto?: string;
    target?: string;
    tpotServer?: string;
    authKey?: string;
    subdomain?: string;
    httpHost?: string;
    noHostRewrite?: boolean;
    oidcIssuer?: string;
    oidcClientId?: string;
    oidcScopes?: string;
    oidcAudience?: string;
    oidcCallbackPort?: number;
}

interface ServerAuthConfig {
    method: 'none' | 'static_key' | 'oidc';
    oidcIssuer?: string;
    oidcClientId?: string;
    oidcScopes?: string;
    oidcAudience?: string;
}

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tpot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

let config: Config = {};
let isConfigCommand = false;

program
    .option('-t, --tpot-server <server>', 'the URL of the TPoT server')
    .option('-k, --auth-key <key>', 'authentication key')
    .option('-s, --subdomain <subdomain>', 'request a specific subdomain')
    .option('-h, --http-host <host>', 'override Host header rewrite')
    .option('-n, --no-host-rewrite', 'disable Host header rewrite')
    .option('-d, --debug', 'enable debug logging')
    .option('--oidc-issuer <url>', 'OIDC issuer URL (override server-provided value)')
    .option('--oidc-client-id <id>', 'OIDC client ID (override server-provided value)')
    .option('--oidc-scopes <scopes>', 'OIDC scopes (override server-provided value)')
    .option('--oidc-callback-port <port>', 'fixed port for OIDC callback (default: random)', parseInt)
    .option('--oidc-debug', 'print the OIDC access token to stderr');

program.command('http <target>').description('create a tunnel to an HTTP(S) server').action((inTarget: string) => {
    config.proto = 'http';
    config.target = inTarget;
});

program.command('config').description('save options to ~/.tpot/config.json').action(() => {
    isConfigCommand = true;
});

program.parse(process.argv);

const opts = program.opts();

if (opts.debug) {
    debug.enable('*');
}

function die(message: string): never {
    process.stderr.write(message + '\n');
    process.exit(-1);
}

// Handle config command
if (isConfigCommand) {
    let existing: Record<string, any> = {};
    try {
        existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (typeof existing !== 'object' || existing == null || Array.isArray(existing)) {
            existing = {};
        }
    } catch {
        // file doesn't exist or is corrupt, start fresh
    }

    const configKeys: Array<{ opt: string; key: string }> = [
        { opt: 'tpotServer', key: 'tpotServer' },
        { opt: 'authKey', key: 'authKey' },
        { opt: 'subdomain', key: 'subdomain' },
        { opt: 'httpHost', key: 'httpHost' },
        { opt: 'noHostRewrite', key: 'noHostRewrite' },
        { opt: 'oidcIssuer', key: 'oidcIssuer' },
        { opt: 'oidcClientId', key: 'oidcClientId' },
        { opt: 'oidcScopes', key: 'oidcScopes' },
        { opt: 'oidcCallbackPort', key: 'oidcCallbackPort' },
    ];

    let changed = false;
    for (const { opt, key } of configKeys) {
        if (opts[opt] !== undefined) {
            existing[key] = opts[opt];
            changed = true;
        }
    }

    if (!changed) {
        die('No options provided. Usage: tpot config --tpot-server https://tpot.example.com [--auth-key ...] ...');
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });

    process.stdout.write('Configuration saved to ' + CONFIG_FILE + '\n');
    process.exit(0);
}

// Load config file
try {
    const storedJson = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsedConfig = JSON.parse(storedJson);

    if (typeof parsedConfig === 'object' && parsedConfig != null && !Array.isArray(parsedConfig)) {
        config = Object.assign(parsedConfig, config);
    } else {
        process.stderr.write('WARNING: Your configuration file at ~/.tpot/config.json appears to be corrupt.\n');
    }
} catch (err: any) {
    if (err.code === 'ENOENT') {
        // do nothing. file just doesn't exist.
    } else if (/^Unexpected token.*in JSON/.test(err.message)) {
        process.stderr.write('WARNING: Your configuration file at ~/.tpot/config.json appears to be corrupt.\n');
    } else {
        throw err;
    }
}

if (opts.tpotServer) config.tpotServer = opts.tpotServer;
if (opts.authKey) config.authKey = opts.authKey;
if (opts.subdomain) config.subdomain = opts.subdomain;
if (opts.httpHost) config.httpHost = opts.httpHost;
if (opts.noHostRewrite) config.noHostRewrite = opts.noHostRewrite;
if (opts.oidcIssuer) config.oidcIssuer = opts.oidcIssuer;
if (opts.oidcClientId) config.oidcClientId = opts.oidcClientId;
if (opts.oidcScopes) config.oidcScopes = opts.oidcScopes;
if (opts.oidcCallbackPort) config.oidcCallbackPort = opts.oidcCallbackPort;

if (!config.tpotServer) die('Server is not specified by configuration file or CLI option.');

const serverMatches = config.tpotServer!.match(/^((https?):\/\/)?([a-z0-9.]+)(:([0-9]+))?\/?$/i);
if (!serverMatches) die('Server is not valid. Examples of valid formats:\n  tpot.sgnl24.com\n  tpot.sgnl24.com:1234\n  http://tpot.sgnl24.com\n  https://tpot.sgnl24.com\n  https://tpot.sgnl24.com:1234');

if (opts.subdomain) {
    const subdomainMatches = opts.subdomain.match(/^[a-z0-9-]{1,24}$/);
    if (!subdomainMatches) die('Subdomain is not valid. Subdomains may contain uppercase and lowercase letters, digits 0-9, and hypens, but must not start with a hyphen.');
}

const targetMatches = config.target!.match(/^((https?):\/\/)?([a-z0-9.]+)(:([0-9]+))?\/?$/i);
if (!targetMatches) die('Target is not valid. Examples of valid formats:\n  127.0.0.1\n  127.0.0.1:8080\n  http://127.0.0.1\n  https://127.0.0.1\n  https://localhost:1234');

if (targetMatches[2] === 'https') die('HTTPS targets not yet implemented. Check back soon!');

async function fetchServerAuthConfig(): Promise<ServerAuthConfig> {
    const helper = new UrlHelper();
    const server = helper.extractUrlComponents(config.tpotServer!);
    const url = server.protocol + '://' + server.hostWithPort + '/tpot-auth';

    try {
        const response = await fetch(url);
        if (!response.ok) return { method: 'none' };
        return await response.json() as ServerAuthConfig;
    } catch {
        // Server may not support /tpot-auth (older version), fall back to local config
        return { method: 'none' };
    }
}

async function getOidcToken(): Promise<string | undefined> {
    if (!config.oidcIssuer || !config.oidcClientId) return undefined;

    const cache = new TokenCache();
    const cacheKey = TokenCache.cacheKey(config.oidcIssuer, config.oidcClientId, config.oidcScopes);

    // Check for cached valid token
    const cached = cache.get(cacheKey);
    if (cached) return cached.accessToken;

    const oidc = new OidcClient({
        issuer: config.oidcIssuer,
        clientId: config.oidcClientId,
        scopes: config.oidcScopes,
        audience: config.oidcAudience,
        callbackPort: config.oidcCallbackPort,
    });
    await oidc.init();

    // Try refresh if we have an expired token with refresh_token
    const expired = cache.getExpired(cacheKey);
    if (expired?.refreshToken) {
        try {
            const tokens = await oidc.refreshToken(expired.refreshToken);
            cache.set(cacheKey, tokens);
            return tokens.accessToken;
        } catch {
            // refresh failed, fall through to interactive auth
        }
    }

    // Interactive authorization
    const tokens = await oidc.authorize();
    cache.set(cacheKey, tokens);
    return tokens.accessToken;
}

const errHandler = (err: Error) => {
    if (err instanceof ClientError) {
        process.stderr.write(err.message);
        process.stderr.write('\n');
    } else {
        console.error(err);
    }

    process.exit(-1);
};

process.on('unhandledRejection', errHandler as any);
process.on('uncaughtException', errHandler);

(async () => {
    // Fetch auth config from server; server-provided OIDC params fill in gaps
    const serverAuth = await fetchServerAuthConfig();

    if (serverAuth.method === 'oidc') {
        if (!config.oidcIssuer && serverAuth.oidcIssuer) config.oidcIssuer = serverAuth.oidcIssuer;
        if (!config.oidcClientId && serverAuth.oidcClientId) config.oidcClientId = serverAuth.oidcClientId;
        if (!config.oidcScopes && serverAuth.oidcScopes) config.oidcScopes = serverAuth.oidcScopes;
        if (!config.oidcAudience && serverAuth.oidcAudience) config.oidcAudience = serverAuth.oidcAudience;
    } else if (!opts.oidcIssuer && !opts.oidcClientId) {
        // Server doesn't use OIDC — clear any stale OIDC config from config file
        // to prevent leaking tokens to a server that no longer expects them
        delete config.oidcIssuer;
        delete config.oidcClientId;
        delete config.oidcScopes;
        delete config.oidcAudience;
    }

    // Validate auth config
    if (config.authKey && config.oidcIssuer)
        die('--auth-key and OIDC are mutually exclusive. The server requires OIDC but you provided --auth-key.');

    if (config.oidcIssuer && !config.oidcClientId)
        die('OIDC client ID is required but was not provided by the server or via --oidc-client-id.');

    if (config.oidcIssuer && !/^https:\/\/.+/.test(config.oidcIssuer))
        die('OIDC issuer must be an HTTPS URL.');

    if (config.oidcIssuer && serverMatches[2] !== 'https')
        die('OIDC authentication requires an HTTPS server URL to prevent leaking Bearer tokens.');

    const oidcToken = await getOidcToken();

    if (oidcToken && opts.oidcDebug) {
        process.stderr.write('OIDC access token:\n' + oidcToken + '\n\n');
    }

    const client = new Client();

    client.configure({
        server: config.tpotServer as any,
        authKey: config.authKey,
        oidcToken,
        subdomain: config.subdomain,
        target: config.target as any,
        rewriteHost: config.noHostRewrite ? false : (config.httpHost || undefined),
    });

    await client.init();

    process.stdout.write('tpot connected\n');
    process.stdout.write(`${client.tunnelUrl}\n`);
})();
