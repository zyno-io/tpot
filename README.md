# TPoT (Transport Packets over Tunnels)

A simple, self-hosted HTTP tunneling proxy powered by WebSockets. Optionally authenticated. No additional ports required. Designed to be used with a reverse proxy for TLS.

Think ngrok, but open source and fully under your control.

---

## Quick Start

TPoT has two components: a **server** you host, and a **client** that runs on your machine.

### 1. Run the server

```
docker run -d --name tpot-server -p 3000:3000 -e DOMAIN=yourdomain.com ghcr.io/zyno-io/tpot/server
```

See [Server Documentation](packages/server/README.md) for full configuration options.

### 2. Install and use the client

```
npm install -g tpot
tpot -t yourdomain.com http localhost:8080
```

See [Client Documentation](packages/client/README.md) for full usage and configuration.

### 3. Done

Traffic to `https://<assigned-subdomain>.yourdomain.com` is now tunneled to `http://localhost:8080`.

---

## How does this work?

WebSockets.

The client connects to the server over a WebSocket, and either requests a specific subdomain or gets one randomly assigned. When the server receives a request for your subdomain, it opens a new "conversation" by assigning a conversation ID and sending a message to your client with the ID, conversation type (HTTP for now; raw data in the future), and the sender's IP and port. The server then forwards all raw data over the WebSocket, prefixed with the conversation ID. The client does the same in reverse.

For HTTP conversations, the client analyzes inbound traffic to rewrite the HTTP Host header. This is enabled by default but can be disabled with `--no-host-rewrite`.

## Is this secure?

That depends on your setup.

If you expose your server over HTTPS, then all communication between the client and server is secure, and all communication between the remote user and the server is secure. Don't confuse this with end-to-end encryption: the server still has to decrypt the data to know which tunnel to send it through. As long as you trust that your server is secure, then you can trust that communication from the remote user to your TPoT client is secure.

As for the security from your TPoT client to your target... that's up to you.

## Why not ngrok, localtunnel, etc?

Most importantly: it's open source, and fully under your control.

We ran into the upper limit of ngrok's per-minute connection limit, and didn't like that the paid plans still felt limited.

localtunnel seemed decent, but it opened random ports to establish connections, which wasn't compatible with running the server as a simple deployment on our Kubernetes cluster.

TPoT's server needs nothing more than a single port. It can run on a dedicated cloud server or as a container in a Kubernetes deployment behind an nginx ingress controller. All traffic for both clients and remote users is routed through that single port.

## Authentication

TPoT supports **static key** or **OIDC** authentication (one or the other, not both). Quick examples:

```
# Static key
docker run -e DOMAIN=yourdomain.com -e AUTH_KEY=your-secret-key ... zyno-io/tpot-server
tpot -k your-secret-key -t yourdomain.com http localhost:8080

# OIDC (client auto-discovers OIDC params from server)
docker run -e DOMAIN=yourdomain.com -e OIDC_DISCOVERY_URL=https://login.microsoftonline.com/TENANT/v2.0 -e OIDC_CLIENT_ID=CLIENT_ID -e OIDC_AUDIENCE=CLIENT_ID ... zyno-io/tpot-server
tpot -t yourdomain.com http localhost:8080
```

See the full [Authentication Guide](docs/authentication.md) for server/client configuration, provider setup (Microsoft Entra ID, Google, Auth0), and detailed options.

---

## Why does this need a reverse proxy for TLS?

Our setup runs the TPoT server as a Docker container in a Kubernetes cluster, behind an nginx ingress controller that handles TLS offloading. It just makes sense for us.

If you need TLS and don't have a reverse proxy, it's easy enough to set up nginx in front of TPoT. Need help? Open an issue.

---

## Development

```
yarn install
yarn build
yarn test
```

This is a Yarn workspaces monorepo with two packages:

| Package | Path | Purpose |
|---------|------|---------|
| `@zyno-io/tpot-server` | `packages/server` | Server (Docker image) |
| `tpot` | `packages/client` | Client (npm package) |

## License

MIT
