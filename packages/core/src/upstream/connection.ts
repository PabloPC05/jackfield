import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    CreateMessageRequestSchema,
    ElicitRequestSchema,
    ListRootsRequestSchema,
    type CallToolResult,
    type Tool
} from '@modelcontextprotocol/sdk/types.js';

import type { Config, ExecutorConfig, UpstreamConfig } from '../config/schema.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { matchesGlob } from '../util/names.js';
import type { CallContext, DownstreamBridge, UpstreamState, UpstreamStatus, UpstreamTool } from './types.js';

const CLIENT_INFO = { name: 'jackfield', version: '0.1.0', title: 'Jackfield gateway' };

export interface UpstreamConnectionOptions {
    id: string;
    config: UpstreamConfig;
    executors: Config['executors'];
    defaults: Config['defaults'];
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    logger: Logger;
    bridge: DownstreamBridge;
}

/**
 * One connection to one upstream MCP server.
 *
 * Connects lazily — the first `tools/list` or call pays for it — so a gateway
 * with thirty upstreams does not open thirty connections for an agent that
 * uses one. A connection that fails stays failed but retryable: `failOpen`
 * decides whether that takes the whole list down with it.
 */
export class UpstreamConnection {
    readonly id: string;
    readonly config: UpstreamConfig;
    private readonly options: UpstreamConnectionOptions;
    private readonly logger: Logger;

    private client?: Client;
    private connecting?: Promise<void>;
    private state: UpstreamState = 'idle';
    private lastError?: string;
    private connectedAt?: number;
    private lastErrorAt?: number;
    private tools: UpstreamTool[] = [];
    private instructions?: string;

    constructor(options: UpstreamConnectionOptions) {
        this.id = options.id;
        this.config = options.config;
        this.options = options;
        this.logger = options.logger.child({ upstream: options.id });
    }

    get status(): UpstreamStatus {
        return {
            id: this.id,
            state: this.state,
            transport: this.config.transport,
            toolCount: this.tools.length,
            ...(this.lastError ? { error: this.lastError } : {}),
            ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
            ...(this.lastErrorAt ? { lastErrorAt: this.lastErrorAt } : {})
        };
    }

    get serverInstructions(): string | undefined {
        return this.config.instructions === 'drop' ? undefined : this.instructions;
    }

    get failOpen(): boolean {
        return this.config.failOpen ?? this.options.defaults.failOpen;
    }

    private get timeoutMs(): number {
        return this.config.timeoutMs ?? this.options.requestTimeoutMs;
    }

    async ensureConnected(): Promise<void> {
        if (this.state === 'ready') return;
        if (this.state === 'closed') throw new Error(`upstream ${this.id} is closed`);
        this.connecting ??= this.connect().finally(() => {
            this.connecting = undefined;
        });
        return this.connecting;
    }

    private async connect(): Promise<void> {
        this.state = 'connecting';
        const started = Date.now();
        try {
            const client = new Client(CLIENT_INFO, {
                capabilities: {
                    // Declared unconditionally: an upstream decides what to ask
                    // for before we know whether the agent can answer, and a
                    // clear "the agent cannot do this" beats a silent timeout.
                    elicitation: {},
                    sampling: {},
                    roots: { listChanged: false }
                }
            });
            this.installBridge(client);
            const transport = this.createTransport();
            const timer = AbortSignal.timeout(this.options.startupTimeoutMs);
            await client.connect(transport, { signal: timer, timeout: this.options.startupTimeoutMs });
            this.client = client;
            this.instructions = client.getInstructions();
            this.state = 'ready';
            this.connectedAt = Date.now();
            this.lastError = undefined;
            await this.refreshTools();
            this.logger.debug('upstream ready', { ms: Date.now() - started, tools: this.tools.length });
        } catch (error) {
            this.state = 'failed';
            this.lastError = errorMessage(error);
            this.lastErrorAt = Date.now();
            this.client = undefined;
            this.logger.warn('upstream failed', { error: this.lastError, ms: Date.now() - started });
            throw error;
        }
    }

    /** Wires upstream→agent requests and notifications onto the bridge. */
    private installBridge(client: Client): void {
        const { bridge } = this.options;

        client.setRequestHandler(ElicitRequestSchema, async request => {
            if (!bridge.capabilities.elicitation) {
                throw new Error(`the connected agent cannot show forms, so ${this.id} cannot ask for input`);
            }
            this.logger.debug('forwarding elicitation to agent');
            return bridge.elicitInput(request.params);
        });

        client.setRequestHandler(CreateMessageRequestSchema, async request => {
            if (!bridge.capabilities.sampling) {
                throw new Error(`the connected agent does not offer sampling, so ${this.id} cannot ask for a completion`);
            }
            return bridge.createMessage(request.params);
        });

        client.setRequestHandler(ListRootsRequestSchema, async () => {
            if (!bridge.capabilities.roots) return { roots: [] };
            return bridge.listRoots();
        });

        client.fallbackNotificationHandler = async notification => {
            const method = notification.method;
            if (method === 'notifications/tools/list_changed') {
                await this.refreshTools().catch(() => undefined);
                bridge.toolsChanged();
                return;
            }
            if (method === 'notifications/message') {
                const params = notification.params as { level?: string; logger?: string; data?: unknown } | undefined;
                bridge.log(params?.level ?? 'info', params?.logger ?? this.id, params?.data);
                return;
            }
            this.logger.debug('ignored upstream notification', { method });
        };
    }

    private createTransport(): Transport {
        const config = this.config;
        switch (config.transport) {
            case 'http': {
                return new StreamableHTTPClientTransport(new URL(config.url), {
                    requestInit: { headers: this.httpHeaders(config.headers, config.token, config.hostHeader) }
                });
            }
            case 'sse': {
                return new SSEClientTransport(new URL(config.url), {
                    requestInit: { headers: this.httpHeaders(config.headers, config.token) },
                    eventSourceInit: {
                        fetch: (url, init) =>
                            fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...this.httpHeaders(config.headers, config.token) } })
                    }
                });
            }
            case 'stdio': {
                return new StdioClientTransport({
                    command: config.command,
                    args: config.args,
                    cwd: config.cwd,
                    env: config.inheritEnv ? { ...filterEnv(process.env), ...(config.env ?? {}) } : (config.env ?? {}),
                    stderr: 'pipe'
                });
            }
            case 'executor': {
                const executor: ExecutorConfig | undefined = this.options.executors[config.executor];
                if (!executor) throw new Error(`no executor named ${config.executor}`);
                const remote = config.remote ?? this.id;
                const url = new URL(`./upstream/${encodeURIComponent(remote)}/mcp`, ensureTrailingSlash(executor.url));
                return new StreamableHTTPClientTransport(url, {
                    requestInit: { headers: { Authorization: `Bearer ${executor.token}` } }
                });
            }
        }
    }

    private httpHeaders(headers: Record<string, string> | undefined, token: string | undefined, hostHeader?: string): Record<string, string> {
        const out: Record<string, string> = { ...(headers ?? {}) };
        if (token && !Object.keys(out).some(key => key.toLowerCase() === 'authorization')) {
            out['Authorization'] = `Bearer ${token}`;
        }
        // Some servers validate Host and answer 403 to anything they did not
        // expect; a gateway forwards the agent's Host unless told otherwise.
        if (hostHeader) out['Host'] = hostHeader;
        return out;
    }

    /** Reads the upstream tool list, applying the upstream's own allow/deny/rename. */
    async refreshTools(): Promise<UpstreamTool[]> {
        const client = this.client;
        if (!client) return [];
        const collected: Tool[] = [];
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : {}, { timeout: this.timeoutMs });
            collected.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor && collected.length < 5000);

        const filter = this.config.tools;
        const renames = filter?.rename ?? {};
        this.tools = collected
            .filter(tool => {
                if (filter?.allow && !filter.allow.some(glob => matchesGlob(glob, this.id, tool.name))) return false;
                if (filter?.deny?.some(glob => matchesGlob(glob, this.id, tool.name))) return false;
                return true;
            })
            .map(tool => ({
                upstreamId: this.id,
                wireName: tool.name,
                localName: renames[tool.name] ?? tool.name,
                tool: renames[tool.name] ? { ...tool, name: renames[tool.name] as string } : tool
            }));
        return this.tools;
    }

    /** Cached tools; connects first if needed. Returns `[]` on failure when failOpen. */
    async listTools(): Promise<UpstreamTool[]> {
        try {
            await this.ensureConnected();
        } catch (error) {
            if (this.failOpen) return [];
            throw error;
        }
        return this.tools;
    }

    async callTool(wireName: string, args: unknown, context: CallContext = {}): Promise<CallToolResult> {
        await this.ensureConnected();
        const client = this.client;
        if (!client) throw new Error(`upstream ${this.id} is not connected`);

        const result = await client.callTool(
            { name: wireName, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            {
                timeout: this.timeoutMs,
                // A long call stays alive as long as the upstream keeps talking,
                // which is what the gateway asks of its own upstreams too.
                resetTimeoutOnProgress: true,
                ...(context.signal ? { signal: context.signal } : {}),
                ...(context.progressToken !== undefined
                    ? {
                          onprogress: progress =>
                              this.options.bridge.progress({
                                  token: context.progressToken as string | number,
                                  progress: progress.progress,
                                  ...(progress.total !== undefined ? { total: progress.total } : {}),
                                  ...(progress.message !== undefined ? { message: progress.message } : {}),
                                  ...(context.relatedRequestId !== undefined ? { relatedRequestId: context.relatedRequestId } : {})
                              })
                      }
                    : {})
            }
        );
        return result as CallToolResult;
    }

    async close(): Promise<void> {
        this.state = 'closed';
        const client = this.client;
        this.client = undefined;
        this.tools = [];
        if (client) await client.close().catch(() => undefined);
    }
}

function ensureTrailingSlash(url: string): string {
    return url.endsWith('/') ? url : url + '/';
}

/** Drops obviously sensitive variables when a stdio child inherits the environment. */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (/token|secret|password|key|credential/i.test(key)) continue;
        out[key] = value;
    }
    return out;
}
