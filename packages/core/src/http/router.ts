import { randomUUID } from 'node:crypto';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import type { Gateway } from '../gateway/gateway.js';
import type { GatewaySession } from '../gateway/session.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { KeyRegistry, type Principal } from './auth.js';

/** JSON-RPC error codes used in HTTP-level answers. */
const JSONRPC_INVALID_REQUEST = -32600;

interface LiveSession {
    id: string;
    clientId: string;
    session: GatewaySession;
    transport: WebStandardStreamableHTTPServerTransport;
    lastSeen: number;
}

export interface RouterOptions {
    gateway: Gateway;
    logger?: Logger;
}

/**
 * The HTTP face of the gateway, written against Web `Request`/`Response` so
 * the same handler runs behind a Node server, a container, or a serverless
 * function. Nothing in here knows which.
 *
 * Endpoints (under `server.basePath`):
 *
 * - `ALL  /mcp`              the gateway, client identified by `Authorization: Bearer <key>`
 * - `ALL  /k/<key>/mcp`      same, for clients that cannot send headers (`keyInPath: true`)
 * - `ALL  /c/<client>/mcp`   same, naming the client explicitly; the key must still match it
 * - `GET  /healthz`          liveness, no key
 */
export class Router {
    private readonly gateway: Gateway;
    private readonly logger: Logger;
    private readonly keys: KeyRegistry;
    private readonly sessions = new Map<string, LiveSession>();
    private sweeper?: ReturnType<typeof setInterval>;

    constructor(options: RouterOptions) {
        this.gateway = options.gateway;
        this.logger = (options.logger ?? options.gateway.logger).child({ part: 'http' });
        this.keys = new KeyRegistry(options.gateway.config);
        this.startSweeper();
    }

    get sessionCount(): number {
        return this.sessions.size;
    }

    private get basePath(): string {
        const base = this.gateway.config.server.basePath.replace(/\/+$/, '');
        return base.startsWith('/') || base === '' ? base : `/${base}`;
    }

    async handle(request: Request): Promise<Response> {
        const url = new URL(request.url);
        let path = url.pathname;
        const base = this.basePath;
        if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
        if (base && !url.pathname.startsWith(base)) return this.notFound();

        if (request.method === 'OPTIONS') return this.preflight();

        if (path === '/healthz' || path === '/health') {
            if (!this.gateway.config.server.health) return this.notFound();
            return this.health();
        }

        const route = this.matchRoute(path);
        if (!route) return this.notFound();

        const principal = this.authenticate(request, route);
        if (!principal) {
            // No hint about which part was wrong, and nothing about the path is logged.
            this.logger.warn('rejected an unauthenticated request', { method: request.method, route: route.kind });
            return this.unauthorized();
        }

        if (route.clientId && route.clientId !== principal.clientId) {
            return this.forbidden('the key does not belong to that client');
        }

        try {
            return await this.serveMcp(request, principal);
        } catch (error) {
            this.logger.error('request failed', { error: errorMessage(error) });
            return this.jsonRpcError(500, -32603, 'internal error');
        }
    }

    private matchRoute(path: string): { kind: 'plain' | 'pathKey' | 'named'; key?: string; clientId?: string } | undefined {
        if (path === '/mcp' || path === '/mcp/') return { kind: 'plain' };
        const pathKey = /^\/k\/([^/]+)\/mcp\/?$/.exec(path);
        if (pathKey?.[1]) return { kind: 'pathKey', key: decodeURIComponent(pathKey[1]) };
        const named = /^\/c\/([^/]+)\/mcp\/?$/.exec(path);
        if (named?.[1]) return { kind: 'named', clientId: decodeURIComponent(named[1]) };
        return undefined;
    }

    private authenticate(request: Request, route: { kind: string; key?: string }): Principal | undefined {
        if (route.kind === 'pathKey' && route.key) {
            const fromPath = this.keys.fromPath(route.key);
            if (fromPath) return fromPath;
        }
        const fromBearer = this.keys.fromBearer(request.headers.get('authorization'));
        if (fromBearer) return fromBearer;
        const sole = this.keys.solePublicClient;
        if (sole) return { clientId: sole, via: 'public' };
        return undefined;
    }

    private async serveMcp(request: Request, principal: Principal): Promise<Response> {
        const sessionId = request.headers.get('mcp-session-id');
        const stateless = this.gateway.config.server.stateless;

        if (stateless) return this.serveStateless(request, principal);

        if (sessionId) {
            const live = this.sessions.get(sessionId);
            if (!live || live.clientId !== principal.clientId) {
                // 404, never 400. A client that is told "bad request" keeps
                // retrying a session that no longer exists; 404 is the spec's
                // signal to start a new one, and clients recover on their own.
                return this.jsonRpcError(404, JSONRPC_INVALID_REQUEST, 'session not found: start a new one');
            }
            live.lastSeen = Date.now();
            const parsed = await this.readBody(request);
            if (parsed.error) return parsed.error;
            return live.transport.handleRequest(request, parsed.hasBody ? { parsedBody: parsed.body } : undefined);
        }

        if (request.method === 'GET' || request.method === 'DELETE') {
            return this.jsonRpcError(400, JSONRPC_INVALID_REQUEST, 'Mcp-Session-Id header is required');
        }

        const parsed = await this.readBody(request);
        if (parsed.error) return parsed.error;
        if (!isInitialize(parsed.body)) {
            return this.jsonRpcError(400, JSONRPC_INVALID_REQUEST, 'the first request of a session must be initialize');
        }

        return this.openSession(request, principal, parsed.body);
    }

    private async openSession(request: Request, principal: Principal, body: unknown): Promise<Response> {
        const session = this.gateway.createSession(principal.clientId);
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            keepAliveMs: this.gateway.config.server.keepAliveMs,
            maxRequestBodySize: this.gateway.config.server.maxBodyBytes,
            onsessioninitialized: id => {
                this.sessions.set(id, { id, clientId: principal.clientId, session, transport, lastSeen: Date.now() });
                this.logger.info('session opened', { client: principal.clientId, via: principal.via, sessions: this.sessions.size });
            },
            onsessionclosed: id => {
                void this.dropSession(id, 'client closed it');
            }
        });

        transport.onerror = error => this.logger.warn('transport error', { error: errorMessage(error) });
        await session.server.connect(transport);
        return transport.handleRequest(request, { parsedBody: body });
    }

    /**
     * Stateless mode: one throwaway server per request.
     *
     * This is what makes serverless hosting possible, and it costs the half of
     * MCP that needs a session — a server cannot ask the agent anything,
     * because there is no stream to ask on. Forms and sampling are refused
     * rather than left hanging.
     */
    private async serveStateless(request: Request, principal: Principal): Promise<Response> {
        if (request.method !== 'POST') {
            return this.jsonRpcError(405, JSONRPC_INVALID_REQUEST, 'stateless mode only accepts POST');
        }
        const parsed = await this.readBody(request);
        if (parsed.error) return parsed.error;

        const session = this.gateway.createSession(principal.clientId);
        const transport = new WebStandardStreamableHTTPServerTransport({
            keepAliveMs: this.gateway.config.server.keepAliveMs,
            maxRequestBodySize: this.gateway.config.server.maxBodyBytes,
            enableJsonResponse: true
        });
        await session.server.connect(transport);
        try {
            return await transport.handleRequest(request, { parsedBody: parsed.body });
        } finally {
            void session.close();
        }
    }

    private async readBody(request: Request): Promise<{ body?: unknown; hasBody: boolean; error?: Response }> {
        if (request.method !== 'POST') return { hasBody: false };
        const declared = Number(request.headers.get('content-length') ?? '0');
        const limit = this.gateway.config.server.maxBodyBytes;
        if (declared > limit) {
            return { hasBody: false, error: this.jsonRpcError(413, JSONRPC_INVALID_REQUEST, 'request body too large') };
        }
        let text: string;
        try {
            text = await request.text();
        } catch (error) {
            return { hasBody: false, error: this.jsonRpcError(400, JSONRPC_INVALID_REQUEST, `cannot read body: ${errorMessage(error)}`) };
        }
        if (text.length > limit) {
            return { hasBody: false, error: this.jsonRpcError(413, JSONRPC_INVALID_REQUEST, 'request body too large') };
        }
        if (text.trim() === '') return { hasBody: false };
        try {
            return { body: JSON.parse(text), hasBody: true };
        } catch {
            return { hasBody: false, error: this.jsonRpcError(400, -32700, 'body is not valid JSON') };
        }
    }

    private startSweeper(): void {
        const idle = this.gateway.config.server.sessionIdleMs;
        if (this.gateway.config.server.stateless || !idle) return;
        this.sweeper = setInterval(() => {
            const cutoff = Date.now() - idle;
            for (const live of [...this.sessions.values()]) {
                if (live.lastSeen < cutoff) void this.dropSession(live.id, 'idle');
            }
        }, Math.min(idle, 60_000));
        this.sweeper.unref?.();
    }

    private async dropSession(id: string, why: string): Promise<void> {
        const live = this.sessions.get(id);
        if (!live) return;
        this.sessions.delete(id);
        this.logger.info('session closed', { client: live.clientId, why, sessions: this.sessions.size });
        await live.session.close();
    }

    async close(): Promise<void> {
        if (this.sweeper) clearInterval(this.sweeper);
        await Promise.all([...this.sessions.keys()].map(id => this.dropSession(id, 'shutting down')));
    }

    // --- canned responses ---

    private corsHeaders(): Record<string, string> {
        if (!this.gateway.config.server.cors) return {};
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
            'Access-Control-Expose-Headers': 'Mcp-Session-Id'
        };
    }

    private preflight(): Response {
        return new Response(null, { status: 204, headers: this.corsHeaders() });
    }

    private health(): Response {
        const upstreams = this.gateway.upstreamStatuses();
        const body = {
            ok: true,
            name: 'jackfield',
            sessions: this.sessions.size,
            clients: this.gateway.clientIds().length,
            upstreams: upstreams.map(status => ({ id: status.id, state: status.state, tools: status.toolCount }))
        };
        return Response.json(body, { headers: this.corsHeaders() });
    }

    private notFound(): Response {
        return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain', ...this.corsHeaders() } });
    }

    private unauthorized(): Response {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401,
            headers: {
                'Content-Type': 'application/json',
                'WWW-Authenticate': 'Bearer realm="jackfield"',
                ...this.corsHeaders()
            }
        });
    }

    private forbidden(reason: string): Response {
        return Response.json({ error: reason }, { status: 403, headers: this.corsHeaders() });
    }

    private jsonRpcError(status: number, code: number, message: string): Response {
        return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
            status,
            headers: { 'Content-Type': 'application/json', ...this.corsHeaders() }
        });
    }
}

function isInitialize(body: unknown): boolean {
    if (Array.isArray(body)) return body.some(isInitialize);
    return Boolean(body && typeof body === 'object' && (body as { method?: unknown }).method === 'initialize');
}
