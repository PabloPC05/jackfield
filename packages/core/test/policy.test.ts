import assert from 'node:assert/strict';
import { createServer, type Server as NodeServer } from 'node:http';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '../dist/index.js';
import { startStubUpstream, type StubUpstream } from './helpers.ts';

let stub: StubUpstream;
let running: RunningServer;
let hook: NodeServer;
let received: Record<string, unknown>[] = [];

const KEY = 'policy-key-0123456789abcdef0';
const KEY_STRICT = 'strict-key-0123456789abcdef0';

before(async () => {
    stub = await startStubUpstream('alpha');

    hook = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            try {
                received.push(JSON.parse(body));
            } catch {
                received.push({ raw: body });
            }
            res.writeHead(204);
            res.end();
        });
    });
    hook.listen(0, '127.0.0.1');
    await once(hook, 'listening');
    const address = hook.address();
    const hookPort = typeof address === 'object' && address ? address.port : 0;

    const { config } = parseConfig(`
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
defaults:
  limits:
    maxResponseBytes: 8000
notify:
  kind: webhook
  url: http://127.0.0.1:${hookPort}/hook
  tools: ["alpha.remove"]
  events: [call, result, denied, asked, error]
permissions:
  - tools: ["alpha.search"]
    action: deny
    reason: use the other search
upstreams:
  alpha:
    transport: http
    url: ${stub.url}
    limits:
      maxResponseBytes: 8000
    tools:
      override:
        echo:
          title: Say it back
          description: A description written by the gateway, not by the server.
          annotations:
            readOnlyHint: true
clients:
  agent:
    key: ${KEY}
    upstreams: [alpha]
    permissions:
      - tools: ["alpha.remove"]
        action: ask
        reason: it deletes things
  strict:
    key: ${KEY_STRICT}
    upstreams: [alpha]
    permissions:
      - tools: ["alpha.*"]
        action: ask
`);

    running = await serve({ gateway: new Gateway({ config, logger: nullLogger }), warmUp: true, logger: nullLogger });
});

after(async () => {
    await running?.close();
    await stub?.close();
    hook?.closeAllConnections();
    hook?.close();
});

async function connect(key: string, answer?: 'accept' | 'decline'): Promise<Client> {
    const client = new Client(
        { name: 'test-agent', version: '1.0.0' },
        { capabilities: answer ? { elicitation: {} } : {} }
    );
    if (answer) {
        client.setRequestHandler(ElicitRequestSchema, async () =>
            answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' }
        );
    }
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${key}` } }
        })
    );
    return client;
}

describe('rewriting what the agent reads', () => {
    it('replaces the title, description and hints without touching the server', async () => {
        const client = await connect(KEY);
        const { tools } = await client.listTools();
        const echo = tools.find(tool => tool.name === 'alpha_echo');

        assert.equal(echo?.title, 'Say it back');
        assert.equal(echo?.description, 'A description written by the gateway, not by the server.');
        assert.equal(echo?.annotations?.readOnlyHint, true);
        await client.close();
    });

    it('leaves the input schema alone, because that is the server contract', async () => {
        const client = await connect(KEY);
        const { tools } = await client.listTools();
        const echo = tools.find(tool => tool.name === 'alpha_echo');
        assert.deepEqual(Object.keys((echo?.inputSchema as { properties: object }).properties), ['text']);
        await client.close();
    });
});

describe('response limits', () => {
    it('trims an oversized result and says how much it cut', async () => {
        const client = await connect(KEY);
        const result = await client.callTool({ name: 'alpha_big', arguments: { kb: 200 } });
        const text = (result.content as { text: string }[])[0]?.text ?? '';

        assert.ok(text.length < 20_000, `expected a trimmed result, got ${text.length} characters`);
        assert.match(text, /trimmed by the gateway: \d+ more characters/);
        await client.close();
    });

    it('passes a small result through untouched', async () => {
        const client = await connect(KEY);
        const result = await client.callTool({ name: 'alpha_echo', arguments: { text: 'short' } });
        assert.equal((result.content as { text: string }[])[0]?.text, 'alpha:short');
        await client.close();
    });
});

describe('permission rules', () => {
    it('refuses a denied tool and gives the reason', async () => {
        const client = await connect(KEY);
        const result = await client.callTool({ name: 'alpha_search', arguments: { query: 'x' } });

        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /use the other search/);
        await client.close();
    });

    it('runs an ask tool once the user approves', async () => {
        const client = await connect(KEY, 'accept');
        const result = await client.callTool({ name: 'alpha_remove', arguments: { what: 'a file' } });

        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /removed a file/);
        await client.close();
    });

    it('does not run it when the user declines', async () => {
        const before = stub.calls.filter(call => call.tool === 'remove').length;
        const client = await connect(KEY, 'decline');
        const result = await client.callTool({ name: 'alpha_remove', arguments: { what: 'a file' } });

        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /not approved/);
        assert.equal(stub.calls.filter(call => call.tool === 'remove').length, before);
        await client.close();
    });

    it('refuses rather than waving it through when the client cannot ask', async () => {
        const client = await connect(KEY_STRICT);
        const result = await client.callTool({ name: 'alpha_echo', arguments: { text: 'hi' } });

        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /cannot show a confirmation form/);
        await client.close();
    });

    it('lets a client tighten a global rule but not loosen it', async () => {
        const client = await connect(KEY_STRICT, 'accept');

        // The client's own rule says `ask` for every alpha tool, and it would
        // approve. The global rule says `deny` for alpha.search. The stricter
        // answer wins, so the global list is a floor and not a default.
        const denied = await client.callTool({ name: 'alpha_search', arguments: { query: 'x' } });
        assert.equal(denied.isError, true);
        assert.match(JSON.stringify(denied.content), /use the other search/);

        // Its own rule still tightens everything else: echo is allowed globally
        // but this client has to approve it.
        const asked = await client.callTool({ name: 'alpha_echo', arguments: { text: 'hi' } });
        assert.equal(asked.isError, undefined);
        assert.match(JSON.stringify(asked.content), /alpha:hi/);
        await client.close();
    });
});

describe('notifications', () => {
    it('reports a watched call and its result', async () => {
        received = [];
        const client = await connect(KEY, 'accept');
        await client.callTool({ name: 'alpha_remove', arguments: { what: 'something' } });
        await new Promise(resolve => setTimeout(resolve, 300));

        const events = received.map(entry => entry['event']);
        assert.ok(events.includes('asked'), `expected an asked event, got ${events.join(', ')}`);
        assert.ok(events.includes('call'));
        assert.ok(events.includes('result'));
        assert.equal(received[0]?.['client'], 'agent');
        await client.close();
    });

    it('says nothing about tools it was not told to watch', async () => {
        received = [];
        const client = await connect(KEY);
        await client.callTool({ name: 'alpha_echo', arguments: { text: 'quiet' } });
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.deepEqual(received, []);
        await client.close();
    });
});
