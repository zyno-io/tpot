# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-03-09
### General
- Migrated to TypeScript
- Migrated to Yarn 4 workspaces monorepo
- Added CI pipeline
- Added end-to-end test suite (24 tests)
- Added Docker multi-stage build

### Server
- OIDC authentication support (JWT verification via JWKS discovery)
- Static key and OIDC auth are mutually exclusive (enforced at startup)
- Support for multiple base domains (comma-separated `DOMAIN` env var)
- Required claims enforcement for OIDC tokens (`OIDC_REQUIRED_CLAIMS`)
- Force `Connection: close` on tunneled requests to prevent cross-subdomain connection reuse through reverse proxies (removes need for `nginx.ingress.kubernetes.io/connection-proxy-header` annotation)
- Fixed HTTP header parsing: colon without space, split `\r\n\r\n` across TCP segments, header length bypass, null-safe Connection/Upgrade handling, multi-value Connection headers
- Fixed `Content-Length` to use `Buffer.byteLength` for error responses
- Fixed IPv6 remote address handling in tunnel conversations
- Added unit tests (35 tests)

### Client
- `tpot config` command to save options to `~/.tpot/config.json`
- OIDC authentication support (Authorization Code + PKCE with browser-based login)
- Token caching with automatic refresh (`~/.tpot/tokens.json`)
- OIDC tokens are only sent over HTTPS connections
- State parameter verification on OIDC callback to prevent login CSRF
- HTML-escaped error descriptions in OIDC callback to prevent XSS
- Static key and OIDC auth are mutually exclusive (enforced on both client and server)
- Fixed HTTP header split across TCP segments in conversation handling
- Added unit tests (32 tests)

## [0.2.0] - 2020-04-17
### Server
- Customizable port number
- Listen on all interfaces, not just localhost
- A readme and changelog!
- Consistent acronym/name casing (the "o" in TPoT)
- Pass just the assigned subdomain to the client, rather than the full domain

### Client
- Support for disabling HTTP host rewrite
- Output error messages when failing to connect
- A readme and changelog!
- Cleaner relationship between CLI command and Client class
- Cleaned up URL building for server & target
- Derive session URL from server URL
- Consistent acronym/name casing (the "o" in TPoT)

## [0.1.0] - 2020-04-16
### Added
- The entire project :)
