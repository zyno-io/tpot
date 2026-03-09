import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import debugFactory from 'debug';

const log = debugFactory('oidc');

export interface OidcVerifierOptions {
    discoveryUrl: string;
    issuer?: string;
    audience?: string;
    requiredClaims?: Record<string, string>;
}

export class OidcVerifier {
    private discoveryUrl: string;
    private issuer?: string;
    private audience?: string;
    private requiredClaims?: Record<string, string>;
    private jwks!: JWTVerifyGetKey;

    constructor(options: OidcVerifierOptions) {
        this.discoveryUrl = options.discoveryUrl;
        this.issuer = options.issuer;
        this.audience = options.audience;
        this.requiredClaims = options.requiredClaims;
    }

    async init(): Promise<void> {
        const discoveryUrl = this.discoveryUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';
        log('fetching OIDC discovery from %s', discoveryUrl);

        const response = await fetch(discoveryUrl);
        if (!response.ok)
            throw new Error('failed to fetch OIDC discovery document from ' + discoveryUrl + ' (HTTP ' + response.status + ')');

        const discovery = await response.json() as { jwks_uri?: string; issuer?: string };
        if (!discovery.jwks_uri)
            throw new Error('OIDC discovery document does not contain jwks_uri');

        if (!this.issuer) {
            if (!discovery.issuer)
                throw new Error('OIDC discovery document does not contain issuer and OIDC_ISSUER is not set');
            log('using issuer from discovery: %s', discovery.issuer);
            this.issuer = discovery.issuer;
        } else {
            log('using configured issuer override: %s', this.issuer);
        }

        log('using JWKS URI: %s', discovery.jwks_uri);
        this.jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    }

    async verify(token: string): Promise<JWTPayload> {
        const { payload } = await jwtVerify(token, this.jwks, {
            issuer: this.issuer,
            audience: this.audience,
        });

        if (this.requiredClaims) {
            for (const [key, value] of Object.entries(this.requiredClaims)) {
                if (String(payload[key]) !== value)
                    throw new Error('required claim ' + key + ' does not match');
            }
        }

        return payload;
    }
}
