import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '../dist/index.js';
import { startStubUpstream, type StubUpstream } from './helpers.ts';

let alpha: StubUpstream;
let beta: StubUpstream;
let running: RunningServer;
let gateway: Gateway;

const KEY_AGENT = 'key-agent-0123456789abcdef';
const KEY_SEARCH = 'key-search-0123456789abcdef';
const KEY_NARROW = 'key-narrow-0123456789abcdef';

before(async () => {
    alpha = await startStubUpstream('alpha');
    beta = await startStubUpstream('beta');

    const { config } = parseConfig(`
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
defaults:
  prefix: always
upstreams:
  alpha:
    transport: http
    url: ${alpha.url}
    tags: [stub]
  beta:
    transport: http
    url: ${beta.url}
    tags: [stub]
    tools:
      deny: ["slow", "ask"]
profiles:
  everything:
    upstreams: ["*"]
  justalpha:
    upstreams: [alpha]
clients:
  agent:
    key: ${KEY_AGENT}
    profile: everything
  searcher:
    key: ${KEY_SEARCH}
    profile: everything
    expose: search
    alwaysExpose: ["alpha.echo"]
  narrow:
    key: ${KEY_NARROW}
    profile: justalpha
    exclude: ["alpha.search"]
`);

    gateway = new Gateway({ config, logger: nullLogger });
    running = await serve({ gateway, warmUp: true, logger: nullLogger });
});

after(async () => {
    await running?.close();
    await alpha?.close();
    await beta?.close();
});

async function connect(key: string, options: { elicit?: boolean } = {}): Promise<Client> {
    const client = new Client(
        { name: 'test-agent', version: '1.0.0' },
        { capabilities: options.elicit ? { elicitation: {} } : {} }
    );
    if (options.elicit) {
        client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { nombre: 'Pablo' } }));
    }
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } }
    });
    await client.connect(transport);
    return client;
}

describe('aggregation', () => {
    it('lists every upstream tool, prefixed by source', async () => {
        const client = await connect(KEY_AGENT);
        const { tools } = await client.listTools();
        const names = tools.map(tool => tool.name).sort();

        assert.deepEqual(names, [
            'alpha_ask',
            'alpha_big',
            'alpha_echo',
            'alpha_remove',
            'alpha_search',
            'alpha_slow',
            'beta_big',
            'beta_echo',
            'beta_remove',
            'beta_search'
        ]);
        await client.close();
    });

    it('keeps colliding names apart and routes each to its own upstream', async () => {
        const client = await connect(KEY_AGENT);
        const fromAlpha = await client.callTool({ name: 'alpha_search', arguments: { query: 'x' } });
        const fromBeta = await client.callTool({ name: 'beta_search', arguments: { query: 'x' } });

        assert.match(JSON.stringify(fromAlpha.content), /alpha searched x/);
        assert.match(JSON.stringify(fromBeta.content), /beta searched x/);
        await client.close();
    });

    it('passes through the upstreams own instructions', async () => {
        const client = await connect(KEY_AGENT);
        const instructions = client.getInstructions() ?? '';
        assert.match(instructions, /Instructions from alpha\./);
        assert.match(instructions, /Instructions from beta\./);
        await client.close();
    });

    it('honours an upstream level deny list', async () => {
        const client = await connect(KEY_AGENT);
        const { tools } = await client.listTools();
        assert.equal(tools.some(tool => tool.name === 'beta_slow'), false);
        await client.close();
    });

    it('suggests close names when a tool does not exist', async () => {
        const client = await connect(KEY_AGENT);
        await assert.rejects(
            () => client.callTool({ name: 'alpha_ehco', arguments: {} }),
            (error: Error) => /no tool named "alpha_ehco"/.test(error.message) && /alpha_echo/.test(error.message)
        );
        await client.close();
    });
});

describe('profiles', () => {
    it('gives a client only its own upstreams, minus its exclusions', async () => {
        const client = await connect(KEY_NARROW);
        const { tools } = await client.listTools();
        const names = tools.map(tool => tool.name).sort();

        assert.deepEqual(names, ['alpha_ask', 'alpha_big', 'alpha_echo', 'alpha_remove', 'alpha_slow']);
        await client.close();
    });

    it('refuses a call to a tool outside the profile', async () => {
        const client = await connect(KEY_NARROW);
        await assert.rejects(() => client.callTool({ name: 'beta_echo', arguments: { text: 'hi' } }), /no tool named "beta_echo"/);
        await client.close();
    });
});

describe('search mode', () => {
    it('shows two meta tools instead of the whole catalogue', async () => {
        const client = await connect(KEY_SEARCH);
        const { tools } = await client.listTools();
        const names = tools.map(tool => tool.name).sort();

        assert.deepEqual(names, ['alpha_echo', 'call_tool', 'find_tool']);
        assert.ok(tools.length === 3, 'search mode must not list the rest of the catalogue');
        await client.close();
    });

    it('finds a tool by description and calls it through call_tool', async () => {
        const client = await connect(KEY_SEARCH);
        const found = await client.callTool({ name: 'find_tool', arguments: { query: 'search inside beta' } });
        const matches = (found.structuredContent as { matches: { name: string }[] }).matches;
        assert.equal(matches[0]?.name, 'beta_search');

        const result = await client.callTool({ name: 'call_tool', arguments: { name: 'beta_search', arguments: { query: 'q' } } });
        assert.match(JSON.stringify(result.content), /beta searched q/);
        await client.close();
    });
});

describe('the parts other gateways drop', () => {
    it('forwards progress notifications from upstream to the agent', async () => {
        const client = await connect(KEY_AGENT);
        const seen: number[] = [];
        const result = await client.callTool(
            { name: 'alpha_slow', arguments: { steps: 4 } },
            undefined,
            { onprogress: progress => seen.push(progress.progress) }
        );

        assert.match(JSON.stringify(result.content), /done in 4/);
        assert.deepEqual(seen, [1, 2, 3, 4]);
        await client.close();
    });

    it('forwards an elicitation request to the agent and the answer back', async () => {
        const client = await connect(KEY_AGENT, { elicit: true });
        const result = await client.callTool({ name: 'alpha_ask', arguments: {} });
        assert.match(JSON.stringify(result.content), /Pablo/);
        await client.close();
    });

    it('tells an upstream plainly when the agent cannot answer a form', async () => {
        const client = await connect(KEY_AGENT);
        const result = await client.callTool({ name: 'alpha_ask', arguments: {} });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /cannot show forms/);
        await client.close();
    });
});

describe('http behaviour', () => {
    it('rejects a wrong key with 401 and says nothing else', async () => {
        const response = await fetch(`${running.url}/mcp`, {
            method: 'POST',
            headers: { Authorization: 'Bearer not-a-real-key-at-all', 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        });
        assert.equal(response.status, 401);
    });

    it('answers 404 to an unknown session so the client opens a new one', async () => {
        const response = await fetch(`${running.url}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${KEY_AGENT}`,
                'Content-Type': 'application/json',
                'Mcp-Session-Id': 'a-session-that-never-existed'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        });
        assert.equal(response.status, 404);
    });

    it('reports health without a key', async () => {
        const response = await fetch(`${running.url}/healthz`);
        const body = (await response.json()) as { ok: boolean; upstreams: { id: string; state: string }[] };
        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.deepEqual(body.upstreams.map(upstream => upstream.state), ['ready', 'ready']);
    });
});
