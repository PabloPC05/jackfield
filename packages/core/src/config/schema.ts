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
            rename: z.record(z.string(), z.string()).optional()
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
    ...upstreamCommon
});

const sseUpstream = z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: headersSchema.optional(),
    token: z.string().optional(),
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

export const upstreamSchema = z.discriminatedUnion('transport', [httpUpstream, sseUpstream, stdioUpstream, executorUpstream]);

export const executorSchema = z.object({
    url: z.string().url(),
    token: z.string().min(1),
    description: z.string().max(500).optional()
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
    instructions: z.string().max(8000).optional()
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
            expose: z.enum(['all', 'search']).default('all'),
            /**
             * How long an aggregated tool catalog is reused before it is read
             * again. The catalog is shared by every session of a client, so
             * `tools/list` costs nothing once it is warm.
             */
            catalogTtlMs: z.number().int().positive().default(300_000)
        })
        .default({}),

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
export type ServerConfig = Config['server'];
export type Defaults = Config['defaults'];
export type { PrefixMode } from '../util/names.js';
