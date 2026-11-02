#!/usr/bin/env node
/**
 * A tiny MCP server over stdio, used by `examples/jackfield.yaml` so the
 * example works with no network and nothing to install.
 *
 * Run the example:
 *   npx jackfield check  -c examples/jackfield.yaml
 *   npx jackfield tools  -c examples/jackfield.yaml --by-source
 *   npx jackfield serve  -c examples/jackfield.yaml
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const name = process.env.DEMO_NAME ?? 'demo';
const server = new McpServer(
    { name, version: '1.0.0' },
    { instructions: `${name}: a demo server. Its tools do nothing useful.` }
);

server.registerTool(
    'echo',
    { description: 'Return the text you pass in, unchanged.', inputSchema: { text: z.string().describe('Anything at all') } },
    async ({ text }) => ({ content: [{ type: 'text', text: `${name}: ${text}` }] })
);

server.registerTool(
    'add',
    { description: 'Add two numbers.', inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] })
);

server.registerTool(
    'now',
    { description: 'The current time, in ISO 8601.', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: new Date().toISOString() }] })
);

await server.connect(new StdioServerTransport());
