import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { Gateway, login, nullLogger, parseConfig, serve, authStatus, type RunningServer } from '../dist/index.js';
import { startOAuthUpstream, type FakeOAuthUpstream } from './oauth-server.ts';

let remote: FakeOAuthUpstream;
let storeDir: string;
let redirectPort: number;
let configText: string;
const KEY = 'oauth-client-key-0123456789ab';

async function freePort(): Promise<number> {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    probe.close();
    await once(probe, 'close');
    return port;
}

before(async () => {
    remote = await startOAuthUpstream('vault');
    storeDir = await mkdtemp(join(tmpdir(), 'jackfield-oauth-'));
    redirectPort = await freePort();

    configText = `
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
auth:
  storeDir: ${storeDir}
  redirectUrl: http://127.0.0.1:${redirectPort}/callback
upstreams:
  vault:
    transport: http
    url: ${remote.mcpUrl}
    oauth:
      scope: "read write"
      clientName: Jackfield test
clients:
  agent:
    key: ${KEY}
`;
});

after(async () => {
    await remote?.close();
});

/**
 * The credentials live in the gateway, and no agent ever sees one. Logging in
 * is something an operator does once; keeping the token alive is the
 * gateway's job from then on.
 */
describe('oauth towards an upstream', () => {
    it('refuses to start a login by itself while serving', async () => {
        const { config } = parseConfig(configText);
        const running = await serve({ gateway: new Gateway({ config, logger: nullLogger }), warmUp: true, logger: nullLogger });

        const client = new Client({ name: 'agent', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
            })
        );

        // The upstream is unreachable without credentials, so it is simply absent.
        const { tools } = await client.listTools();
        assert.deepEqual(tools, []);

        // And the gateway did not go off and start an authorization flow.
        assert.equal(remote.stats.authorizations, 0);

        await client.close();
        await running.close();
    });

    it('walks the whole flow on an explicit login and stores the tokens 0600', async () => {
        const { config } = parseConfig(configText);
        const lines: string[] = [];

        // The browser, played by fetch: open the URL and follow the redirect.
        const browser = async (url: URL) => {
            const response = await fetch(url, { redirect: 'manual' });
            const location = response.headers.get('location');
            assert.ok(location, 'the authorization server should redirect back');
            await fetch(location);
        };

        const original = globalThis.setTimeout;
        void original;

        const result = await login({
            config,
            upstreamId: 'vault',
            logger: nullLogger,
            timeoutMs: 20_000,
            print: line => {
                lines.push(line);
                const found = /https?:\/\/\S+/.exec(line);
                if (found && line.includes('/authorize')) void browser(new URL(found[0]));
            }
        });

        assert.equal(result.upstreamId, 'vault');
        assert.equal(result.refreshable, true);
        assert.equal(remote.stats.registrations, 1, 'it should register itself dynamically');
        assert.equal(remote.stats.tokenGrants, 1);
        assert.equal(remote.lastScope, 'read write', 'the configured scope should be asked for');

        const file = join(storeDir, 'vault.json');
        const mode = (await stat(file)).mode & 0o777;
        assert.equal(mode, 0o600, 'credentials must not be readable by anyone else');

        const stored = JSON.parse(await readFile(file, 'utf8')) as { tokens?: { access_token?: string } };
        assert.ok(stored.tokens?.access_token);
    });

    it('reports who is logged in', async () => {
        const { config } = parseConfig(configText);
        const status = await authStatus(config, nullLogger);
        assert.deepEqual(status, [{ id: 'vault', loggedIn: true, hasRefresh: true }]);
    });

    it('serves the upstream with the stored token, without the agent seeing it', async () => {
        const { config } = parseConfig(configText);
        const running: RunningServer = await serve({
            gateway: new Gateway({ config, logger: nullLogger }),
            warmUp: true,
            logger: nullLogger
        });

        const client = new Client({ name: 'agent', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
            })
        );

        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(tool => tool.name), ['vault_whoami']);

        const result = await client.callTool({ name: 'vault_whoami', arguments: {} });
        const text = JSON.stringify(result);
        assert.match(text, /vault says hello/);

        const stored = JSON.parse(await readFile(join(storeDir, 'vault.json'), 'utf8')) as {
            tokens: { access_token: string };
        };
        assert.equal(text.includes(stored.tokens.access_token), false, 'the access token must not reach the agent');

        await client.close();
        await running.close();
    });

    it('refreshes an expired token on its own', async () => {
        const { config } = parseConfig(configText);
        const before = remote.stats.refreshes;
        remote.expireAccessTokens();

        const running = await serve({ gateway: new Gateway({ config, logger: nullLogger }), warmUp: false, logger: nullLogger });
        const client = new Client({ name: 'agent', version: '1.0.0' });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
                requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
            })
        );

        const result = await client.callTool({ name: 'vault_whoami', arguments: {} });
        assert.match(JSON.stringify(result), /vault says hello/);
        assert.ok(remote.stats.refreshes > before, 'it should have used the refresh token');

        await client.close();
        await running.close();
    });
});
