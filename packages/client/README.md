# tpot

The TPoT client. Connects to a TPoT server and tunnels local HTTP traffic through it.

## Installation

```
npm install -g tpot
```

## Usage

```
tpot [options] http <target>
```

### Options

| Flag | Description |
|------|-------------|
| `-t, --tpot-server <server>` | TPoT server URL |
| `-k, --auth-key <key>` | Authentication key |
| `-s, --subdomain <subdomain>` | Request a specific subdomain |
| `-h, --http-host <host>` | Override Host header rewrite |
| `-nh, --no-host-rewrite` | Disable Host header rewrite |
| `-d, --debug` | Enable debug logging |
| `--oidc-issuer <url>` | OIDC issuer URL |
| `--oidc-client-id <id>` | OIDC client ID |
| `--oidc-scopes <scopes>` | OIDC scopes (default: `openid`) |
| `--oidc-callback-port <port>` | Fixed port for OIDC callback (default: random) |

See the full [Authentication Guide](../../docs/authentication.md) for details on static key and OIDC setup, including provider configuration.

## Example

```
$ tpot -t tpot.example.com http localhost:8080
tpot connected
https://nz2v6g7o.tpot.example.com
```

Traffic to `https://nz2v6g7o.tpot.example.com/any/path` is now tunneled to `http://localhost:8080/any/path`.

CTRL+C to quit.

## Configuration File

To avoid specifying the server and auth key every time, use `tpot config`:

```
tpot config --tpot-server https://tpot.example.com --auth-key your-auth-key-here
tpot config --subdomain my-nickname
```

Each invocation merges the provided options into `~/.tpot/config.json`. You can also edit the file directly:

```json
{
  "tpotServer": "https://tpot.example.com",
  "authKey": "your-auth-key-here",
  "subdomain": "my-nickname"
}
```

CLI flags override config file values.
