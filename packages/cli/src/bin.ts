#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { ConfigError } from '@jackfield/core';

import { commandCheck, commandInit, commandKeygen, commandRoutes, commandServe, commandTools } from './commands.js';

const USAGE = `jackfield — one MCP endpoint for every agent you use

Usage: jackfield <command> [options]

Commands:
  serve                 Run the gateway
  check                 Validate the config and connect to every upstream
  tools                 List what a client would see, with its size
  routes                Print the URL and key each client needs
  keygen                Generate a key
  init                  Write a starter config file

Options:
  -c, --config <path>   Config file (default: ./jackfield.yaml, then $JACKFIELD_CONFIG)
      --host <host>     Override the listen address (serve)
      --port <port>     Override the listen port (serve)
      --warm            Connect to every upstream before accepting traffic (serve)
      --log-level <l>   debug | info | warn | error | silent (serve)
      --client <id>     Which client to report on (tools)
      --by-source       Group by upstream and show the token cost (tools)
      --json            Machine-readable output (check, tools)
      --public-url <u>  Base URL to print (routes)
      --bytes <n>       Key length in bytes, default 32 (keygen)
      --count <n>       How many keys to generate (keygen)
      --force           Overwrite an existing file (init)
  -h, --help            Show this
  -v, --version         Show the version
`;

async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            config: { type: 'string', short: 'c' },
            host: { type: 'string' },
            port: { type: 'string' },
            warm: { type: 'boolean' },
            'log-level': { type: 'string' },
            client: { type: 'string' },
            'by-source': { type: 'boolean' },
            json: { type: 'boolean' },
            'public-url': { type: 'string' },
            bytes: { type: 'string' },
            count: { type: 'string' },
            force: { type: 'boolean' },
            help: { type: 'boolean', short: 'h' },
            version: { type: 'boolean', short: 'v' }
        }
    });

    if (values.version) {
        process.stdout.write('0.1.0\n');
        return 0;
    }

    const command = positionals[0];
    if (values.help || !command) {
        process.stdout.write(USAGE);
        return command ? 0 : 1;
    }

    const config = values.config;
    const number = (value: string | undefined, what: string): number | undefined => {
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`--${what} must be a number`);
        return parsed;
    };

    switch (command) {
        case 'serve':
            await commandServe({
                ...(config ? { config } : {}),
                ...(values.host ? { host: values.host } : {}),
                ...(number(values.port, 'port') !== undefined ? { port: number(values.port, 'port') as number } : {}),
                ...(values.warm ? { warm: true } : {}),
                ...(values['log-level'] ? { logLevel: values['log-level'] } : {})
            });
            return 0;
        case 'check':
            return commandCheck({ ...(config ? { config } : {}), ...(values.json ? { json: true } : {}) });
        case 'tools':
            await commandTools({
                ...(config ? { config } : {}),
                ...(values.client ? { client: values.client } : {}),
                ...(values.json ? { json: true } : {}),
                ...(values['by-source'] ? { bySource: true } : {})
            });
            return 0;
        case 'routes':
            await commandRoutes({
                ...(config ? { config } : {}),
                ...(values['public-url'] ? { publicUrl: values['public-url'] } : {})
            });
            return 0;
        case 'keygen':
            commandKeygen({
                ...(number(values.bytes, 'bytes') !== undefined ? { bytes: number(values.bytes, 'bytes') as number } : {}),
                ...(number(values.count, 'count') !== undefined ? { count: number(values.count, 'count') as number } : {})
            });
            return 0;
        case 'init':
            await commandInit({ ...(config ? { config } : {}), ...(values.force ? { force: true } : {}) });
            return 0;
        default:
            process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
            return 1;
    }
}

main(process.argv.slice(2))
    .then(code => {
        if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
        if (error instanceof ConfigError) {
            process.stderr.write(`${error.message}\n`);
        } else if (error instanceof Error) {
            process.stderr.write(`${error.message}\n`);
        } else {
            process.stderr.write(`${String(error)}\n`);
        }
        process.exitCode = 1;
    });
