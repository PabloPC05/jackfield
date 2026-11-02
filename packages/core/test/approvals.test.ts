import assert from 'node:assert/strict';
import { createServer, type Server as NodeServer } from 'node:http';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '../dist/index.js';
import { startStubUpstream, type StubUpstream } from './helpers.ts';

let stub: StubUpstream;
let running: RunningServer;
let hook: NodeServer;
let notifications: { event?: string; link?: string; tool?: string }[] = [];

const KEY = 'approval-key-0123456789abcdef';
const PASS = 'la-frase-secreta';

/** Waits for the notifier to deliver an approval link. */
async function waitForLink(): Promise<string> {
    for (let attempt = 0; attempt < 120; attempt++) {
        const found = notifications.find(entry => entry.event === 'approval' && entry.link);
        if (found?.link) return found.link;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('no approval link arrived');
}

before(async () => {
    stub = await startStubUpstream('alpha');

    hook = createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            try {
                notifications.push(JSON.parse(body));
            } catch {
                /* ignore */
            }
            res.writeHead(204);
            res.end();
        });
    });
    hook.listen(0, '127.0.0.1');
    await once(hook, 'listening');
    const hookAddress = hook.address();
    const hookPort = typeof hookAddress === 'object' && hookAddress ? hookAddress.port : 0;

    // The public URL has to be known before the server starts, so pick the port.
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const probeAddress = probe.address();
    const port = typeof probeAddress === 'object' && probeAddress ? probeAddress.port : 0;
    probe.close();
    await once(probe, 'close');

    const { config } = parseConfig(`
server:
  host: 127.0.0.1
  port: ${port}
  logLevel: silent
approvals:
  publicUrl: http://127.0.0.1:${port}
  timeoutMs: 20000
  passphrase: ${PASS}
notify:
  kind: webhook
  url: http://127.0.0.1:${hookPort}/hook
  events: [denied]
permissions:
  - tools: ["alpha.remove"]
    action: ask
    via: link
    reason: it deletes things
upstreams:
  alpha:
    transport: http
    url: ${stub.url}
clients:
  agent:
    key: ${KEY}
`);

    running = await serve({ gateway: new Gateway({ config, logger: nullLogger }), warmUp: true, logger: nullLogger });
});

after(async () => {
    await running?.close();
    await stub?.close();
    hook?.closeAllConnections();
    hook?.close();
});

/** A client with no elicitation capability: nobody is watching its window. */
async function connect(): Promise<Client> {
    const client = new Client({ name: 'unattended-agent', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
        })
    );
    return client;
}

async function decide(link: string, decision: 'approve' | 'reject', passphrase = PASS): Promise<Response> {
    return fetch(link, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ decision, passphrase })
    });
}

/**
 * Approval outside the conversation. The agent is the thing being approved,
 * so the answer must come from somewhere it cannot reach.
 */
describe('approving out of band', () => {
    it('sends a link to the notifier and holds the call until someone decides', async () => {
        notifications = [];
        const client = await connect();
        const call = client.callTool({ name: 'alpha_remove', arguments: { what: 'the database' } });

        const link = await waitForLink();
        assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/approve\/[A-Za-z0-9_-]{20,}$/);

        const page = await fetch(link);
        const html = await page.text();
        assert.equal(page.status, 200);
        assert.match(html, /Approve this call\?/);
        assert.match(html, /alpha_remove/);
        assert.match(html, /the database/);
        assert.match(html, /it deletes things/);
        assert.match(html, /unattended-agent|agent/);

        const answered = await decide(link, 'approve');
        assert.equal(answered.status, 200);

        const result = await call;
        assert.notEqual(result.isError, true);
        assert.match(JSON.stringify(result.content), /removed the database/);
        await client.close();
    });

    it('never puts the link in anything the agent can read', async () => {
        notifications = [];
        const client = await connect();
        const call = client.callTool({ name: 'alpha_remove', arguments: { what: 'something' } });
        const link = await waitForLink();
        const token = link.split('/').pop() ?? '';

        await decide(link, 'reject');
        const result = await call;

        assert.equal(result.isError, true);
        assert.equal(JSON.stringify(result).includes(token), false, 'the token must not reach the agent');
        assert.match(JSON.stringify(result.content), /rejected by the user/);
        await client.close();
    });

    it('does not run the tool when it is rejected', async () => {
        notifications = [];
        const before = stub.calls.filter(call => call.tool === 'remove').length;
        const client = await connect();
        const call = client.callTool({ name: 'alpha_remove', arguments: { what: 'x' } });

        await decide(await waitForLink(), 'reject');
        await call;

        assert.equal(stub.calls.filter(call => call.tool === 'remove').length, before);
        await client.close();
    });

    it('refuses the wrong passphrase and keeps the request open', async () => {
        notifications = [];
        const client = await connect();
        const call = client.callTool({ name: 'alpha_remove', arguments: { what: 'y' } });
        const link = await waitForLink();

        const wrong = await decide(link, 'approve', 'no-es-la-frase');
        assert.equal(wrong.status, 400);
        assert.match(await wrong.text(), /Wrong passphrase/);

        // Still pending, so the right passphrase still works.
        const right = await decide(link, 'approve');
        assert.equal(right.status, 200);
        const result = await call;
        assert.notEqual(result.isError, true);
        await client.close();
    });

    it('works once: a reused link cannot decide again', async () => {
        notifications = [];
        const client = await connect();
        const call = client.callTool({ name: 'alpha_remove', arguments: { what: 'z' } });
        const link = await waitForLink();

        await decide(link, 'approve');
        await call;

        const again = await decide(link, 'reject');
        assert.equal(again.status, 400);
        assert.match(await again.text(), /already approved/);
        await client.close();
    });

    it('answers an unknown link with 404 and tells the visitor nothing', async () => {
        const response = await fetch(`${running.url}/approve/${'a'.repeat(43)}`);
        const html = await response.text();

        assert.equal(response.status, 404);
        assert.match(html, /not valid/i);
        assert.doesNotMatch(html, /alpha|remove/);
    });
});
