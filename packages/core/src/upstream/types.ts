import type { ElicitRequest, ElicitResult, CreateMessageRequest, CreateMessageResult, ListRootsResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/** Identifies the agent request an upstream call is serving. */
export interface CallContext {
    /** Progress token the agent asked us to use, when it asked for progress. */
    progressToken?: string | number;
    /** The agent's own request id, so notifications go back on its stream. */
    relatedRequestId?: string | number;
    signal?: AbortSignal;
}

/**
 * What an upstream can ask of the agent on the other side of the gateway.
 *
 * This is the part most gateways skip. An MCP server is allowed to turn the
 * conversation around and ask the client for something — a form to fill in
 * (elicitation), a model completion (sampling), the roots it may read. A
 * gateway that only forwards tool calls breaks every server that does it, so
 * the bridge is a first-class object here rather than an afterthought.
 */
export interface DownstreamBridge {
    /** Capabilities the agent declared at initialize, used to answer honestly when it cannot help. */
    capabilities: { elicitation: boolean; sampling: boolean; roots: boolean };
    elicitInput(params: ElicitRequest['params']): Promise<ElicitResult>;
    createMessage(params: CreateMessageRequest['params']): Promise<CreateMessageResult>;
    listRoots(): Promise<ListRootsResult>;
    /**
     * Progress for an in-flight call.
     *
     * `relatedRequestId` matters more than it looks: a Streamable HTTP client
     * reads a call's notifications on that call's own stream. A progress
     * notification sent without it goes to the standalone stream, which most
     * clients never open, so the agent sees a long call sit silent and gives
     * up on it.
     */
    progress(params: {
        token: string | number;
        progress: number;
        total?: number;
        message?: string;
        relatedRequestId?: string | number;
    }): void;
    /** The agent's tool list changed upstream: ask it to re-read ours. */
    toolsChanged(): void;
    /** A log line from an upstream, forwarded if the agent asked for logs. */
    log(level: string, logger: string, data: unknown): void;
}

export type UpstreamState = 'idle' | 'connecting' | 'ready' | 'failed' | 'closed';

export interface UpstreamStatus {
    id: string;
    state: UpstreamState;
    transport: string;
    toolCount: number;
    error?: string;
    connectedAt?: number;
    lastErrorAt?: number;
}

/** A tool as the upstream named it, before the gateway prefixes anything. */
export interface UpstreamTool {
    upstreamId: string;
    /** Name on the upstream, after `tools.rename`. */
    localName: string;
    /** Name actually sent to the upstream (before rename). */
    wireName: string;
    tool: Tool;
}
