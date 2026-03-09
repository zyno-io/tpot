import crypto from 'crypto';

export interface UrlComponents {
    protocol: string;
    host: string;
    port: number;
    hostWithPort: string;
}

export interface ConnectionInfo {
    url: string;
    headers: Record<string, string>;
}

export interface ClientOptions {
    server: string | UrlComponents;
    authKey?: string;
    subdomain?: string;
    target: string | UrlComponents;
    rewriteHost?: string | false;
}

export class UrlHelper {
    extractUrlComponents(url: string): UrlComponents {
        const urlMatches = url.match(/^((https?):\/\/)?([a-z0-9.]+)(:([0-9]+))?\/?$/i);
        if (!urlMatches)
            throw new Error('the URL is invalid');

        const protocol = urlMatches[2] || 'http';
        const host = urlMatches[3];
        const port = urlMatches[5] ? parseInt(urlMatches[5]) : (protocol === 'https' ? 443 : 80);
        const hostWithPort = urlMatches[3] + (urlMatches[4] || '');
        return { protocol, host, port, hostWithPort };
    }

    getServerConnectionInfo(options: { server: UrlComponents; subdomain?: string; authKey?: string; oidcToken?: string }): ConnectionInfo {
        const queryAppend = this.generateQueryAppend({
            subdomain: options.subdomain
        });

        const wsProtocol = options.server.protocol === 'https' ? 'wss' : 'ws';
        const url = wsProtocol + '://' + options.server.hostWithPort + '/create-tpot' + queryAppend;

        const headers: Record<string, string> = {};
        if (options.oidcToken) headers.Authorization = 'Bearer ' + options.oidcToken;
        else if (options.authKey) headers.Authorization = this.getAuthString(options.authKey);

        return { url, headers };
    }

    generateQueryAppend(query: Record<string, string | undefined>): string {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) params.set(key, value);
        }

        const str = params.toString();
        return str ? '?' + str : '';
    }

    getAuthString(key: string): string {
        const ts = Date.now();
        const nonce = crypto.randomBytes(32).toString('base64');
        const saltString = nonce + '\n' + ts;
        const salt = crypto.createHash('md5').update(saltString).digest().toString('hex');
        const token = crypto.pbkdf2Sync(key, salt, 32768, 128, 'sha256').toString('base64');
        const authString = saltString + '\n' + token;
        const result = Buffer.from(authString).toString('base64');
        return 'TPoT-1 ' + result;
    }
}
