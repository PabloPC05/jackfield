import { createServer, type Server as NodeServer } from 'node:http';
import { once } from 'node:events';

import { errorMessage, toWebRequest, writeWebResponse, type Logger } from '@jackfield/core';

import { Executor } from './executor.js';

export interface ServeExecutorOptions {
    executor: Executor;
    host: string;
    port: number;
    logger: Logger;
}

export interface RunningExecutor {
    url: string;
    port: number;
    close(): Promise<void>;
}

export async function serveExecutor(options: ServeExecutorOptions): Promise<RunningExecutor> {
    const { executor, logger } = options;

    const server: NodeServer = createServer((req, res) => {
        void (async () => {
            const response = await executor.handle(toWebRequest(req));
            await writeWebResponse(response, res);
        })().catch(async error => {
            logger.error('failed to answer a request', { error: errorMessage(error) });
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('internal error\n');
        });
    });
    server.requestTimeout = 0;
    server.setTimeout(0);
    server.keepAliveTimeout = 76_000;
    server.headersTimeout = 80_000;

    server.listen(options.port, options.host);
    await once(server, 'listening');
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : options.port;

    return {
        url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
        port,
        close: async () => {
            await executor.close();
            server.closeIdleConnections();
            server.close();
            await once(server, 'close').catch(() => undefined);
        }
    };
}
