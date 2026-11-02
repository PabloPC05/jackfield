import {
    Gateway,
    Router,
    createLogger,
    nullLogger,
    type Config,
    type Logger,
    type UpstreamStatus
} from '@jackfield/core';

export interface ExecutorOptions {
    config: Config;
    /** The single token every request must present. */
    token: string;
    logger?: Logger;
}

/**
 * The executor: a machine's half of a split gateway.
 *
 * A gateway core can be stateless, and a stateless core cannot start a child
 * process, keep a browser open, or hold a shell. Rather than let that decide
 * the architecture — which is how a hosting choice ends up dictating what your
 * tools may be — the executor runs on a machine you own and serves exactly
 * those upstreams, one endpoint each:
 *
 *     ALL /upstream/<id>/mcp     one upstream, unprefixed, Bearer <token>
 *     GET /upstreams             what this executor serves
 *     GET /healthz
 *
 * The core reaches it with `transport: executor`. Nothing else changes: the
 * same upstream definition works in either place, so moving one is a two-line
 * edit, not a migration.
 */
export class Executor {
    private readonly logger: Logger;
    private readonly perUpstream = new Map<string, { gateway: Gateway; router: Router }>();

    constructor(private readonly options: ExecutorOptions) {
        this.logger = (options.logger ?? createLogger({ level: options.config.server.logLevel })).child({ part: 'executor' });
        if (options.token.length < 16) throw new Error('the executor token must be at least 16 characters');
    }

    get upstreamIds(): string[] {
        return Object.entries(this.options.config.upstreams)
            .filter(([, upstream]) => upstream.enabled && upstream.transport !== 'executor')
            .map(([id]) => id);
    }

    async handle(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        if (path === '/healthz' || path === '/health') {
            return Response.json({ ok: true, name: 'jackfield-executor', upstreams: this.upstreamIds });
        }
        if (path === '/upstreams') {
            if (!this.authorized(request)) return unauthorized();
            const statuses: UpstreamStatus[] = [];
            for (const id of this.upstreamIds) {
                const entry = this.perUpstream.get(id);
                if (entry) {
                    statuses.push(...entry.gateway.upstreamStatuses());
                } else {
                    statuses.push({
                        id,
                        state: 'idle',
                        transport: this.options.config.upstreams[id]?.transport ?? 'unknown',
                        toolCount: 0
                    });
                }
            }
            return Response.json({ upstreams: statuses });
        }

        const match = /^\/upstream\/([^/]+)\/mcp$/.exec(path);
        if (!match?.[1]) return new Response('not found\n', { status: 404 });
        const id = decodeURIComponent(match[1]);

        if (!this.upstreamIds.includes(id)) {
            return Response.json({ error: `this executor does not serve "${id}"` }, { status: 404 });
        }
        if (!this.authorized(request)) return unauthorized();

        return this.routerFor(id).handle(request);
    }

    /**
     * One gateway per upstream, each configured to serve just that upstream,
     * unprefixed: the core adds its own prefix, and doing it twice would give
     * agents names like `browser_browser_open`.
     */
    private routerFor(id: string): Router {
        const existing = this.perUpstream.get(id);
        if (existing) return existing.router;

        const upstream = this.options.config.upstreams[id];
        if (!upstream) throw new Error(`no upstream named ${id}`);

        const config: Config = {
            ...this.options.config,
            server: {
                ...this.options.config.server,
                basePath: `/upstream/${id}`,
                health: false
            },
            defaults: { ...this.options.config.defaults, prefix: 'never', expose: 'all' },
            upstreams: { [id]: upstream },
            profiles: {},
            clients: {
                core: {
                    description: `served to a Jackfield core as "${id}"`,
                    key: this.options.token,
                    keyInPath: false,
                    public: false,
                    enabled: true,
                    upstreams: [id],
                    prefix: 'never'
                }
            }
        };

        const gateway = new Gateway({ config, logger: this.logger.child({ upstream: id }) });
        const router = new Router({ gateway, logger: this.logger });
        this.perUpstream.set(id, { gateway, router });
        this.logger.info('serving upstream', { upstream: id, transport: upstream.transport });
        return router;
    }

    private authorized(request: Request): boolean {
        const header = request.headers.get('authorization');
        const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : undefined;
        const token = match?.[1]?.trim();
        if (!token) return false;
        // Delegated to the per-upstream router too; this is the early refusal
        // so an unauthenticated request never starts an upstream.
        return token.length === this.options.token.length && timingSafe(token, this.options.token);
    }

    async close(): Promise<void> {
        for (const { gateway, router } of this.perUpstream.values()) {
            await router.close();
            await gateway.close();
        }
        this.perUpstream.clear();
    }
}

function timingSafe(a: string, b: string): boolean {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function unauthorized(): Response {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="jackfield-executor"' }
    });
}

export { nullLogger };
