import { z } from 'zod';

/**
 * The Jackfield configuration file.
 *
 * It is the whole state of the gateway: there is no database and no admin
 * panel that writes behind your back, so the file can live in git and a
 * deployment is a diff. Secrets are not in it — they are referenced with
 * `${env:NAME}` or `${file:/path}` and resolved at load time.
 */

const identifier = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'use lowercase letters, digits, dash and underscore');

const toolGlob = z.string().min(1).max(200);

/** `always` | `never` | `auto` — see {@link ../util/names.PrefixMode}. */
const prefixMode = z.enum(['always', 'never', 'auto']);

const headersSchema = z.record(z.string(), z.string());

const upstreamCommon = {
    /** Shown in `find_tool` results and in `jackfield tools`. */
    description: z.string().max(500).optional(),
    /** Name used to prefix this upstream's tools. Defaults to the upstream id. */
    prefix: z.string().min(1).max(40).optional(),
    /** Set false to keep the definition but stop serving it. */
    enabled: z.boolean().default(true),
    /** When true (the default), an upstream that is down is skipped instead of failing the whole list. */
    failOpen: z.boolean().optional(),
    /** Per-call timeout. Long-running upstreams should send progress instead of raising this. */
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
    /** Tool-level filter applied before any client profile sees the upstream. */
    tools: z
        .object({
            allow: z.array(toolGlob).optional(),
            deny: z.array(toolGlob).optional(),
            /** `{ "old_name": "new_name" }`, applied before prefixing. */
            rename: z.record(z.string(), z.string()).optional(),
            /**
             * Rewrite what the agent reads about a tool, without touching its
             * server. Keyed by the name the upstream uses. Worth doing: the
             * research on tool descriptions says concrete beats long, and a
             * server's own wording is often neither.
             */
            override: z
                .record(
                    z.string(),
                    z.object({
                        title: z.string().max(200).optional(),
                        description: z.string().max(4000).optional(),
                        /** Merged over the upstream's own annotations. */
                        annotations: z
                            .object({
                                title: z.string().optional(),
                                readOnlyHint: z.boolean().optional(),
                                destructiveHint: z.boolean().optional(),
                                idempotentHint: z.boolean().optional(),
                                openWorldHint: z.boolean().optional()
                            })
                            .optional()
                    })
                )
                .optional()
        })
        .optional(),
    /** Response limits for this upstream. Overrides `defaults.limits`. */
    limits: z
        .object({
            /**
             * Largest tool result passed through, in bytes of JSON. Over it,
             * text is trimmed and the agent is told how much was cut — a
             * truncated answer it knows about beats a context window spent on
             * one reply.
             */
            maxResponseBytes: z.number().int().positive().optional()
        })
        .optional(),
    /** Free-form labels, usable in profile selectors as `tag:name`. */
    tags: z.array(z.string().min(1).max(40)).optional(),
    /**
     * What to do with the upstream's own `instructions` string: `keep` merges
     * it into the gateway instructions, `drop` discards it. Dropping is often
     * right — instructions are tokens every client pays on every turn.
     */
    instructions: z.enum(['keep', 'drop']).default('keep'),
    /** Capabilities to forward. Tools only, by default: the rest is rarely used and costs a round trip. */
    forward: z
        .object({
            tools: z.boolean().default(true),
            resources: z.boolean().default(false),
            prompts: z.boolean().default(false)
        })
        .default({ tools: true, resources: false, prompts: false })
};


/**
 * OAuth towards an upstream. Its presence turns it on.
 *
 * Tokens live in `auth.storeDir`, mode 0600, and are refreshed by the gateway;
 * no agent ever sees one. Logging in is an operator action — `jackfield login
 * <upstream>` — because a gateway that could start an authorization flow on
 * demand is a gateway an agent could aim at an authorization server of its
 * choosing.
 */
const oauthSchema = z.object({
    /** Scopes to ask for. Omit to take the server's default. */
    scope: z.string().max(500).optional(),
    /** Set only when the server does not do dynamic client registration. */
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    /** Name shown on the consent screen. */
    clientName: z.string().max(100).optional()
});

const httpUpstream = z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: headersSchema.optional(),
    /** Shorthand for `headers: { Authorization: "Bearer <token>" }`. */
    token: z.string().optional(),
    /**
     * Overrides the `Host` header sent upstream. Needed by servers that check
     * it (some reject anything but `127.0.0.1:<port>` with a 403).
     */
    hostHeader: z.string().optional(),
    /** Log in with OAuth instead of a static token. */
    oauth: oauthSchema.optional(),
    ...upstreamCommon
});

const sseUpstream = z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: headersSchema.optional(),
    token: z.string().optional(),
    oauth: oauthSchema.optional(),
    ...upstreamCommon
});

const stdioUpstream = z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    /** When false (the default) the child gets only `env`, not the gateway's environment. */
    inheritEnv: z.boolean().default(false),
    cwd: z.string().optional(),
    ...upstreamCommon
});

const executorUpstream = z.object({
    /**
     * An upstream that lives on a Jackfield executor: a small process on a
     * machine of yours that runs what a serverless core cannot (stdio servers,
     * a browser, a shell). The core only needs the executor's URL.
     */
    transport: z.literal('executor'),
    executor: identifier,
    /** Upstream id as the executor knows it. Defaults to this upstream's id. */
    remote: z.string().min(1).optional(),
    ...upstreamCommon
});

const cliCommandSchema = z.object({
    /** What the agent is told this command is for. Include a real example. */
    description: z.string().min(1).max(2000),
    /** The program to run. Resolved on PATH; never passed to a shell. */
    executable: z.string().min(1),
    /** Arguments always placed before the agent's. */
    prefixArgs: z.array(z.string()).default([]),
    /**
     * If set, the agent's first argument must be one of these. The cheapest
     * way to turn "a CLI" into "these operations of a CLI".
     */
    allowedSubcommands: z.array(z.string()).optional(),
    /** Arguments refused anywhere in the call, matched literally. */
    deniedArgs: z.array(z.string()).default([]),
    /** Most arguments the agent may pass. */
    maxArgs: z.number().int().positive().max(200).default(40),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional()
});

const cliUpstream = z.object({
    /**
     * A built-in MCP server that exposes a few command-line programs as tools.
     *
     * The point is token cost: a service whose MCP server defines 120 tools,
     * used twice a month, costs its definitions in every prompt. One `cli`
     * tool with the service's own command line behind it costs one.
     */
    transport: z.literal('cli'),
    commands: z.record(identifier, cliCommandSchema),
    /** Per-command time limit. A command that outlives it is killed. */
    commandTimeoutMs: z.number().int().positive().max(600_000).default(60_000),
    /** Output kept per stream; the rest is cut with a note. */
    maxOutputBytes: z.number().int().positive().default(100_000),
    ...upstreamCommon
});

export const upstreamSchema = z.discriminatedUnion('transport', [
    httpUpstream,
    sseUpstream,
    stdioUpstream,
    executorUpstream,
    cliUpstream
]);

export const executorSchema = z.object({
    /**
     * Where the executor listens. Leave it out and set `attach: true` instead,
     * and the executor dials the gateway: no inbound port on its side at all.
     */
    url: z.string().url().optional(),
    /**
     * The executor opens the connection and the gateway pushes requests down
     * it. For a machine behind NAT, or one you would rather not expose.
     */
    attach: z.boolean().default(false),
    token: z.string().min(16),
    description: z.string().max(500).optional()
});

/**
 * What to do before a tool runs.
 *
 * `ask` is the interesting one: the gateway puts the question to the agent's
 * own user through an MCP form, and a client that cannot show forms is denied
 * rather than waved through. An approval the agent can grant itself is not an
 * approval.
 */
export const permissionRuleSchema = z.object({
    /** Tool globs this rule covers: `upstream.tool`, `upstream.*`, `*`. */
    tools: z.array(toolGlob).min(1),
    action: z.enum(['allow', 'ask', 'deny']),
    /** Shown to the user when asking, and to the agent when denying. */
    reason: z.string().max(500).optional(),
    /**
     * Where to ask.
     *
     * - `client` (default): a form in the agent's own client.
     * - `link`: a one-time link sent to your notifier, decided on a page of
     *   your own. The agent never sees the link, so it cannot approve itself,
     *   and it works for an agent nobody is watching.
     * - `any`: the client form when the client can show one, the link if not.
     */
    via: z.enum(['client', 'link', 'any']).default('client'),
    /** How long to wait for this rule's answer. Defaults to `approvals.timeoutMs`. */
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
});

/** Selection shared by profiles and clients. */
const selectionSchema = {
    /** Upstream selectors: ids, `*`, or `tag:name`. */
    upstreams: z.array(z.string().min(1)).optional(),
    /** Tool globs (`upstream.tool`, `upstream.*`, `*`) kept after `upstreams`. */
    include: z.array(toolGlob).optional(),
    /** Tool globs removed after `include`. Deny always wins. */
    exclude: z.array(toolGlob).optional(),
    /**
     * `all` lists every selected tool. `search` lists only `find_tool` and
     * `call_tool` (plus `alwaysExpose`), for clients that load every definition
     * up front.
     */
    expose: z.enum(['all', 'search']).optional(),
    /** Tool globs listed even in `search` mode. */
    alwaysExpose: z.array(toolGlob).optional(),
    /** Overrides the prefix mode for this selection. */
    prefix: prefixMode.optional(),
    /** Extra text prepended to the gateway instructions. */
    instructions: z.string().max(8000).optional(),
    /** Permission rules, checked before the global ones. First match wins. */
    permissions: z.array(permissionRuleSchema).optional()
};

export const profileSchema = z.object({
    description: z.string().max(500).optional(),
    /** Profiles this one builds on, merged left to right before its own fields. */
    extends: z.array(identifier).optional(),
    ...selectionSchema
});

export const clientSchema = z.object({
    description: z.string().max(500).optional(),
    /**
     * The client's key. Compared in constant time. Put it in a file or an
     * environment variable and reference it; a literal here ends up in git.
     */
    key: z.string().min(16).optional(),
    /** Extra keys accepted for this client, for rotation without downtime. */
    altKeys: z.array(z.string().min(16)).optional(),
    /**
     * Allow `/<key>/mcp`, for clients that cannot send an Authorization header
     * (claude.ai is one). Paths are never logged for these clients.
     */
    keyInPath: z.boolean().default(false),
    /** Serve this client without a key. Only sensible when something else authenticates. */
    public: z.boolean().default(false),
    profile: identifier.optional(),
    enabled: z.boolean().default(true),
    ...selectionSchema
});

export const configSchema = z.object({
    /** Schema marker, so the file can be validated by an editor. */
    $schema: z.string().optional(),
    version: z.literal(1).default(1),

    server: z
        .object({
            host: z.string().default('127.0.0.1'),
            port: z.number().int().min(0).max(65535).default(8790),
            /** Mounted under this path, e.g. `/gateway` → `/gateway/mcp`. */
            basePath: z.string().default(''),
            /** Public URL, used in OAuth metadata and in printed hints. */
            publicUrl: z.string().url().optional(),
            logLevel: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
            logFormat: z.enum(['json', 'pretty']).default('pretty'),
            /** SSE keep-alive interval. Clients cut a stream that goes quiet (Claude Code at 300 s). */
            keepAliveMs: z.number().int().min(0).max(300_000).default(15_000),
            /** Default per-call timeout towards upstreams. */
            requestTimeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
            /** Answer `/healthz` without a key. */
            health: z.boolean().default(true),
            /**
             * Serve `/status`: a read-only page showing what a key actually
             * sees, and what it costs. Needs that key, and writes nothing.
             */
            status: z.boolean().default(true),
            /**
             * Send permissive CORS headers. Off by default: agents call from a
             * server, and an open gateway in a browser is a gift to any page
             * the user has open.
             */
            cors: z.boolean().default(false),
            /** Largest POST body accepted, in bytes. */
            maxBodyBytes: z.number().int().positive().default(4_194_304),
            /**
             * No sessions: every request is self-contained. Required by
             * serverless hosting, and it breaks anything a server has to ask
             * the client for (elicitation forms, sampling).
             */
            stateless: z.boolean().default(false),
            /** How long an idle session is kept before its upstreams are dropped. */
            sessionIdleMs: z.number().int().positive().default(1_800_000)
        })
        .default({}),

    defaults: z
        .object({
            prefix: prefixMode.default('always'),
            separator: z.string().min(1).max(4).default('_'),
            failOpen: z.boolean().default(true),
            /** Time allowed for an upstream to come up before it is skipped. */
            startupTimeoutMs: z.number().int().positive().default(20_000),
            /** Response limits, overridable per upstream. */
            limits: z
                .object({ maxResponseBytes: z.number().int().positive().default(400_000) })
                .default({ maxResponseBytes: 400_000 }),
            expose: z.enum(['all', 'search']).default('all'),
            /**
             * How long an aggregated tool catalog is reused before it is read
             * again. The catalog is shared by every session of a client, so
             * `tools/list` costs nothing once it is warm.
             */
            catalogTtlMs: z.number().int().positive().default(300_000)
        })
        .default({}),

    /**
     * Where to send a line when something sensitive happens. Fire-and-forget:
     * a notifier that is down never blocks a call.
     */
    notify: z
        .object({
            kind: z.enum(['ntfy', 'webhook']).default('ntfy'),
            url: z.string().url(),
            token: z.string().optional(),
            /** Which tools count as sensitive. */
            tools: z.array(toolGlob).default([]),
            /** Which events to send. */
            events: z.array(z.enum(['call', 'result', 'asked', 'denied', 'error'])).default(['call', 'denied', 'error']),
            /** Prefix for the notification title. */
            title: z.string().max(80).default('jackfield')
        })
        .optional(),

    /** Permission rules applied to every client, after its own. */
    permissions: z.array(permissionRuleSchema).default([]),

    /**
     * The panel: a page where you connect servers and decide, with a button,
     * which of them each agent's address carries.
     *
     * It writes to this very file, comments and all. Off unless you give it a
     * key, because it is the one part of the gateway that can change things.
     */
    panel: z
        .object({
            /** Key that opens the panel. Nothing else accepts it. */
            key: z.string().min(16).optional(),
            /** Base URL shown for the addresses to copy. Defaults to `server.publicUrl`. */
            publicUrl: z.string().url().optional()
        })
        .default({}),

    /** Where OAuth credentials live, and what redirect URI to register. */
    auth: z
        .object({
            /** Directory for the per-upstream credential files (mode 0600). */
            storeDir: z.string().default('./.jackfield/auth'),
            /**
             * Redirect URI registered with the authorization servers. The
             * default is the loopback listener `jackfield login` opens, which
             * is what most servers expect from a command-line client.
             */
            redirectUrl: z.string().url().default('http://127.0.0.1:7777/callback')
        })
        .default({ storeDir: './.jackfield/auth', redirectUrl: 'http://127.0.0.1:7777/callback' }),

    /** Settings for approvals decided outside the agent's conversation. */
    approvals: z
        .object({
            /**
             * Public base URL of the gateway as *you* would reach it, used to
             * build approval links. Required for `via: link`.
             */
            publicUrl: z.string().url().optional(),
            /** How long a link stays open before the call is refused. */
            timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
            /**
             * A secret the page asks for on top of holding the link. Worth it
             * if the link travels through anything you do not fully trust.
             */
            passphrase: z.string().min(4).optional()
        })
        .default({ timeoutMs: 600_000 }),

    executors: z.record(identifier, executorSchema).default({}),
    upstreams: z.record(identifier, upstreamSchema).default({}),
    profiles: z.record(identifier, profileSchema).default({}),
    clients: z.record(identifier, clientSchema).default({})
});

export type RawConfig = z.input<typeof configSchema>;
export type Config = z.output<typeof configSchema>;
export type UpstreamConfig = z.output<typeof upstreamSchema>;
export type ExecutorConfig = z.output<typeof executorSchema>;
export type ProfileConfig = z.output<typeof profileSchema>;
export type ClientConfig = z.output<typeof clientSchema>;
export type PermissionRule = z.output<typeof permissionRuleSchema>;
export type ApprovalsConfig = Config['approvals'];
export type AuthConfig = Config['auth'];
export type PanelConfig = Config['panel'];
export type OAuthUpstreamConfig = z.output<typeof oauthSchema>;
export type NotifyConfig = NonNullable<Config['notify']>;
export type CliCommandConfig = z.output<typeof cliCommandSchema>;
export type ServerConfig = Config['server'];
export type Defaults = Config['defaults'];
export type { PrefixMode } from '../util/names.js';
