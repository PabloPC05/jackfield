import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ConfigError, parseConfig, redact, resolveUpstreamSelectors } from '../dist/index.js';

describe('configuration', () => {
    it('resolves secrets from the environment and from files', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'jackfield-'));
        await writeFile(join(dir, 'token'), 'file-token-value-0123456789\n');

        const { config } = parseConfig(
            `
upstreams:
  one:
    transport: http
    url: https://example.com/mcp
    token: \${file:token}
    headers:
      X-From-Env: \${env:JACKFIELD_TEST_VALUE}
clients:
  agent:
    key: a-key-long-enough-to-pass
`,
            { baseDir: dir, env: { JACKFIELD_TEST_VALUE: 'from-env' } }
        );

        const upstream = config.upstreams['one'];
        assert.equal(upstream?.transport, 'http');
        assert.equal(upstream?.transport === 'http' ? upstream.token : undefined, 'file-token-value-0123456789');
        assert.equal(upstream?.transport === 'http' ? upstream.headers?.['X-From-Env'] : undefined, 'from-env');
    });

    it('keeps resolved secrets out of log output', () => {
        parseConfig(`
clients:
  agent:
    key: a-very-secret-key-value-123456
`);
        assert.equal(redact('the key is a-very-secret-key-value-123456'), 'the key is «redacted»');
    });

    it('refuses a missing secret rather than starting without it', () => {
        assert.throws(
            () =>
                parseConfig(
                    `
upstreams:
  one:
    transport: http
    url: https://example.com/mcp
    token: \${env:DEFINITELY_NOT_SET_12345}
`,
                    { env: {} }
                ),
            ConfigError
        );
    });

    it('allows an optional secret to be absent', () => {
        const { config } = parseConfig(
            `
upstreams:
  one:
    transport: http
    url: https://example.com/mcp
    token: \${env?:DEFINITELY_NOT_SET_12345}
`,
            { env: {} }
        );
        assert.equal(config.upstreams['one']?.transport === 'http' ? config.upstreams['one']?.token : 'x', '');
    });

    it('rejects two clients sharing a key', () => {
        assert.throws(
            () =>
                parseConfig(`
clients:
  one:
    key: the-same-key-for-both-0001
  two:
    key: the-same-key-for-both-0001
`),
            /shares a key/
        );
    });

    it('rejects a client with no way to authenticate', () => {
        assert.throws(() => parseConfig('clients:\n  one: {}\n'), /needs a key/);
    });

    it('rejects a reference to an upstream that does not exist', () => {
        assert.throws(
            () =>
                parseConfig(`
upstreams:
  real:
    transport: http
    url: https://example.com/mcp
clients:
  one:
    key: a-key-long-enough-to-pass
    upstreams: [imaginary]
`),
            /matches no upstream/
        );
    });

    it('resolves upstream selectors by id, tag, glob and star', () => {
        const { config } = parseConfig(`
upstreams:
  mail:
    transport: http
    url: https://example.com/a
    tags: [personal]
  mail-archive:
    transport: http
    url: https://example.com/b
    tags: [personal]
  github:
    transport: http
    url: https://example.com/c
    tags: [work]
`);
        assert.deepEqual(resolveUpstreamSelectors(config, ['*']), ['mail', 'mail-archive', 'github']);
        assert.deepEqual(resolveUpstreamSelectors(config, ['tag:personal']), ['mail', 'mail-archive']);
        assert.deepEqual(resolveUpstreamSelectors(config, ['mail*']), ['mail', 'mail-archive']);
        assert.deepEqual(resolveUpstreamSelectors(config, ['github']), ['github']);
    });

    it('accumulates exclusions down the profile chain, so deny wins', () => {
        const { config } = parseConfig(`
upstreams:
  a:
    transport: http
    url: https://example.com/a
profiles:
  base:
    upstreams: ["*"]
    exclude: ["a.secret"]
  wide:
    extends: [base]
    upstreams: ["*"]
clients:
  one:
    key: a-key-long-enough-to-pass
    profile: wide
    exclude: ["a.other"]
`);
        assert.ok(config.profiles['wide']);
        assert.deepEqual(config.clients['one']?.exclude, ['a.other']);
    });
});
