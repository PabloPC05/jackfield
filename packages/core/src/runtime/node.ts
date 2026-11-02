import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';

import type { Gateway } from '../gateway/gateway.js';
import { Router } from '../http/router.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface ServeOptions {
    gateway: Gateway;
    host?: string;
    port?: number;
    logger?: Logger;
    /** Open upstream connections and build catalogs before accepting traffic. Default false. */
    warmUp?: boolean;
}

export interface RunningServer {
    url: string;
    port: number;
    router: Router;
    close(): Promise<void>;
}

/**
 * Runs the gateway on a plain Node HTTP server.
 *
 * This is the default way to run Jackfield: one process, behind whatever
 * reverse proxy you already have. The router itself is Web-standard, so the
 * same gateway can be mounted in a serverless function instead — see
 * `docs/deploying.md`. Hosting is a deployment choice here, not an
 * architectural one.
 */
export async function serve(options: ServeOptions): Promise<RunningServer> {
    const { gateway } = options;
    const logger = (options.logger ?? gateway.logger).child({ part: 'server' });
    const router = new Router({ gateway, logger });

    if (options.warmUp) {
        const statuses = await gateway.warmUp();
        const failed = statuses.filter(status => status.state === 'failed');
        logger.info('warm-up finished', {
            ready: statuses.filter(status => status.state === 'ready').length,
            failed: failed.map(status => status.id)
        });
    } else {
        // Do it in the background: binding the port should not wait on an
        // upstream that is slow to wake up.
        void gateway.warmUp().catch(error => logger.warn('warm-up failed', { error: errorMessage(error) }));
    }

    const server: NodeServer = createServer((req, res) => {
        void handleNodeRequest(router, req, res, logger);
    });
    server.keepAliveTimeout = 76_000;
    server.headersTimeout = 80_000;
    // The gateway holds streams open for as long as an agent is working.
    server.requestTimeout = 0;
    server.setTimeout(0);

    const host = options.host ?? gateway.config.server.host;
    const port = options.port ?? gateway.config.server.port;
    server.listen(port, host);
    await once(server, 'listening');
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}${gateway.config.server.basePath}`;

    return {
        url,
        port: actualPort,
        router,
        close: async () => {
            await router.close();
            server.closeIdleConnections();
            server.close();
            await once(server, 'close').catch(() => undefined);
            await gateway.close();
        }
    };
}

async function handleNodeRequest(router: Router, req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
    try {
        const request = toWebRequest(req);
        const response = await router.handle(request);
        await writeWebResponse(response, res);
    } catch (error) {
        logger.error('failed to answer a request', { error: errorMessage(error) });
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error\n');
    }
}

export function toWebRequest(req: IncomingMessage): Request {
    const host = req.headers.host ?? '127.0.0.1';
    const scheme = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
    const url = new URL(req.url ?? '/', `${scheme}://${host}`);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    return new Request(url, {
        method: req.method ?? 'GET',
        headers,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' } : {})
    } as RequestInit & { duplex?: 'half' });
}

export async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
        if (name.toLowerCase() === 'set-cookie') {
            const existing = headers[name];
            headers[name] = Array.isArray(existing) ? [...existing, value] : existing ? [existing as string, value] : [value];
        } else {
            headers[name] = value;
        }
    });
    res.writeHead(response.status, headers);

    if (!response.body) {
        res.end();
        return;
    }
    // Flush each SSE frame as it arrives: buffering would defeat keep-alive.
    await response.body.pipeTo(
        Writable.toWeb(res) as WritableStream<Uint8Array>
    ).catch(() => undefined);
}
