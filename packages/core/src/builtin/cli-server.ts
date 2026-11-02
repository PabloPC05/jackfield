import { spawn } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { CliCommandConfig } from '../config/schema.js';
import type { Logger } from '../util/logger.js';

export interface CliServerOptions {
    id: string;
    commands: Record<string, CliCommandConfig>;
    timeoutMs: number;
    maxOutputBytes: number;
    logger: Logger;
}

/**
 * A built-in MCP server that exposes a few command-line programs as tools.
 *
 * Why this exists: a service whose MCP server defines 120 tools, used twice a
 * month, costs its definitions in every single prompt. Its command line costs
 * one tool. The trade is that the agent has to read `--help`, which it is good
 * at, instead of being handed a schema it mostly ignores.
 *
 * Safety is by construction, not by filtering:
 *
 * - no shell, ever: the program is spawned with an argument array, so quoting,
 *   `;`, backticks and `$(...)` have no meaning to anything;
 * - one named command per tool, with the executable fixed in the config — the
 *   agent chooses arguments, never the program;
 * - an optional subcommand allow-list, which is the cheapest way to turn "a
 *   CLI" into "these operations of a CLI";
 * - a denied-argument list, an argument count cap, a time limit, and an output
 *   cap, so a runaway command cannot fill a context window.
 */
export function createCliServer(options: CliServerOptions): McpServer {
    const server = new McpServer(
        { name: `jackfield-cli-${options.id}`, version: '0.1.0' },
        {
            instructions:
                `Command-line tools. Each tool runs one fixed program with the arguments you pass, ` +
                `with no shell: pass arguments as a list, not as a string. Ask a program for its own ` +
                `help first if you are unsure.`
        }
    );

    for (const [name, command] of Object.entries(options.commands)) {
        const allowed = command.allowedSubcommands;
        const description =
            command.description +
            (allowed ? `\n\nAllowed first argument: ${allowed.join(', ')}.` : '') +
            `\n\nRuns \`${command.executable}\` with no shell. Arguments go in a list.`;

        server.registerTool(
            name,
            {
                description,
                inputSchema: {
                    args: z
                        .array(z.string())
                        .max(command.maxArgs)
                        .describe('Arguments, one per element. No shell quoting: pass them already split.')
                },
                annotations: { openWorldHint: true }
            },
            async ({ args }) => run(command, args ?? [], options)
        );
    }

    return server;
}

async function run(
    command: CliCommandConfig,
    args: string[],
    options: CliServerOptions
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }> {
    const refusal = check(command, args);
    if (refusal) {
        return { isError: true, content: [{ type: 'text', text: refusal }] };
    }

    const full = [...command.prefixArgs, ...args];
    const started = Date.now();

    return new Promise(resolve => {
        const child = spawn(command.executable, full, {
            cwd: command.cwd,
            env: command.env ? { PATH: process.env['PATH'] ?? '', ...command.env } : process.env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let cutStdout = 0;
        let cutStderr = 0;
        let settled = false;

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
        }, options.timeoutMs);

        // A single chunk can be larger than the whole budget, so take what
        // fits and count the rest rather than testing the total first.
        child.stdout.on('data', (chunk: Buffer) => {
            const room = options.maxOutputBytes - stdout.length;
            if (room > 0) {
                const text = chunk.toString('utf8');
                stdout += text.slice(0, room);
                cutStdout += Math.max(0, text.length - room);
            } else {
                cutStdout += chunk.length;
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            const room = options.maxOutputBytes - stderr.length;
            if (room > 0) {
                const text = chunk.toString('utf8');
                stderr += text.slice(0, room);
                cutStderr += Math.max(0, text.length - room);
            } else {
                cutStderr += chunk.length;
            }
        });

        const finish = (code: number | null, signal: string | null, error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            const ms = Date.now() - started;
            const parts: string[] = [];
            if (error) parts.push(`could not run ${command.executable}: ${error.message}`);
            if (stdout.trim()) parts.push(stdout.trimEnd());
            if (cutStdout) parts.push(`[stdout cut: ${cutStdout} more bytes]`);
            if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
            if (cutStderr) parts.push(`[stderr cut: ${cutStderr} more bytes]`);
            if (signal) parts.push(`killed by ${signal}${signal === 'SIGKILL' ? ` after ${options.timeoutMs} ms` : ''}`);
            if (!parts.length) parts.push(code === 0 ? 'done, no output' : `exit ${code}, no output`);

            options.logger.debug('cli finished', { executable: command.executable, code, signal, ms });

            resolve({
                ...(error || signal || (code !== null && code !== 0) ? { isError: true } : {}),
                content: [{ type: 'text', text: parts.join('\n\n') }],
                structuredContent: {
                    exitCode: code,
                    ...(signal ? { signal } : {}),
                    durationMs: ms
                }
            });
        };

        child.on('error', error => finish(null, null, error));
        child.on('close', (code, signal) => finish(code, signal));
    });
}

/** Returns a refusal message, or undefined when the call is allowed. */
function check(command: CliCommandConfig, args: string[]): string | undefined {
    if (args.length > command.maxArgs) {
        return `too many arguments: at most ${command.maxArgs}`;
    }
    if (command.allowedSubcommands && command.allowedSubcommands.length > 0) {
        const first = args[0];
        if (!first || !command.allowedSubcommands.includes(first)) {
            return `the first argument must be one of: ${command.allowedSubcommands.join(', ')}`;
        }
    }
    for (const denied of command.deniedArgs) {
        if (args.some(argument => argument === denied || argument.includes(denied))) {
            return `the argument "${denied}" is not allowed here`;
        }
    }
    return undefined;
}
