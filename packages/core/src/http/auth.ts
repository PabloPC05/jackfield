import { timingSafeEqual } from 'node:crypto';

import type { Config } from '../config/schema.js';

/**
 * Who is calling.
 *
 * Keys are compared in constant time and never logged. A client may also be
 * identified by a key in the URL path, because at least one widely used agent
 * cannot send an Authorization header — that is a client limitation a gateway
 * has to absorb, and absorbing it means the path is a secret and no log line
 * may contain it.
 */
export interface Principal {
    clientId: string;
    /** How the key arrived. `path` means the URL itself is a secret. */
    via: 'bearer' | 'path' | 'public';
}

export class KeyRegistry {
    private readonly byKey = new Map<string, string>();
    private readonly pathKeys = new Map<string, string>();
    private readonly publicClients = new Set<string>();

    constructor(config: Config) {
        for (const [id, client] of Object.entries(config.clients)) {
            if (!client.enabled) continue;
            if (client.public) this.publicClients.add(id);
            for (const key of [client.key, ...(client.altKeys ?? [])]) {
                if (!key) continue;
                this.byKey.set(key, id);
                if (client.keyInPath) this.pathKeys.set(key, id);
            }
        }
    }

    /** Constant-time lookup: every candidate is compared, so timing says nothing. */
    private lookup(table: Map<string, string>, candidate: string): string | undefined {
        let found: string | undefined;
        for (const [key, clientId] of table) {
            if (constantTimeEquals(key, candidate)) found = clientId;
        }
        return found;
    }

    fromBearer(header: string | null): Principal | undefined {
        if (!header) return undefined;
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        const token = match?.[1]?.trim();
        if (!token) return undefined;
        const clientId = this.lookup(this.byKey, token);
        return clientId ? { clientId, via: 'bearer' } : undefined;
    }

    fromPath(key: string): Principal | undefined {
        const clientId = this.lookup(this.pathKeys, key);
        return clientId ? { clientId, via: 'path' } : undefined;
    }

    isPublic(clientId: string): boolean {
        return this.publicClients.has(clientId);
    }

    get anyPublic(): boolean {
        return this.publicClients.size > 0;
    }

    /** The single public client, when exactly one exists: used for keyless setups. */
    get solePublicClient(): string | undefined {
        return this.publicClients.size === 1 ? [...this.publicClients][0] : undefined;
    }
}

export function constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) {
        // Still do the work, on equal-length buffers, so the answer takes the
        // same time whatever the lengths were.
        timingSafeEqual(left, left);
        return false;
    }
    return timingSafeEqual(left, right);
}
