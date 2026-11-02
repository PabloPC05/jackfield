import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    type CallToolResult,
    type CreateMessageRequest,
    type ElicitRequest,
    type ElicitRequestFormParams,
    type ElicitResult
} from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../config/schema.js';
import { UpstreamPool } from '../upstream/pool.js';
import type { CallContext, DownstreamBridge } from '../upstream/types.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { Catalog } from './catalog.js';
import { visibleTools } from './catalog.js';
import type { Selection } from './selection.js';
import { CALL_TOOL, findTools, metaToolDefinitions, metaToolNames, suggestNames } from './toolsearch.js';

export const GATEWAY_INFO = { name: 'jackfield', version: '0.1.0', title: 'Jackfield' };

export interface SessionOptions {
    clientId: string;
    config: Config;
    selection: Selection;
    logger: Logger;
    /** Shared catalog for this client, refreshed by the gateway. */
    getCatalog: (options?: { refresh?: boolean }) => Promise<Catalog>;
    instructions?: string;
}

/**
 * One agent session: the MCP server the agent talks to, plus the upstream
 * connections opened on its behalf.
 *
 * Listing tools does not open anything — the catalog is shared and already
 * warm. Only a real call connects, and only to the upstream that owns the
 * tool, so an agent that uses two tools does not wake twenty servers.
 */
export class GatewaySession {
    readonly server: Server;
    readonly pool: UpstreamPool;
    private readonly logger: Logger;
    private closed = false;

    constructor(private readonly options: SessionOptions) {
        this.logger = options.logger.child({ client: options.clientId });

        this.server = new Server(GATEWAY_INFO, {
            capabilities: {
                tools: { listChanged: true },
                logging: {}
            },
            ...(options.instructions ? { instructions: options.instructions } : {})
        });

        this.pool = new UpstreamPool({
            config: options.config,
            upstreamIds: options.selection.upstreamIds,
            logger: this.logger,
            bridge: this.createBridge()
        });

        this.installHandlers();
    }

    /** The agent side of the bridge: what upstreams can ask for, and of whom. */
    private createBridge(): DownstreamBridge {
        const server = () => this.server;
        return {
            get capabilities() {
                const declared = server().getClientCapabilities();
                return {
                    elicitation: Boolean(declared?.elicitation),
                    sampling: Boolean(declared?.sampling),
                    roots: Boolean(declared?.roots)
                };
            },
            elicitInput: (params: ElicitRequest['params']): Promise<ElicitResult> =>
                this.server.elicitInput(params as ElicitRequestFormParams, { timeout: this.options.config.server.requestTimeoutMs }),
            createMessage: (params: CreateMessageRequest['params']) =>
                this.server.createMessage(params, { timeout: this.options.config.server.requestTimeoutMs }),
            listRoots: () => this.server.listRoots(),
            progress: params => {
                void this.server
                    .notification(
                        {
                            method: 'notifications/progress',
                            params: {
                                progressToken: params.token,
                                progress: params.progress,
                                ...(params.total !== undefined ? { total: params.total } : {}),
                                ...(params.message !== undefined ? { message: params.message } : {})
                            }
                        },
                        params.relatedRequestId !== undefined ? { relatedRequestId: params.relatedRequestId } : undefined
                    )
                    .catch(() => undefined);
            },
            toolsChanged: () => {
                void this.server.notification({ method: 'notifications/tools/list_changed' }).catch(() => undefined);
            },
            log: (level, logger, data) => {
                void this.server
                    .notification({
                        method: 'notifications/message',
                        params: { level: normalizeLevel(level), logger, data }
                    })
                    .catch(() => undefined);
            }
        };
    }

    private installHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const catalog = await this.options.getCatalog();
            const selection = this.options.selection;
            const tools = visibleTools(catalog, selection).map(exposed => exposed.tool);
            if (selection.expose === 'search') {
                tools.unshift(...metaToolDefinitions(catalog, selection.upstreamIds));
            }
            this.logger.debug('tools/list', { listed: tools.length, total: catalog.tools.length, mode: selection.expose });
            return { tools };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const progressToken = request.params._meta?.progressToken;
            return this.dispatch(request.params.name, request.params.arguments, {
                ...(progressToken !== undefined ? { progressToken } : {}),
                ...(extra.requestId !== undefined ? { relatedRequestId: extra.requestId } : {}),
                ...(extra.signal ? { signal: extra.signal } : {}),
                depth: 0
            });
        });
    }

    private async dispatch(name: string, args: unknown, context: CallContext & { depth: number }): Promise<CallToolResult> {
        if (context.depth > 2) {
            throw new McpError(ErrorCode.InvalidParams, `${CALL_TOOL} cannot call itself`);
        }
        const catalog = await this.options.getCatalog();
        const meta = metaToolNames(catalog);

        if (name === meta.find) {
            const params = (args ?? {}) as { query?: unknown; limit?: unknown; source?: unknown };
            if (typeof params.query !== 'string' || params.query.trim() === '') {
                throw new McpError(ErrorCode.InvalidParams, 'query is required');
            }
            const hits = findTools(
                catalog,
                params.query,
                typeof params.limit === 'number' ? params.limit : 5,
                typeof params.source === 'string' ? params.source : undefined
            );
            return {
                content: [{ type: 'text', text: JSON.stringify({ query: params.query, matches: hits }, null, 2) }],
                structuredContent: { matches: hits }
            };
        }

        if (name === meta.call) {
            const params = (args ?? {}) as { name?: unknown; arguments?: unknown };
            if (typeof params.name !== 'string') throw new McpError(ErrorCode.InvalidParams, 'name is required');
            return this.dispatch(params.name, params.arguments ?? {}, { ...context, depth: context.depth + 1 });
        }

        let exposed = catalog.byName.get(name);
        if (!exposed) {
            // A tool may have appeared since the catalog was built.
            const fresh = await this.options.getCatalog({ refresh: true });
            exposed = fresh.byName.get(name);
            if (!exposed) {
                const suggestions = suggestNames(fresh, name);
                throw new McpError(
                    ErrorCode.InvalidParams,
                    suggestions.length
                        ? `no tool named "${name}". Closest: ${suggestions.join(', ')}`
                        : `no tool named "${name}"`
                );
            }
        }

        const connection = this.pool.get(exposed.upstreamId);
        if (!connection) {
            throw new McpError(ErrorCode.InvalidParams, `"${name}" belongs to ${exposed.upstreamId}, which this client cannot use`);
        }

        const started = Date.now();
        try {
            const result = await connection.callTool(exposed.wireName, args, context);
            this.logger.debug('tools/call', { tool: name, upstream: exposed.upstreamId, ms: Date.now() - started });
            return result;
        } catch (error) {
            if (error instanceof McpError) throw error;
            const message = errorMessage(error);
            this.logger.warn('tools/call failed', { tool: name, upstream: exposed.upstreamId, error: message, ms: Date.now() - started });
            // Returned as tool output, not a protocol error: the agent can read
            // it, say so, and try something else.
            return {
                isError: true,
                content: [{ type: 'text', text: `${exposed.upstreamId} could not run ${name}: ${message}` }]
            };
        }
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.pool.closeAll();
        await this.server.close().catch(() => undefined);
    }
}

const LOG_LEVELS = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);

function normalizeLevel(level: string): string {
    const lower = level.toLowerCase();
    if (LOG_LEVELS.has(lower)) return lower;
    if (lower === 'warn') return 'warning';
    if (lower === 'fatal') return 'critical';
    return 'info';
}
