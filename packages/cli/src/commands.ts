import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
    Gateway,
    authStatus,
    createLogger,
    loadConfig,
    login,
    logout,
    serve,
    visibleTools,
    type Catalog
} from '@jackfield/core';

import { estimateTokens, findConfig, formatBytes, table } from './options.js';

export async function commandServe(args: { config?: string; host?: string; port?: number; warm?: boolean; logLevel?: string }): Promise<void> {
    const path = await findConfig(args.config);
    const { config } = await loadConfig(path);
    if (args.logLevel) config.server.logLevel = args.logLevel as typeof config.server.logLevel;

    const logger = createLogger({ level: config.server.logLevel, format: config.server.logFormat });
    const gateway = new Gateway({ config, logger, configPath: path });
    const running = await serve({
        gateway,
        ...(args.host ? { host: args.host } : {}),
        ...(args.port !== undefined ? { port: args.port } : {}),
        ...(args.warm ? { warmUp: true } : {}),
        logger
    });

    if (config.panel.key) {
        logger.info('the panel is at', { url: `${running.url}/panel?key=<la clave del panel>` });
    }

    logger.info('jackfield is listening', {
        url: `${running.url}/mcp`,
        clients: gateway.clientIds().length,
        upstreams: Object.keys(config.upstreams).length,
        config: path
    });

    const shutdown = async (signal: string) => {
        logger.info('shutting down', { signal });
        await running.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

export async function commandCheck(args: { config?: string; json?: boolean }): Promise<number> {
    const path = await findConfig(args.config);
    const { config } = await loadConfig(path);
    const gateway = new Gateway({ config, logger: createLogger({ level: 'warn' }) });

    process.stderr.write(`checking ${Object.keys(config.upstreams).length} upstreams from ${path}\n\n`);
    const statuses = await gateway.warmUp();

    if (args.json) {
        const catalogs: Record<string, unknown> = {};
        for (const clientId of gateway.clientIds()) {
            const catalog = await gateway.getCatalog(clientId);
            catalogs[clientId] = { tools: catalog.tools.length, unavailable: catalog.unavailable };
        }
        process.stdout.write(JSON.stringify({ config: path, upstreams: statuses, clients: catalogs }, null, 2) + '\n');
    } else {
        process.stdout.write(
            table(
                statuses.map(status => [
                    status.id,
                    status.transport,
                    status.state === 'ready' ? 'ok' : status.state,
                    String(status.toolCount),
                    status.error ?? ''
                ]),
                ['upstream', 'transport', 'state', 'tools', 'problem']
            ) + '\n\n'
        );

        const rows: string[][] = [];
        for (const clientId of gateway.clientIds()) {
            const catalog = await gateway.getCatalog(clientId);
            const selection = gateway.selectionFor(clientId);
            const listed = visibleTools(catalog, selection).length + (selection.expose === 'search' ? 2 : 0);
            rows.push([
                clientId,
                config.clients[clientId]?.profile ?? '(none)',
                selection.expose,
                String(catalog.tools.length),
                String(listed)
            ]);
        }
        process.stdout.write(table(rows, ['client', 'profile', 'expose', 'reachable', 'listed']) + '\n');

        const oauth = await authStatus(config, createLogger({ level: 'silent' }));
        if (oauth.length) {
            process.stdout.write(
                '\n' +
                    table(
                        oauth.map(entry => [
                            entry.id,
                            entry.loggedIn ? 'logged in' : 'NOT logged in',
                            entry.hasRefresh ? 'refreshable' : 'no refresh token'
                        ]),
                        ['oauth upstream', 'state', 'renewal']
                    ) +
                    '\n'
            );
            const missing = oauth.filter(entry => !entry.loggedIn);
            if (missing.length) {
                process.stdout.write(`\nRun: ${missing.map(entry => `jackfield login ${entry.id}`).join('\n     ')}\n`);
            }
        }
    }

    await gateway.close();
    const broken = statuses.filter(status => status.state === 'failed');
    if (broken.length) {
        process.stderr.write(`\n${broken.length} upstream(s) could not be reached\n`);
        return 1;
    }
    return 0;
}

export async function commandLogin(args: { config?: string; upstream: string; manual?: boolean }): Promise<void> {
    const path = await findConfig(args.config);
    const { config } = await loadConfig(path);
    const logger = createLogger({ level: 'warn' });

    const result = await login({
        config,
        upstreamId: args.upstream,
        logger,
        ...(args.manual ? { manual: true } : {})
    });

    process.stdout.write(
        `\nLogged in to "${result.upstreamId}". Credentials are in ${config.auth.storeDir}, mode 0600.\n` +
            (result.refreshable
                ? 'The gateway will refresh them on its own.\n'
                : 'The server issued no refresh token, so this will need doing again when it expires.\n')
    );
}

export async function commandLogout(args: { config?: string; upstream: string }): Promise<void> {
    const path = await findConfig(args.config);
    const { config } = await loadConfig(path);
    await logout(config, args.upstream, createLogger({ level: 'warn' }));
    process.stdout.write(`Forgot the credentials for "${args.upstream}".\n`);
}

export async function commandTools(args: { config?: string; client?: string; json?: boolean; bySource?: boolean }): Promise<void> {
    const path = await findConfig(args.config);
    const { config } = await loadConfig(path);
    const gateway = new Gateway({ config, logger: createLogger({ level: 'warn' }) });
    await gateway.warmUp();

    const clientId = args.client ?? gateway.clientIds()[0];
    if (!clientId) throw new Error('no clients are defined in the configuration');
    if (!gateway.clientIds().includes(clientId)) {
        throw new Error(`no client named "${clientId}". Known: ${gateway.clientIds().join(', ')}`);
    }

    const catalog = await gateway.getCatalog(clientId);

    if (args.json) {
        process.stdout.write(JSON.stringify({ client: clientId, tools: catalog.tools.map(tool => tool.tool) }, null, 2) + '\n');
    } else if (args.bySource) {
        process.stdout.write(bySourceReport(catalog, clientId));
    } else {
        const rows = catalog.tools.map(exposed => [
            exposed.name,
            exposed.upstreamId,
            formatBytes(definitionBytes(exposed.tool)),
            firstLine(exposed.tool.description ?? '')
        ]);
        process.stdout.write(table(rows, ['tool', 'source', 'size', 'description']) + '\n');
        process.stdout.write(`\n${catalog.tools.length} tools for "${clientId}"\n`);
    }

    await gateway.close();
}

/**
 * The size of what a client loads.
 *
 * Worth printing because the number is usually a surprise: a gateway with
 * everything plugged in can put a six-figure token count in front of every
 * single turn, and the only way to decide what to cut is to see the bill per
 * source.
 */
function bySourceReport(catalog: Catalog, clientId: string): string {
    const groups = new Map<string, { tools: number; bytes: number }>();
    for (const exposed of catalog.tools) {
        const group = groups.get(exposed.upstreamId) ?? { tools: 0, bytes: 0 };
        group.tools += 1;
        group.bytes += definitionBytes(exposed.tool);
        groups.set(exposed.upstreamId, group);
    }

    const rows = [...groups.entries()]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .map(([id, group]) => [id, String(group.tools), formatBytes(group.bytes), `~${estimateTokens(group.bytes).toLocaleString('en-US')}`]);

    const totalTools = catalog.tools.length;
    const totalBytes = [...groups.values()].reduce((sum, group) => sum + group.bytes, 0);

    return (
        table(rows, ['source', 'tools', 'definitions', 'tokens (rough)']) +
        '\n\n' +
        `${totalTools} tools, ${formatBytes(totalBytes)} of definitions, about ${estimateTokens(totalBytes).toLocaleString('en-US')} tokens ` +
        `for "${clientId}" if the client loads them all.\n` +
        (catalog.unavailable.length ? `Not counted (unreachable): ${catalog.unavailable.map(item => item.id).join(', ')}\n` : '')
    );
}

function definitionBytes(tool: unknown): number {
    return Buffer.byteLength(JSON.stringify(tool), 'utf8');
}

function firstLine(text: string): string {
    const line = text.split('\n')[0] ?? '';
    return line.length > 70 ? `${line.slice(0, 67)}...` : line;
}

export async function commandRoutes(args: { config?: string; publicUrl?: string }): Promise<void> {
    const path = await findConfig(args.config);
    const { config } = await loadConfig(path, { protectSecrets: false });
    const base = (args.publicUrl ?? config.server.publicUrl ?? `http://${config.server.host}:${config.server.port}`).replace(/\/+$/, '') + config.server.basePath;

    process.stdout.write(`# How each client connects\n\n`);
    for (const [clientId, client] of Object.entries(config.clients)) {
        if (!client.enabled) continue;
        process.stdout.write(`## ${clientId}${client.description ? ` — ${client.description}` : ''}\n`);
        if (client.public) {
            process.stdout.write(`URL: ${base}/mcp  (no key)\n\n`);
            continue;
        }
        process.stdout.write(`URL:    ${base}/mcp\nHeader: Authorization: Bearer ${client.key}\n`);
        if (client.keyInPath) {
            process.stdout.write(`Or, for a client that cannot send headers:\n        ${base}/k/${client.key}/mcp\n`);
        }
        process.stdout.write('\n');
    }
    process.stdout.write(`Keys are printed in full: this output is a secret.\n`);
}

export function commandKeygen(args: { bytes?: number; count?: number }): void {
    const bytes = args.bytes ?? 32;
    for (let i = 0; i < (args.count ?? 1); i++) {
        process.stdout.write(randomBytes(bytes).toString('base64url') + '\n');
    }
}

export async function commandInit(args: { config?: string; force?: boolean }): Promise<void> {
    const target = args.config ?? 'jackfield.yaml';
    const key = randomBytes(32).toString('base64url');
    const sample = `# Jackfield — one MCP endpoint for every agent you use.
# Everything the gateway does is in this file. Secrets are not: reference them
# with \${env:NAME} or \${file:/path}.

server:
  host: 127.0.0.1
  port: 8790
  # publicUrl: https://mcp.example.com

upstreams:
  # An MCP server that speaks HTTP.
  # example-http:
  #   transport: http
  #   url: https://example.com/mcp
  #   token: \${file:secrets/example.token}

  # An MCP server that runs as a child process.
  # example-stdio:
  #   transport: stdio
  #   command: npx
  #   args: ["-y", "some-mcp-server"]
  #   env:
  #     API_KEY: \${env:SOME_API_KEY}

profiles:
  everything:
    upstreams: ["*"]

clients:
  my-agent:
    description: the agent I use every day
    key: ${key}
    profile: everything
    # Agents that cannot send an Authorization header can use /k/<key>/mcp:
    # keyInPath: true
`;
    await writeFile(target, sample, { flag: args.force ? 'w' : 'wx' });
    process.stdout.write(`wrote ${target}\nA key was generated for the sample client. Keep the file out of public git.\n`);
}
