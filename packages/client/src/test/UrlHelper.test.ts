import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UrlHelper } from '../UrlHelper';

describe('UrlHelper', () => {
    const helper = new UrlHelper();

    describe('extractUrlComponents', () => {
        it('should parse a simple hostname', () => {
            const result = helper.extractUrlComponents('example.com');
            assert.equal(result.protocol, 'http');
            assert.equal(result.host, 'example.com');
            assert.equal(result.port, 80);
            assert.equal(result.hostWithPort, 'example.com');
        });

        it('should parse hostname with port', () => {
            const result = helper.extractUrlComponents('example.com:8080');
            assert.equal(result.protocol, 'http');
            assert.equal(result.host, 'example.com');
            assert.equal(result.port, 8080);
            assert.equal(result.hostWithPort, 'example.com:8080');
        });

        it('should parse http URL', () => {
            const result = helper.extractUrlComponents('http://example.com');
            assert.equal(result.protocol, 'http');
            assert.equal(result.host, 'example.com');
            assert.equal(result.port, 80);
        });

        it('should parse https URL', () => {
            const result = helper.extractUrlComponents('https://example.com');
            assert.equal(result.protocol, 'https');
            assert.equal(result.host, 'example.com');
            assert.equal(result.port, 443);
        });

        it('should parse https URL with port', () => {
            const result = helper.extractUrlComponents('https://example.com:9090');
            assert.equal(result.protocol, 'https');
            assert.equal(result.host, 'example.com');
            assert.equal(result.port, 9090);
            assert.equal(result.hostWithPort, 'example.com:9090');
        });

        it('should handle trailing slash', () => {
            const result = helper.extractUrlComponents('example.com/');
            assert.equal(result.host, 'example.com');
        });

        it('should throw on invalid URL', () => {
            assert.throws(() => helper.extractUrlComponents('not a url!!'), /the URL is invalid/);
        });
    });

    describe('generateQueryAppend', () => {
        it('should return empty string for empty query', () => {
            assert.equal(helper.generateQueryAppend({}), '');
        });

        it('should strip undefined values', () => {
            assert.equal(helper.generateQueryAppend({ foo: undefined }), '');
        });

        it('should generate query string', () => {
            assert.equal(helper.generateQueryAppend({ subdomain: 'test' }), '?subdomain=test');
        });
    });

    describe('getServerConnectionInfo', () => {
        it('should build ws URL for http server', () => {
            const info = helper.getServerConnectionInfo({
                server: { protocol: 'http', host: 'example.com', port: 80, hostWithPort: 'example.com' }
            });
            assert.equal(info.url, 'ws://example.com/create-tpot');
            assert.deepEqual(info.headers, {});
        });

        it('should build wss URL for https server', () => {
            const info = helper.getServerConnectionInfo({
                server: { protocol: 'https', host: 'example.com', port: 443, hostWithPort: 'example.com' }
            });
            assert.equal(info.url, 'wss://example.com/create-tpot');
        });

        it('should include subdomain in query', () => {
            const info = helper.getServerConnectionInfo({
                server: { protocol: 'http', host: 'example.com', port: 80, hostWithPort: 'example.com' },
                subdomain: 'myapp'
            });
            assert.equal(info.url, 'ws://example.com/create-tpot?subdomain=myapp');
        });

        it('should include Authorization header when authKey provided', () => {
            const info = helper.getServerConnectionInfo({
                server: { protocol: 'http', host: 'example.com', port: 80, hostWithPort: 'example.com' },
                authKey: 'mysecretkey1234567890abcdefghijklmnop'
            });
            assert.ok(info.headers.Authorization);
            assert.ok(info.headers.Authorization.startsWith('TPoT-1 '));
        });

        it('should include Bearer token when oidcToken provided', () => {
            const info = helper.getServerConnectionInfo({
                server: { protocol: 'http', host: 'example.com', port: 80, hostWithPort: 'example.com' },
                oidcToken: 'my.jwt.token'
            });
            assert.equal(info.headers.Authorization, 'Bearer my.jwt.token');
        });

        it('should prefer oidcToken over authKey', () => {
            const info = helper.getServerConnectionInfo({
                server: { protocol: 'http', host: 'example.com', port: 80, hostWithPort: 'example.com' },
                authKey: 'mysecretkey1234567890abcdefghijklmnop',
                oidcToken: 'my.jwt.token'
            });
            assert.equal(info.headers.Authorization, 'Bearer my.jwt.token');
        });
    });

    describe('getAuthString', () => {
        it('should return a TPoT-1 prefixed base64 string', () => {
            const auth = helper.getAuthString('testkey');
            assert.ok(auth.startsWith('TPoT-1 '));
            const encoded = auth.substring(7);
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            const parts = decoded.split('\n');
            assert.equal(parts.length, 3);
            // parts[0] is nonce, parts[1] is timestamp, parts[2] is token
            assert.ok(/^[0-9]+$/.test(parts[1]));
        });
    });
});
