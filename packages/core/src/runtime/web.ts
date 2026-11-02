import { Gateway } from '../gateway/gateway.js';
import { Router } from '../http/router.js';
import { loadConfig, parseConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import { createLogger, type Logger } from '../util/logger.js';

export interface WebHandlerOptions {
    /** A ready config, a path to one, or the text of one. Exactly one. */
    config?: Config;
    configPath?: string;
    configText?: string;
    logger?: Logger;
    /**
     * Force stateless mode. Serverless platforms need it: nothing in one
     * invocation survives into the next, so there is no session to resume.
     */
    stateless?: boolean;
    /** Called once, with the gateway, the first time a request arrives. */
    onReady?: (gateway: Gateway) => void;
}

export type WebHandler = (request: Request) => Promise<Response>;

/**
 * Builds a `fetch`-style handler: `(Request) => Response`.
 *
 * This is the whole adapter for every host that speaks Web standards —
 * serverless functions, Cloudflare Workers, Deno, Bun, Hono. The gateway is
 * built on the first request and reused for as long as the process lives, so a
 * warm instance costs nothing extra.
 *
 * Hosting is a choice here, not a constraint on the design: what a given host
 * cannot do (child processes, long streams) is served by a Jackfield executor
 * on a machine that can, and the config says so in two lines.
 */
export function createWebHandler(options: WebHandlerOptions): WebHandler {
    let ready: Promise<Router> | undefined;

    const build = async (): Promise<Router> => {
        const config = await resolveConfig(options);
        if (options.stateless) config.server.stateless = true;
        const logger =
            options.logger ?? createLogger({ level: config.server.logLevel, format: 'json' });
        const gateway = new Gateway({ config, logger });
        options.onReady?.(gateway);
        return new Router({ gateway, logger });
    };

    return async (request: Request): Promise<Response> => {
        ready ??= build();
        const router = await ready;
        return router.handle(request);
    };
}

async function resolveConfig(options: WebHandlerOptions): Promise<Config> {
    if (options.config) return structuredClone(options.config);
    if (options.configText) return parseConfig(options.configText).config;
    if (options.configPath) return (await loadConfig(options.configPath)).config;
    throw new Error('createWebHandler needs config, configPath or configText');
}
