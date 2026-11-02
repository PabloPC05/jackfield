import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '@jackfield/core';

import { Dialer, Executor } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const demoServer = resolve(here, '../../../examples/stdio-echo-server.mjs');

const TOKEN = 'dial-in-token-0123456789abcdef';
const KEY = 'tunnel-client-key-0123456789ab';

let executor: Executor;
let dialer: Dialer;
let running: RunningServer;

async function connect(): Promise<Client> {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
        })
    );
    return client;
}

async function waitUntilAttached(gateway: Gateway): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (gateway.tunnels.isAttached('home')) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('the executor never attached');
}

let gateway: Gateway;

before(async () => {
    // The gateway: it knows an executor by name, and nothing about where it is.
    const { config } = parseConfig(`
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
executors:
  home:
    attach: true
    token: ${TOKEN}
upstreams:
  notes:
    transport: executor
    executor: home
clients:
  agent:
    key: ${KEY}
`);
    gateway = new Gateway({ config, logger: nullLogger });
    running = await serve({ gateway, logger: nullLogger });

    // The machine: it has no inbound port at all, and opens the connection.
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
    dialer = new Dialer({ executor, coreUrl: running.url, name: 'home', token: TOKEN, logger: nullLogger });
    void dialer.run();
    await waitUntilAttached(gateway);
});

after(async () => {
    dialer?.stop();
    await running?.close();
    await executor?.close();
});

/**
 * No inbound port on the executor's side. The gateway can be anywhere; the
 * machine that runs the real work only ever makes outgoing connections.
 */
describe('an executor that dials in', () => {
    it('serves its upstreams through the tunnel', async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(tool => tool.name).sort(), ['notes_add', 'notes_echo', 'notes_now']);

        const result = await client.callTool({ name: 'notes_echo', arguments: { text: 'down the tunnel' } });
        assert.match(JSON.stringify(result.content), /notes: down the tunnel/);
        await client.close();
    });

    it('handles several calls at once without serialising them', async () => {
        const client = await connect();
        const results = await Promise.all(
            ['one', 'two', 'three', 'four'].map(text => client.callTool({ name: 'notes_echo', arguments: { text } }))
        );
        assert.deepEqual(
            results.map(result => (result.content as { text: string }[])[0]?.text),
            ['notes: one', 'notes: two', 'notes: three', 'notes: four']
        );
        await client.close();
    });

    it('reports the executor in its health check', async () => {
        const response = await fetch(`${running.url}/healthz`);
        const body = (await response.json()) as { executors: { name: string }[] };
        assert.deepEqual(body.executors.map(entry => entry.name), ['home']);
    });

    it('refuses an attach with the wrong token', async () => {
        const response = await fetch(`${running.url}/executor/home/attach`, {
            headers: { Authorization: 'Bearer not-the-right-token-at-all' }
        });
        assert.equal(response.status, 401);
        await response.text();
    });

    it('refuses a name that does not dial in', async () => {
        const response = await fetch(`${running.url}/executor/elsewhere/attach`, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });
        assert.equal(response.status, 404);
        await response.text();
    });

    it('says plainly when the executor is not there', async () => {
        const client = await connect();
        await client.listTools();

        gateway.tunnels.detach('home', 'pulled for the test');
        const result = await client.callTool({ name: 'notes_echo', arguments: { text: 'nobody home' } });

        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /not attached|detached/);
        await client.close();

        // And it comes back on its own.
        await waitUntilAttached(gateway);
        const again = await connect();
        const recovered = await again.callTool({ name: 'notes_echo', arguments: { text: 'back' } });
        assert.match(JSON.stringify(recovered.content), /notes: back/);
        await again.close();
    });
});
