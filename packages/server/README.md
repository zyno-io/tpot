# @zyno-io/tpot-server

The TPoT server component. Receives tunnel connections from clients and proxies HTTP traffic to them via WebSocket.

## Running with Docker

The container is published to Docker Hub as `zyno-io/tpot-server`.

```
docker run -d --name tpot-server -p 3000:3000 \
  -e DOMAIN=yourdomain.com \
  zyno-io/tpot-server
```

## Configuration

Provide these as environment variables or in a `.env` file in the project root.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOMAIN` | Yes | — | Comma-separated base domain(s) for tunnel routing. |
| `AUTH_KEY` | No | — | Static authentication key (minimum 32 characters). |
| `OIDC_DISCOVERY_URL` | No | — | OIDC discovery base URL (must be HTTPS). Enables OIDC JWT verification. |
| `OIDC_ISSUER` | No | — | Override expected `iss` claim. Defaults to the `issuer` from the discovery document. |
| `OIDC_CLIENT_ID` | No | — | OIDC client ID. Advertised to clients so they don't need to specify it. |
| `OIDC_SCOPES` | No | — | OIDC scopes. Advertised to clients. |
| `OIDC_AUDIENCE` | No | — | Expected `aud` claim in the JWT. Strongly recommended when using OIDC. |
| `OIDC_REQUIRED_CLAIMS` | No | — | Comma-separated `key=value` pairs that must match in the JWT. |
| `PORT` | No | `3000` | Port the server listens on. |

See the full [Authentication Guide](../../docs/authentication.md) for details on static key and OIDC setup.

## Running without Docker

```
yarn workspace @zyno-io/tpot-server build
cd packages/server
DOMAIN=yourdomain.com node dist/index.js
```

## DNS Setup

You'll need a wildcard DNS record pointing to your server:

```
*.yourdomain.com  →  your-server-ip
yourdomain.com    →  your-server-ip
```
