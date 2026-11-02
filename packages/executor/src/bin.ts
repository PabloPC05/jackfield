#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

import { createLogger, loadConfig } from '@jackfield/core';

import { Executor } from './executor.js';
import { serveExecutor } from './serve.js';

const USAGE = `jackfield-executor — serve the upstreams a gateway core cannot host

Usage: jackfield-executor [options]

Options:
  -c, --config <path>    Config file with the upstreams to serve (required)
      --token <value>    Shared token. Prefer --token-file.
      --token-file <p>   Read the token from a file
      --host <host>      Listen address (default 127.0.0.1)
      --port <port>      Listen port (default 8795)
      --log-level <l>    debug | info | warn | error | silent
  -h, --help             Show this

The core reaches it with:

  executors:
    home:
      url: http://<host>:<port>
      token: \${file:/path/to/token}

  upstreams:
    browser:
      transport: executor
      executor: home
`;

const { values } = parseArgs({
    options: {
        config: { type: 'string', short: 'c' },
        token: { type: 'string' },
        'token-file': { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        'log-level': { type: 'string' },
        help: { type: 'boolean', short: 'h' }
    }
});

if (values.help || !values.config) {
    process.stdout.write(USAGE);
    process.exit(values.config ? 0 : 1);
}

const token = values['token-file']
    ? readFileSync(values['token-file'], 'utf8').trim()
    : (values.token ?? process.env['JACKFIELD_EXECUTOR_TOKEN'] ?? '');

if (!token) {
    process.stderr.write('a token is required: --token-file, --token, or JACKFIELD_EXECUTOR_TOKEN\n');
    process.exit(1);
}

const { config } = await loadConfig(values.config);
const level = (values['log-level'] ?? config.server.logLevel) as 'debug' | 'info' | 'warn' | 'error' | 'silent';
const logger = createLogger({ level, format: config.server.logFormat });

const executor = new Executor({ config, token, logger });
const running = await serveExecutor({
    executor,
    host: values.host ?? config.server.host,
    port: values.port ? Number(values.port) : 8795,
    logger
});

logger.info('executor is listening', { url: running.url, upstreams: executor.upstreamIds });

const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    await running.close();
    process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
