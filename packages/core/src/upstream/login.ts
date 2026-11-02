import { createServer } from 'node:http';
import { once } from 'node:events';

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

import type { Config } from '../config/schema.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { AuthStore, JackfieldOAuthProvider } from './oauth.js';

export interface LoginOptions {
    config: Config;
    upstreamId: string;
    logger: Logger;
    /** Print the authorization URL instead of serving a loopback callback. */
    manual?: boolean;
    /** How long to wait for the browser to come back. */
    timeoutMs?: number;
    print?: (line: string) => void;
}

/**
 * Logs in to one upstream, once, as the operator.
 *
 * The default is the loopback callback every command-line OAuth client uses:
 * a listener on the redirect URI's own host and port, which the browser
 * reaches after you consent. `manual` prints the URL and takes the code back
 * by hand, which is what you want on a headless box where the browser is on a
 * different machine.
 */
export async function login(options: LoginOptions): Promise<{ upstreamId: string; refreshable: boolean }> {
    const { config, upstreamId } = options;
    const print = options.print ?? ((line: string) => process.stdout.write(line + '\n'));

    const upstream = config.upstreams[upstreamId];
    if (!upstream) throw new Error(`no upstream named "${upstreamId}"`);
    if (upstream.transport !== 'http' && upstream.transport !== 'sse') {
        throw new Error(`"${upstreamId}" is a ${upstream.transport} upstream; OAuth applies to http and sse`);
    }
    if (!upstream.oauth) {
        throw new Error(`"${upstreamId}" has no oauth block in the configuration`);
    }

    const redirect = new URL(config.auth.redirectUrl);
    let resolveCode: ((code: string) => void) | undefined;
    let rejectCode: ((error: Error) => void) | undefined;
    const code = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    const provider = new JackfieldOAuthProvider({
        upstreamId,
        store: new AuthStore(config.auth.storeDir, options.logger),
        redirectUrl: config.auth.redirectUrl,
        ...(upstream.oauth.scope ? { scope: upstream.oauth.scope } : {}),
        ...(upstream.oauth.clientId ? { clientId: upstream.oauth.clientId } : {}),
        ...(upstream.oauth.clientSecret ? { clientSecret: upstream.oauth.clientSecret } : {}),
        ...(upstream.oauth.clientName ? { clientName: upstream.oauth.clientName } : {}),
        logger: options.logger,
        onAuthorizationUrl: url => {
            print('');
            print('Open this in a browser and approve the request:');
            print('');
            print(`  ${url.toString()}`);
            print('');
            if (options.manual) print(`Then paste the "code" from the URL you land on, or that whole URL.`);
            else print(`Waiting for the browser to come back to ${config.auth.redirectUrl} …`);
        }
    });

    const server = options.manual
        ? undefined
        : createServer((req, res) => {
              const incoming = new URL(req.url ?? '/', `http://${req.headers.host ?? redirect.host}`);
              if (incoming.pathname !== redirect.pathname) {
                  res.writeHead(404).end('not found');
                  return;
              }
              const received = incoming.searchParams.get('code');
              const failure = incoming.searchParams.get('error');
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(
                  received
                      ? '<!DOCTYPE html><meta charset="utf-8"><title>Done</title><body style="font:15px system-ui;padding:2rem"><h1>Logged in</h1><p>You can close this tab and go back to the terminal.</p>'
                      : `<!DOCTYPE html><meta charset="utf-8"><title>Failed</title><body style="font:15px system-ui;padding:2rem"><h1>Authorization failed</h1><p>${failure ?? 'no code came back'}</p>`
              );
              if (received) resolveCode?.(received);
              else rejectCode?.(new Error(failure ?? 'the authorization server returned no code'));
          });

    if (server) {
        server.listen(Number(redirect.port || 80), redirect.hostname);
        await once(server, 'listening');
    }

    const stop = () => {
        if (!server) return;
        server.closeAllConnections();
        server.close();
    };

    try {
        const started = await auth(provider, {
            serverUrl: upstream.url,
            ...(upstream.oauth.scope ? { scope: upstream.oauth.scope } : {})
        });

        if (started === 'AUTHORIZED') {
            print(`Already authorized for "${upstreamId}".`);
            const tokens = await provider.tokens();
            return { upstreamId, refreshable: Boolean(tokens?.refresh_token) };
        }

        const authorizationCode = options.manual ? await readCodeFromStdin(print) : await withTimeout(code, options.timeoutMs ?? 300_000);

        const finished = await auth(provider, {
            serverUrl: upstream.url,
            authorizationCode,
            ...(upstream.oauth.scope ? { scope: upstream.oauth.scope } : {})
        });
        if (finished !== 'AUTHORIZED') throw new Error(`the authorization server answered "${finished}"`);

        const tokens = await provider.tokens();
        return { upstreamId, refreshable: Boolean(tokens?.refresh_token) };
    } catch (error) {
        throw new Error(`could not log in to "${upstreamId}": ${errorMessage(error)}`);
    } finally {
        stop();
    }
}

export async function logout(config: Config, upstreamId: string, logger: Logger): Promise<void> {
    await new AuthStore(config.auth.storeDir, logger).forget(upstreamId);
}

export async function authStatus(config: Config, logger: Logger): Promise<{ id: string; loggedIn: boolean; hasRefresh: boolean }[]> {
    const store = new AuthStore(config.auth.storeDir, logger);
    const out: { id: string; loggedIn: boolean; hasRefresh: boolean }[] = [];
    for (const [id, upstream] of Object.entries(config.upstreams)) {
        if ((upstream.transport !== 'http' && upstream.transport !== 'sse') || !upstream.oauth) continue;
        const status = await store.status(id);
        out.push({ id, loggedIn: status.loggedIn, hasRefresh: status.hasRefresh });
    }
    return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`gave up after ${Math.round(ms / 1000)} s`)), ms);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Takes a pasted code, or the whole redirect URL and digs the code out of it. */
async function readCodeFromStdin(print: (line: string) => void): Promise<string> {
    print('Paste it here and press enter:');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const typed = Buffer.concat(chunks).toString('utf8').trim();
    if (!typed) throw new Error('nothing was pasted');
    if (typed.includes('://') || typed.includes('code=')) {
        const url = new URL(typed.includes('://') ? typed : `http://x/?${typed}`);
        const found = url.searchParams.get('code');
        if (found) return found;
    }
    return typed;
}
