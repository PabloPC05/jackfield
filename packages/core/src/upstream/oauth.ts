import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { errorMessage } from '../util/errors.js';
import { registerSecret, type Logger } from '../util/logger.js';

/**
 * OAuth towards an upstream, with the credentials held here and never by an
 * agent.
 *
 * Everything persistent lives in one file per upstream, mode 0600: the
 * registered client, the tokens, and the discovery state. The SDK does the
 * protocol — discovery, dynamic registration, PKCE, refresh — so this is a
 * store with a login flow bolted on, which is all it should be.
 *
 * Logging in is an operator action, not something an agent can trigger: a
 * gateway that could start an authorization flow on demand would be a gateway
 * an agent could point at an authorization server of its choosing.
 */

export interface StoredAuth {
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    codeVerifier?: string;
    discoveryState?: OAuthDiscoveryState;
    /** When the last successful login happened, for `jackfield check`. */
    loggedInAt?: number;
}

export class AuthStore {
    constructor(
        private readonly directory: string,
        private readonly logger: Logger
    ) {}

    private file(upstreamId: string): string {
        return join(resolve(this.directory), `${upstreamId.replace(/[^a-z0-9_-]/gi, '_')}.json`);
    }

    async read(upstreamId: string): Promise<StoredAuth> {
        try {
            const text = await readFile(this.file(upstreamId), 'utf8');
            const parsed = JSON.parse(text) as StoredAuth;
            registerSecret(parsed.tokens?.access_token);
            registerSecret(parsed.tokens?.refresh_token);
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.warn('could not read stored credentials', { upstream: upstreamId, error: errorMessage(error) });
            }
            return {};
        }
    }

    async write(upstreamId: string, update: Partial<StoredAuth>): Promise<void> {
        const path = this.file(upstreamId);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const current = await this.read(upstreamId);
        const next = { ...current, ...update };
        await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
        await chmod(path, 0o600).catch(() => undefined);
        registerSecret(next.tokens?.access_token);
        registerSecret(next.tokens?.refresh_token);
    }

    async forget(upstreamId: string): Promise<void> {
        await rm(this.file(upstreamId), { force: true });
    }

    async status(upstreamId: string): Promise<{ loggedIn: boolean; loggedInAt?: number; hasRefresh: boolean }> {
        const stored = await this.read(upstreamId);
        return {
            loggedIn: Boolean(stored.tokens?.access_token),
            ...(stored.loggedInAt ? { loggedInAt: stored.loggedInAt } : {}),
            hasRefresh: Boolean(stored.tokens?.refresh_token)
        };
    }
}

export interface ProviderOptions {
    upstreamId: string;
    store: AuthStore;
    redirectUrl: string;
    scope?: string;
    clientId?: string;
    clientSecret?: string;
    clientName?: string;
    logger: Logger;
    /**
     * Called when the flow needs a browser. During `serve` this throws, with a
     * message naming the command to run; `jackfield login` replaces it.
     */
    onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

export class JackfieldOAuthProvider implements OAuthClientProvider {
    private cache: StoredAuth | undefined;

    constructor(private readonly options: ProviderOptions) {}

    get redirectUrl(): string {
        return this.options.redirectUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: this.options.clientName ?? 'Jackfield gateway',
            redirect_uris: [this.options.redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: this.options.clientSecret ? 'client_secret_post' : 'none',
            ...(this.options.scope ? { scope: this.options.scope } : {})
        };
    }

    private async load(): Promise<StoredAuth> {
        this.cache ??= await this.options.store.read(this.options.upstreamId);
        return this.cache;
    }

    private async save(update: Partial<StoredAuth>): Promise<void> {
        this.cache = { ...(await this.load()), ...update };
        await this.options.store.write(this.options.upstreamId, update);
    }

    async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
        // A client id given in the config wins: it means the server does not
        // do dynamic registration and someone registered by hand.
        if (this.options.clientId) {
            return {
                client_id: this.options.clientId,
                ...(this.options.clientSecret ? { client_secret: this.options.clientSecret } : {})
            } as OAuthClientInformationMixed;
        }
        return (await this.load()).clientInformation;
    }

    async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
        await this.save({ clientInformation });
    }

    async tokens(): Promise<OAuthTokens | undefined> {
        return (await this.load()).tokens;
    }

    async saveTokens(tokens: OAuthTokens): Promise<void> {
        await this.save({ tokens, loggedInAt: Date.now() });
        this.options.logger.info('stored new credentials', {
            upstream: this.options.upstreamId,
            refreshable: Boolean(tokens.refresh_token)
        });
    }

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
        await this.save({ codeVerifier });
    }

    async codeVerifier(): Promise<string> {
        const stored = (await this.load()).codeVerifier;
        if (!stored) throw new Error(`no login in progress for ${this.options.upstreamId}`);
        return stored;
    }

    async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
        await this.save({ discoveryState });
    }

    async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
        return (await this.load()).discoveryState;
    }

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
        if (this.options.onAuthorizationUrl) {
            await this.options.onAuthorizationUrl(authorizationUrl);
            return;
        }
        // Running as a server: there is no browser, and starting a flow on
        // demand is not something an agent should be able to cause.
        throw new Error(
            `${this.options.upstreamId} needs you to log in: run "jackfield login ${this.options.upstreamId}". ` +
                `The gateway does not start authorization flows by itself.`
        );
    }

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
        if (scope === 'all') {
            this.cache = {};
            await this.options.store.forget(this.options.upstreamId);
            return;
        }
        const key = (
            {
                client: 'clientInformation',
                tokens: 'tokens',
                verifier: 'codeVerifier',
                discovery: 'discoveryState'
            } as const
        )[scope];
        await this.save({ [key]: undefined } as Partial<StoredAuth>);
    }
}
