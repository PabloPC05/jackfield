import { createServer, type Server as NodeServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

import { toWebRequest, writeWebResponse } from '../dist/index.js';

export interface StubUpstream {
    url: string;
    close(): Promise<void>;
    calls: { tool: string; args: unknown }[];
}

/**
 * A small MCP server used as an upstream in the tests: a plain tool, a tool
 * that reports progress for a while, a tool that asks the agent a question,
 * and a tool whose name collides with the other stub's.
 */
export async function startStubUpstream(name: string, options: { hostHeaderMustBe?: string } = {}): Promise<StubUpstream> {
    const calls: { tool: string; args: unknown }[] = [];
    const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

    const build = () => {
        const server = new McpServer({ name, version: '1.0.0' }, { instructions: `Instructions from ${name}.` });

        server.registerTool(
            'echo',
            { description: `Echo text back from ${name}`, inputSchema: { text: z.string() } },
            async ({ text }) => {
                calls.push({ tool: 'echo', args: { text } });
                return { content: [{ type: 'text', text: `${name}:${text}` }] };
            }
        );

        server.registerTool(
            'search',
            { description: `Search inside ${name}`, inputSchema: { query: z.string() } },
            async ({ query }) => {
                calls.push({ tool: 'search', args: { query } });
                return { content: [{ type: 'text', text: `${name} searched ${query}` }] };
            }
        );

        server.registerTool(
            'slow',
            { description: 'Report progress, then finish', inputSchema: { steps: z.number().optional() } },
            async ({ steps }, extra) => {
                const total = steps ?? 3;
                for (let i = 1; i <= total; i++) {
                    if (extra._meta?.progressToken !== undefined) {
                        await extra.sendNotification({
                            method: 'notifications/progress',
                            params: { progressToken: extra._meta.progressToken, progress: i, total, message: `step ${i}` }
                        });
                    }
                }
                return { content: [{ type: 'text', text: `done in ${total}` }] };
            }
        );

        server.registerTool(
            'big',
            { description: 'Return a lot of text', inputSchema: { kb: z.number() } },
            async ({ kb }) => ({ content: [{ type: 'text', text: 'x'.repeat(Math.round(kb * 1024)) }] })
        );

        server.registerTool(
            'remove',
            { description: 'Pretend to delete something', inputSchema: { what: z.string() } },
            async ({ what }) => {
                calls.push({ tool: 'remove', args: { what } });
                return { content: [{ type: 'text', text: `removed ${what}` }] };
            }
        );

        server.registerTool('ask', { description: 'Ask the agent for a value', inputSchema: {} }, async (_args, extra) => {
            const answer = await extra.sendRequest(
                {
                    method: 'elicitation/create',
                    params: {
                        message: 'What is your name?',
                        requestedSchema: { type: 'object', properties: { nombre: { type: 'string' } }, required: ['nombre'] }
                    }
                },
                z.object({ action: z.string(), content: z.record(z.string(), z.unknown()).optional() })
            );
            return { content: [{ type: 'text', text: `agent said ${JSON.stringify(answer.content ?? null)}` }] };
        });

        return server;
    };

    const http: NodeServer = createServer((req, res) => {
        void (async () => {
            const request = toWebRequest(req);
            if (options.hostHeaderMustBe && request.headers.get('host') !== options.hostHeaderMustBe) {
                await writeWebResponse(new Response('Invalid Host header', { status: 403 }), res);
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
        })().catch(async error => {
            await writeWebResponse(new Response(String(error), { status: 500 }), res).catch(() => undefined);
        });
    });

    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: async () => {
            for (const transport of transports.values()) await transport.close().catch(() => undefined);
            http.closeAllConnections();
            http.close();
            await once(http, 'close').catch(() => undefined);
        }
    };
}
