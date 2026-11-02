import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '@jackfield/core';

import { Executor, serveExecutor, type RunningExecutor } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const demoServer = resolve(here, '../../../examples/stdio-echo-server.mjs');

const TOKEN = 'executor-token-0123456789abcdef';
const KEY = 'core-client-key-0123456789abcdef';

let executor: Executor;
let runningExecutor: RunningExecutor;
let runningCore: RunningServer;

before(async () => {
    // A machine of mine, running a child process no serverless core could.
    const executorConfig = parseConfig(`
server:
  logLevel: silent
upstreams:
  notes:
    transport: stdio
    command: node
    args: ["${demoServer}"]
    env:
      DEMO_NAME: notes
`).config;

    executor = new Executor({ config: executorConfig, token: TOKEN, logger: nullLogger });
    runningExecutor = await serveExecutor({ executor, host: '127.0.0.1', port: 0, logger: nullLogger });

    // The core: it knows nothing about child processes.
    const coreConfig = parseConfig(`
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
executors:
  home:
    url: ${runningExecutor.url}
    token: ${TOKEN}
upstreams:
  notes:
    transport: executor
    executor: home
clients:
  agent:
    key: ${KEY}
    upstreams: [notes]
`).config;

    runningCore = await serve({ gateway: new Gateway({ config: coreConfig, logger: nullLogger }), warmUp: true, logger: nullLogger });
});

after(async () => {
    await runningCore?.close();
    await runningExecutor?.close();
});

describe('a core that cannot run processes, and an executor that can', () => {
    it('serves the executor-hosted tools as if they were local', async () => {
        const client = new Client({ name: 'test-agent', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${runningCore.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
            })
        );

        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(tool => tool.name).sort(), ['notes_add', 'notes_echo', 'notes_now']);

        const result = await client.callTool({ name: 'notes_echo', arguments: { text: 'through two hops' } });
        assert.match(JSON.stringify(result.content), /notes: through two hops/);
        await client.close();
    });

    it('prefixes the name exactly once, at the core', async () => {
        const client = new Client({ name: 'test-agent', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${runningCore.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
            })
        );
        const { tools } = await client.listTools();
        assert.equal(tools.some(tool => tool.name.includes('notes_notes')), false);
        await client.close();
    });

    it('refuses a request without the executor token', async () => {
        const response = await fetch(`${runningExecutor.url}/upstream/notes/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        });
        assert.equal(response.status, 401);
    });

    it('refuses an upstream it does not serve', async () => {
        const response = await fetch(`${runningExecutor.url}/upstream/nope/mcp`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(response.status, 404);
    });

    it('answers its own health check without a token', async () => {
        const response = await fetch(`${runningExecutor.url}/healthz`);
        const body = (await response.json()) as { ok: boolean; upstreams: string[] };
        assert.equal(body.ok, true);
        assert.deepEqual(body.upstreams, ['notes']);
    });
});
