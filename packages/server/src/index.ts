import 'dotenv/config';
import debug from 'debug';

import { Server } from './Server';

if (!process.env.DOMAIN)
    throw new Error('DOMAIN must be configured');

const domains = process.env.DOMAIN.split(',').map(d => d.trim()).filter(Boolean);
if (domains.length === 0)
    throw new Error('DOMAIN must contain at least one domain');
if (process.env.AUTH_KEY && process.env.OIDC_DISCOVERY_URL)
    throw new Error('AUTH_KEY and OIDC_DISCOVERY_URL are mutually exclusive. Configure one or the other, not both.');
if (process.env.AUTH_KEY && process.env.AUTH_KEY.length < 32)
    throw new Error('AUTH_KEY, if provided, must be at least 32 characters');
if (process.env.OIDC_DISCOVERY_URL && !/^https:\/\/.+/.test(process.env.OIDC_DISCOVERY_URL))
    throw new Error('OIDC_DISCOVERY_URL must be an HTTPS URL');
if (process.env.OIDC_ISSUER && !/^https:\/\/.+/.test(process.env.OIDC_ISSUER))
    throw new Error('OIDC_ISSUER must be an HTTPS URL');
if (process.env.PORT && (!/^[1-9]+[0-9]*$/.test(process.env.PORT) || parseInt(process.env.PORT) > 65535))
    throw new Error('PORT must be an integer between 1 and 65535');

let oidcRequiredClaims: Record<string, string> | undefined;
if (process.env.OIDC_REQUIRED_CLAIMS) {
    oidcRequiredClaims = {};
    for (const pair of process.env.OIDC_REQUIRED_CLAIMS.split(',')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx < 1) throw new Error('OIDC_REQUIRED_CLAIMS must be comma-separated key=value pairs');
        oidcRequiredClaims[pair.substring(0, eqIdx).trim()] = pair.substring(eqIdx + 1).trim();
    }
}

debug.enable('*');

const server = new Server();

server.configure({
    domains,
    authKey: process.env.AUTH_KEY,
    oidcDiscoveryUrl: process.env.OIDC_DISCOVERY_URL,
    oidcIssuer: process.env.OIDC_ISSUER,
    oidcAudience: process.env.OIDC_AUDIENCE,
    oidcClientId: process.env.OIDC_CLIENT_ID,
    oidcScopes: process.env.OIDC_SCOPES,
    oidcRequiredClaims,
    port: process.env.PORT ? parseInt(process.env.PORT) : undefined
});

(async () => {
    await server.init();
})();
