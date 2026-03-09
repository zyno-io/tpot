import fs from 'fs';
import path from 'path';

export interface CachedTokens {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
}

type TokenStore = Record<string, CachedTokens>;

const TOKEN_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tpot');
const TOKEN_FILE = path.join(TOKEN_DIR, 'tokens.json');
const EXPIRY_BUFFER_MS = 60_000;

export class TokenCache {
    private store: TokenStore = {};

    constructor() {
        try {
            const data = fs.readFileSync(TOKEN_FILE, 'utf8');
            this.store = JSON.parse(data);
        } catch {
            this.store = {};
        }
    }

    static cacheKey(issuer: string, clientId: string, scopes?: string): string {
        return issuer + '\n' + clientId + '\n' + (scopes || 'openid');
    }

    get(key: string): CachedTokens | null {
        const entry = this.store[key];
        if (!entry) return null;
        if (Date.now() >= entry.expiresAt - EXPIRY_BUFFER_MS) return null;
        return entry;
    }

    getExpired(key: string): CachedTokens | null {
        return this.store[key] || null;
    }

    set(key: string, tokens: CachedTokens): void {
        this.store[key] = tokens;
        this.save();
    }

    private save(): void {
        fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    }
}
