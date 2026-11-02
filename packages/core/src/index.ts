/**
 * Jackfield: a declarative MCP gateway you can run anywhere.
 *
 * One endpoint for every MCP server you use, one key per agent, and a file in
 * git that says who sees what. The core is transport-agnostic: it answers Web
 * `Request`s, so the same gateway runs as a long-lived process, in a
 * container, or in a serverless function.
 */
export { configSchema, upstreamSchema, profileSchema, clientSchema, executorSchema } from './config/schema.js';
export type {
    Config,
    RawConfig,
    PermissionRule,
    ApprovalsConfig,
    AuthConfig,
    OAuthUpstreamConfig,
    NotifyConfig,
    CliCommandConfig,
    UpstreamConfig,
    ProfileConfig,
    ClientConfig,
    ExecutorConfig,
    ServerConfig,
    Defaults,
    PrefixMode
} from './config/schema.js';
export { loadConfig, parseConfig, resolvePlaceholders } from './config/load.js';
export type { LoadedConfig, LoadOptions } from './config/load.js';

export { Gateway } from './gateway/gateway.js';
export type { GatewayOptions } from './gateway/gateway.js';
export { GatewaySession, GATEWAY_INFO } from './gateway/session.js';
export { buildCatalog, visibleTools } from './gateway/catalog.js';
export type { Catalog, ExposedTool } from './gateway/catalog.js';
export { resolveSelection, resolveUpstreamSelectors } from './gateway/selection.js';
export { decide, decideLayered, describeCall } from './gateway/permissions.js';
export type { PermissionAction, PermissionDecision } from './gateway/permissions.js';
export { Notifier } from './gateway/notify.js';
export { ApprovalStore, renderApprovalPage, renderApprovalMissing } from './gateway/approvals.js';
export type { Approval, ApprovalState, ApprovalRequest, PendingApproval } from './gateway/approvals.js';
export type { NotifyEvent, NotifyPayload } from './gateway/notify.js';
export type { Selection } from './gateway/selection.js';
export { findTools, metaToolDefinitions, metaToolNames, FIND_TOOL, CALL_TOOL } from './gateway/toolsearch.js';

export { UpstreamConnection } from './upstream/connection.js';
export { AuthStore, JackfieldOAuthProvider } from './upstream/oauth.js';
export type { StoredAuth } from './upstream/oauth.js';
export { login, logout, authStatus } from './upstream/login.js';
export type { LoginOptions } from './upstream/login.js';
export { UpstreamPool } from './upstream/pool.js';
export type { CallContext, DownstreamBridge, UpstreamStatus, UpstreamState, UpstreamTool } from './upstream/types.js';

export { Router } from './http/router.js';
export type { RouterOptions } from './http/router.js';
export { KeyRegistry, constantTimeEquals } from './http/auth.js';
export { TunnelHub, tokenMatches } from './http/tunnel.js';
export { buildStatusView, renderStatusPage } from './http/status.js';
export type { StatusView } from './http/status.js';
export type { ReplyFrame, TunnelHubOptions } from './http/tunnel.js';
export type { Principal } from './http/auth.js';

export { serve, toWebRequest, writeWebResponse } from './runtime/node.js';
export type { ServeOptions, RunningServer } from './runtime/node.js';
export { createWebHandler } from './runtime/web.js';
export type { WebHandler, WebHandlerOptions } from './runtime/web.js';

export { createLogger, nullLogger, registerSecret, redact } from './util/logger.js';
export type { Logger, LogLevel } from './util/logger.js';
export { ConfigError, HttpError, errorMessage } from './util/errors.js';
export { Bm25Index, tokenize } from './util/bm25.js';
export { trimResult } from './util/trim.js';
export { createCliServer } from './builtin/cli-server.js';
export { matchesGlob, joinName, sanitizeSegment, isValidToolName, MAX_TOOL_NAME_LENGTH } from './util/names.js';
