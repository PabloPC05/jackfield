import { createServer, type Server as NodeServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

import { toWebRequest, writeWebResponse } from '../dist/index.js';

export interface FakeOAuthUpstream {
    /** The MCP endpoint, which refuses anything without a live access token. */
    mcpUrl: string;
    /** Base URL of the authorization server, same origin here. */
    issuer: string;
    close(): Promise<void>;
    /** Calls seen, for assertions. */
    stats: { registrations: number; authorizations: number; tokenGrants: number; refreshes: number; rejected401: number };
    /** Makes every issued access token look expired, to force a refresh. */
    expireAccessTokens(): void;
    lastScope?: string;
}

/**
 * An authorization server and a protected MCP server, in one process.
 *
 * Enough of RFC 8414, RFC 7591, RFC 9728 and PKCE for the SDK's client to walk
 * the whole flow: discover, register, authorize, exchange, call, refresh.
 */
export async function startOAuthUpstream(name: string): Promise<FakeOAuthUpstream> {
    const stats = { registrations: 0, authorizations: 0, tokenGrants: 0, refreshes: 0, rejected401: 0 };
    const clients = new Map<string, { secret?: string; redirectUris: string[] }>();
    const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
    const accessTokens = new Map<string, { expiresAt: number }>();
    const refreshTokens = new Map<string, { clientId: string }>();
    const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
    let result: FakeOAuthUpstream;

    const build = () => {
        const server = new McpServer({ name, version: '1.0.0' });
        server.registerTool(
            'whoami',
            { description: 'Say who the token belongs to', inputSchema: {} },
            async () => ({ content: [{ type: 'text', text: `${name} says hello` }] })
        );
        return server;
    };

    const http: NodeServer = createServer((req, res) => {
        void (async () => {
            const request = toWebRequest(req);
            const url = new URL(request.url);
            const origin = `http://127.0.0.1:${port}`;

            // --- RFC 9728: where the resource says its authorization server is
            if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
                await writeWebResponse(
                    Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] }),
                    res
                );
                return;
            }

            // --- RFC 8414: the authorization server's own metadata
            if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
                await writeWebResponse(
                    Response.json({
                        issuer: origin,
                        authorization_endpoint: `${origin}/authorize`,
                        token_endpoint: `${origin}/token`,
                        registration_endpoint: `${origin}/register`,
                        response_types_supported: ['code'],
                        grant_types_supported: ['authorization_code', 'refresh_token'],
                        code_challenge_methods_supported: ['S256'],
                        token_endpoint_auth_methods_supported: ['none', 'client_secret_post']
                    }),
                    res
                );
                return;
            }

            // --- RFC 7591: dynamic client registration
            if (url.pathname === '/register' && request.method === 'POST') {
                stats.registrations += 1;
                const body = (await request.json()) as { redirect_uris?: string[] };
                const clientId = `client-${randomUUID()}`;
                clients.set(clientId, { redirectUris: body.redirect_uris ?? [] });
                await writeWebResponse(
                    Response.json({ client_id: clientId, redirect_uris: body.redirect_uris ?? [] }, { status: 201 }),
                    res
                );
                return;
            }

            // --- the consent screen, minus the human: it redirects straight back
            if (url.pathname === '/authorize') {
                stats.authorizations += 1;
                const clientId = url.searchParams.get('client_id') ?? '';
                const redirectUri = url.searchParams.get('redirect_uri') ?? '';
                const challenge = url.searchParams.get('code_challenge') ?? '';
                const state = url.searchParams.get('state');
                result.lastScope = url.searchParams.get('scope') ?? undefined;

                if (!clients.has(clientId) || !challenge) {
                    await writeWebResponse(new Response('bad authorize request', { status: 400 }), res);
                    return;
                }
                const code = randomBytes(16).toString('hex');
                codes.set(code, { clientId, challenge, redirectUri });

                const back = new URL(redirectUri);
                back.searchParams.set('code', code);
                if (state) back.searchParams.set('state', state);
                await writeWebResponse(new Response(null, { status: 302, headers: { Location: back.toString() } }), res);
                return;
            }

            // --- token endpoint: authorization_code with PKCE, and refresh_token
            if (url.pathname === '/token' && request.method === 'POST') {
                const form = new URLSearchParams(await request.text());
                const grant = form.get('grant_type');

                if (grant === 'refresh_token') {
                    const given = form.get('refresh_token') ?? '';
                    if (!refreshTokens.has(given)) {
                        await writeWebResponse(Response.json({ error: 'invalid_grant' }, { status: 400 }), res);
                        return;
                    }
                    stats.refreshes += 1;
                    await writeWebResponse(Response.json(issue(refreshTokens.get(given)!.clientId)), res);
                    return;
                }

                const code = form.get('code') ?? '';
                const entry = codes.get(code);
                const verifier = form.get('code_verifier') ?? '';
                const expected = createHash('sha256').update(verifier).digest('base64url');

                if (!entry || entry.challenge !== expected) {
                    await writeWebResponse(Response.json({ error: 'invalid_grant' }, { status: 400 }), res);
                    return;
                }
                codes.delete(code);
                stats.tokenGrants += 1;
                await writeWebResponse(Response.json(issue(entry.clientId)), res);
                return;
            }

            // --- the protected MCP endpoint
            if (url.pathname === '/mcp') {
                const header = request.headers.get('authorization') ?? '';
                const token = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1];
                const live = token ? accessTokens.get(token) : undefined;

                if (!live || live.expiresAt <= Date.now()) {
                    stats.rejected401 += 1;
                    await writeWebResponse(
                        new Response(JSON.stringify({ error: 'invalid_token' }), {
                            status: 401,
                            headers: {
                                'Content-Type': 'application/json',
                                'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
                            }
                        }),
                        res
                    );
                    return;
                }

                const sessionId = request.headers.get('mcp-session-id');
                const existing = sessionId ? transports.get(sessionId) : undefined;
                if (existing) {
                    await writeWebResponse(await existing.handleRequest(request), res);
                    return;
                }
                const transport = new WebStandardStreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: id => transports.set(id, transport),
                    onsessionclosed: id => transports.delete(id)
                });
                await build().connect(transport);
                await writeWebResponse(await transport.handleRequest(request), res);
                return;
            }

            await writeWebResponse(new Response('not found', { status: 404 }), res);
        })().catch(async error => {
            await writeWebResponse(new Response(String(error), { status: 500 }), res).catch(() => undefined);
        });
    });

    function issue(clientId: string) {
        const access = randomBytes(24).toString('hex');
        const refresh = randomBytes(24).toString('hex');
        accessTokens.set(access, { expiresAt: Date.now() + 3600_000 });
        refreshTokens.set(refresh, { clientId });
        return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh };
    }

    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    result = {
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        issuer: `http://127.0.0.1:${port}`,
        stats,
        expireAccessTokens: () => {
            for (const entry of accessTokens.values()) entry.expiresAt = 0;
        },
        close: async () => {
            for (const transport of transports.values()) await transport.close().catch(() => undefined);
            http.closeAllConnections();
            http.close();
            await once(http, 'close').catch(() => undefined);
        }
    };
    return result;
}
