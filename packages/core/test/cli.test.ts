import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { Gateway, nullLogger, parseConfig, serve, type RunningServer } from '../dist/index.js';

let running: RunningServer;
const KEY = 'cli-key-0123456789abcdef0000';

before(async () => {
    const { config } = parseConfig(`
server:
  host: 127.0.0.1
  port: 0
  logLevel: silent
upstreams:
  shell:
    transport: cli
    commandTimeoutMs: 4000
    maxOutputBytes: 2000
    commands:
      say:
        description: "Print its arguments. Example: args ['hello']."
        executable: echo
      node:
        description: "Run node. Example: args ['-e', 'console.log(1+1)']."
        executable: node
        allowedSubcommands: ["-e", "--version"]
        deniedArgs: ["--experimental-vm-modules"]
      nothing:
        description: A program that does not exist
        executable: definitely-not-a-real-program-xyz
clients:
  agent:
    key: ${KEY}
`);
    running = await serve({ gateway: new Gateway({ config, logger: nullLogger }), warmUp: true, logger: nullLogger });
});

after(async () => {
    await running?.close();
});

async function connect(): Promise<Client> {
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
        new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
            requestInit: { headers: { Authorization: `Bearer ${KEY}` } }
        })
    );
    return client;
}

function text(result: { content?: unknown }): string {
    return ((result.content as { text?: string }[]) ?? []).map(block => block.text ?? '').join('\n');
}

/**
 * One tool per command instead of a hundred per service. The tests pin down
 * the safety properties, which are the reason this is acceptable at all.
 */
describe('commands as tools', () => {
    it('exposes one tool per configured command', async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(tool => tool.name).sort(), ['shell_node', 'shell_nothing', 'shell_say']);
        await client.close();
    });

    it('runs a command and returns its output', async () => {
        const client = await connect();
        const result = await client.callTool({ name: 'shell_say', arguments: { args: ['hello', 'there'] } });
        assert.equal(text(result).trim(), 'hello there');
        await client.close();
    });

    it('does not give arguments to a shell', async () => {
        const client = await connect();
        // With a shell this would run `id`; without one it is just text.
        const result = await client.callTool({ name: 'shell_say', arguments: { args: ['$(id)', '`id`', ';id'] } });
        const output = text(result);

        assert.match(output, /\$\(id\)/);
        assert.doesNotMatch(output, /uid=\d+/);
        await client.close();
    });

    it('enforces the subcommand allow-list', async () => {
        const client = await connect();
        const result = await client.callTool({ name: 'shell_node', arguments: { args: ['--eval', 'console.log(1)'] } });

        assert.equal(result.isError, true);
        assert.match(text(result), /first argument must be one of: -e, --version/);
        await client.close();
    });

    it('allows what the allow-list permits', async () => {
        const client = await connect();
        const result = await client.callTool({ name: 'shell_node', arguments: { args: ['-e', 'console.log(2+2)'] } });
        assert.equal(text(result).trim(), '4');
        await client.close();
    });

    it('refuses a denied argument', async () => {
        const client = await connect();
        const result = await client.callTool({
            name: 'shell_node',
            arguments: { args: ['-e', 'console.log(1)', '--experimental-vm-modules'] }
        });

        assert.equal(result.isError, true);
        assert.match(text(result), /is not allowed here/);
        await client.close();
    });

    it('caps the output instead of filling the context window', async () => {
        const client = await connect();
        const result = await client.callTool({
            name: 'shell_node',
            arguments: { args: ['-e', "process.stdout.write('y'.repeat(50000))"] }
        });

        const output = text(result);
        assert.ok(output.length < 10_000, `expected capped output, got ${output.length}`);
        assert.match(output, /stdout cut: \d+ more bytes/);
        await client.close();
    });

    it('kills a command that outlives its time limit', async () => {
        const client = await connect();
        const result = await client.callTool({
            name: 'shell_node',
            arguments: { args: ['-e', 'setTimeout(() => {}, 60000)'] }
        });

        assert.equal(result.isError, true);
        assert.match(text(result), /killed by SIGKILL after 4000 ms/);
        await client.close();
    });

    it('reports a missing program as a tool error, not a crash', async () => {
        const client = await connect();
        const result = await client.callTool({ name: 'shell_nothing', arguments: { args: [] } });

        assert.equal(result.isError, true);
        assert.match(text(result), /could not run definitely-not-a-real-program-xyz/);
        await client.close();
    });

    it('reports a non-zero exit code as an error', async () => {
        const client = await connect();
        const result = await client.callTool({ name: 'shell_node', arguments: { args: ['-e', 'process.exit(3)'] } });

        assert.equal(result.isError, true);
        assert.match(text(result), /exit 3/);
        await client.close();
    });
});
