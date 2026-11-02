import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '../dist/index.js';
import { startStubUpstream, type StubUpstream } from './helpers.ts';

let stub: StubUpstream;
let running: RunningServer;

const KEY = 'stateless-key-0123456789abcdef';

before(async () => {
    stub = await startStubUpstream('alpha');
    const { config } = parseConfig(`
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
  stateless: true
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
});

async function post(body: unknown): Promise<Response> {
    return fetch(`${running.url}/mcp`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${KEY}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
    });
}

/**
 * Stateless mode is what lets the gateway run as a serverless function. It is
 * a real mode with real limits, not a lesser one: these tests pin down both.
 */
describe('stateless mode', () => {
    it('answers initialize without handing out a session id', async () => {
        const response = await post({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } }
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('mcp-session-id'), null);
        const body = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
        assert.equal(body.result?.serverInfo?.name, 'jackfield');
    });

    it('serves a tools call in a single self-contained request', async () => {
        const response = await post({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'alpha_echo', arguments: { text: 'no session needed' } }
        });
        assert.equal(response.status, 200);
        const body = (await response.json()) as { result?: { content?: { text?: string }[] } };
        assert.match(body.result?.content?.[0]?.text ?? '', /alpha:no session needed/);
    });

    it('refuses the GET stream, because there is nowhere to stream to', async () => {
        const response = await fetch(`${running.url}/mcp`, {
            headers: { Authorization: `Bearer ${KEY}`, Accept: 'text/event-stream' }
        });
        assert.equal(response.status, 405);
        await response.text();
    });
});
