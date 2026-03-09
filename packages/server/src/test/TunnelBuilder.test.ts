import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TunnelBuilder } from '../TunnelBuilder';
import { TunnelStore } from '../TunnelStore';
import { HttpError } from '../Errors';

describe('TunnelBuilder', () => {
    afterEach(() => {
        for (const key of Object.keys(TunnelStore.instance.tunnels)) {
            delete TunnelStore.instance.tunnels[key];
        }
    });

    describe('validateSubdomain', () => {
        const builder = TunnelBuilder.instance;

        it('should accept valid subdomains', () => {
            assert.doesNotThrow(() => builder.validateSubdomain('myapp'));
            assert.doesNotThrow(() => builder.validateSubdomain('my-app'));
            assert.doesNotThrow(() => builder.validateSubdomain('a'));
            assert.doesNotThrow(() => builder.validateSubdomain('abc123'));
        });

        it('should reject subdomains starting with hyphen', () => {
            assert.throws(() => builder.validateSubdomain('-myapp'), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 400);
                return true;
            });
        });

        it('should reject subdomains longer than 24 characters', () => {
            assert.throws(() => builder.validateSubdomain('a'.repeat(25)), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 400);
                return true;
            });
        });

        it('should reject subdomains with invalid characters', () => {
            assert.throws(() => builder.validateSubdomain('my_app'), (err: any) => {
                assert.ok(err instanceof HttpError);
                return true;
            });
        });

        it('should reject subdomain that is already in use', () => {
            TunnelStore.instance.tunnels['taken'] = { cxn: {} as any, socket: {} as any };
            assert.throws(() => builder.validateSubdomain('taken'), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 409);
                return true;
            });
        });
    });

    describe('generateSubdomain', () => {
        const builder = TunnelBuilder.instance;

        it('should generate an 8-character alphanumeric string', () => {
            const subdomain = builder.generateSubdomain();
            assert.ok(/^[a-z0-9]+$/.test(subdomain));
            assert.ok(subdomain.length <= 8);
            assert.ok(subdomain.length > 0);
        });

        it('should generate unique subdomains', () => {
            const subdomains = new Set<string>();
            for (let i = 0; i < 100; i++) {
                subdomains.add(builder.generateSubdomain());
            }
            // With 100 random 8-char strings, collisions are extremely unlikely
            assert.ok(subdomains.size > 90);
        });
    });

    describe('verifyAuthorization', () => {
        it('should return true when no authKey is configured', async () => {
            const builder = TunnelBuilder.instance;
            builder.server = { options: {}, oidcVerifier: null } as any;
            const result = await builder.verifyAuthorization({ requestHeaders: {} } as any);
            assert.equal(result, true);
        });

        it('should throw 401 when no authorization header present', async () => {
            const builder = TunnelBuilder.instance;
            builder.server = { options: { authKey: 'a'.repeat(32) }, oidcVerifier: null } as any;
            await assert.rejects(() => builder.verifyAuthorization({ requestHeaders: {} } as any), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 401);
                return true;
            });
        });

        it('should throw 401 for incorrect protocol prefix', async () => {
            const builder = TunnelBuilder.instance;
            builder.server = { options: { authKey: 'a'.repeat(32) }, oidcVerifier: null } as any;
            await assert.rejects(() => builder.verifyAuthorization({ requestHeaders: { authorization: 'Basic xyz' } } as any), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 401);
                return true;
            });
        });

        it('should reject Bearer token when OIDC is not configured', async () => {
            const builder = TunnelBuilder.instance;
            builder.server = { options: { authKey: 'a'.repeat(32) }, oidcVerifier: null } as any;
            await assert.rejects(() => builder.verifyAuthorization({ requestHeaders: { authorization: 'Bearer xyz' } } as any), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 401);
                return true;
            });
        });

        it('should reject TPoT-1 token when static key auth is not configured', async () => {
            const builder = TunnelBuilder.instance;
            builder.server = { options: {}, oidcVerifier: {} } as any;
            await assert.rejects(() => builder.verifyAuthorization({ requestHeaders: { authorization: 'TPoT-1 xyz' } } as any), (err: any) => {
                assert.ok(err instanceof HttpError);
                assert.equal(err.statusCode, 401);
                return true;
            });
        });
    });
});
