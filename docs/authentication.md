# Authentication

TPoT supports two authentication methods. Configure one or the other — they cannot be used together.

## Static Key

A shared secret between server and client.

### Server

Set the `AUTH_KEY` environment variable (minimum 32 characters):

```
AUTH_KEY="your-secret-key-at-least-32-characters-long"
```

### Client

Pass the key via CLI flag or config file:

```
tpot -k your-secret-key -t yourdomain.com http localhost:8080
```

Or in `~/.tpot/config.json`:

```json
{
  "tpotServer": "https://tpot.example.com",
  "authKey": "your-secret-key-at-least-32-characters-long"
}
```

---

## OIDC (OpenID Connect)

OIDC lets you authenticate tunnel clients using your existing identity provider. The server verifies JWT access tokens via JWKS; the client handles the browser-based login flow using Authorization Code + PKCE.

### Server Configuration

| Environment Variable | Required | Description |
|---|---|---|
| `OIDC_DISCOVERY_URL` | Yes | Base URL for OIDC discovery (appends `/.well-known/openid-configuration`). Must be HTTPS. |
| `OIDC_ISSUER` | No | Override expected `iss` claim in the JWT. Defaults to the `issuer` from the discovery document. Useful when the token issuer differs from the discovery URL (e.g. Microsoft Entra ID v1 tokens). |
| `OIDC_CLIENT_ID` | Recommended | OIDC client ID. Advertised to clients via `/tpot-auth` so they don't need to configure it manually. |
| `OIDC_SCOPES` | No | OIDC scopes. Advertised to clients via `/tpot-auth`. |
| `OIDC_AUDIENCE` | Recommended | Expected `aud` claim in the JWT. **Strongly recommended** — without it, any JWT from the issuer is accepted. |
| `OIDC_REQUIRED_CLAIMS` | No | Comma-separated `key=value` pairs that must match in the JWT. |

Example:

```
OIDC_DISCOVERY_URL="https://accounts.google.com"
OIDC_CLIENT_ID="YOUR_CLIENT_ID"
OIDC_AUDIENCE="YOUR_CLIENT_ID"
```

When `OIDC_CLIENT_ID` is set, the server exposes a `GET /tpot-auth` endpoint that returns the OIDC configuration. Clients automatically fetch this before connecting, so users only need to specify the server URL — no manual OIDC configuration required on the client side.

### Client Configuration

When the server has `OIDC_CLIENT_ID` configured, the client automatically discovers OIDC settings — no manual OIDC configuration needed:

```
tpot -t yourdomain.com http localhost:8080
```

On first use, a browser window opens for login. Tokens are cached in `~/.tpot/tokens.json` and refreshed automatically.

The following flags are available to override server-provided values:

| Flag | Description |
|------|-------------|
| `--oidc-issuer <url>` | Override OIDC issuer URL |
| `--oidc-client-id <id>` | Override OIDC client ID |
| `--oidc-scopes <scopes>` | Override OIDC scopes |
| `--oidc-callback-port <port>` | Fixed port for OIDC callback (default: random) |

> **Note:** The client requires an HTTPS server URL when using OIDC to prevent leaking Bearer tokens over cleartext.

---

## Provider Setup

### Microsoft Entra ID (Azure AD / M365)

1. Go to [Azure Portal](https://portal.azure.com) > **App registrations** > **New registration**
2. Set **Name** to something like "TPoT"
3. Under **Redirect URIs**, select **Public client/native** and add `http://127.0.0.1/callback`
4. Click **Register**
5. Note the **Application (client) ID** and **Directory (tenant) ID**
6. Under **Authentication**, ensure **Allow public client flows** is set to **Yes**
7. Go to **Expose an API**, click **Set** next to Application ID URI (accept the default `api://YOUR_CLIENT_ID`), then **Add a scope**: name it `access`, enable for admins and users, and save

> **Important:** Step 7 is required. Without a custom scope, Entra ID issues Microsoft Graph tokens that use a non-standard signature and cannot be verified by third-party servers. Use `--oidc-debug` on the client to inspect the token if you run into issues.

Server env:
```
OIDC_DISCOVERY_URL="https://login.microsoftonline.com/YOUR_TENANT_ID/v2.0"
OIDC_ISSUER="https://sts.windows.net/YOUR_TENANT_ID/"
OIDC_CLIENT_ID="YOUR_CLIENT_ID"
OIDC_SCOPES="openid api://YOUR_CLIENT_ID/access"
OIDC_AUDIENCE="api://YOUR_CLIENT_ID"
```

Client (OIDC params auto-discovered from server):
```
tpot -t yourdomain.com http localhost:8080
```

### Google

1. Go to [Google Cloud Console](https://console.cloud.google.com) > **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Desktop app** as the application type
4. Note the **Client ID**
5. No client secret is needed (PKCE is used)

Server env:
```
OIDC_DISCOVERY_URL="https://accounts.google.com"
OIDC_CLIENT_ID="YOUR_CLIENT_ID"
OIDC_AUDIENCE="YOUR_CLIENT_ID"
OIDC_SCOPES="openid email"
```

Client (OIDC params auto-discovered from server):
```
tpot -t yourdomain.com http localhost:8080
```

### Auth0

1. Go to your Auth0 dashboard > **Applications** > **Create Application**
2. Select **Native** as the application type
3. Under **Settings** > **Allowed Callback URLs**, add `http://127.0.0.1/callback`
4. Note the **Client ID** and your **Domain**

Server env:
```
OIDC_DISCOVERY_URL="https://YOUR_DOMAIN.auth0.com/"
OIDC_CLIENT_ID="YOUR_CLIENT_ID"
OIDC_AUDIENCE="YOUR_CLIENT_ID"
```

Client (OIDC params auto-discovered from server):
```
tpot -t yourdomain.com http localhost:8080
```

### Other Providers

Any OIDC-compliant provider that supports Authorization Code + PKCE will work. You need:

1. A public client (no client secret) with `http://127.0.0.1/callback` as a redirect URI
2. The discovery URL (must serve `/.well-known/openid-configuration`)
3. The client ID

> **Note:** TPoT uses `127.0.0.1` (not `localhost`) for the OAuth callback, per [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3). The port is assigned dynamically; compliant providers ignore the port for loopback redirect URIs. Register the redirect URI as `http://127.0.0.1/callback` without a port.
