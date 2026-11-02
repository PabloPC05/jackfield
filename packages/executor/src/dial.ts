import { errorMessage, type Logger } from '@jackfield/core';

import type { Executor } from './executor.js';

/**
 * The executor's half of a dial-in tunnel.
 *
 * It opens one long-lived stream to the gateway and serves whatever comes down
 * it, so the machine it runs on needs no inbound port, no port forward and no
 * place on a private network. Responses are streamed back chunk by chunk,
 * which is what lets a server behind the tunnel hold an SSE stream open and
 * ask the agent a question through it.
 *
 * It reconnects on its own, with backoff: a gateway restart, a dropped
 * connection or a laptop that slept should not need anyone to notice.
 */

export interface DialOptions {
    executor: Executor;
    /** Base URL of the gateway, as this machine can reach it. */
    coreUrl: string;
    /** The name this executor has in the gateway's config. */
    name: string;
    token: string;
    logger: Logger;
    /** Largest wait between reconnection attempts. */
    maxBackoffMs?: number;
}

interface RequestFrame {
    id: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
}

export class Dialer {
    private stopped = false;
    private attempt = 0;
    private current?: AbortController;

    constructor(private readonly options: DialOptions) {}

    private get attachUrl(): string {
        return new URL(`./executor/${encodeURIComponent(this.options.name)}/attach`, ensureSlash(this.options.coreUrl)).toString();
    }

    private get replyUrl(): string {
        return new URL(`./executor/${encodeURIComponent(this.options.name)}/reply`, ensureSlash(this.options.coreUrl)).toString();
    }

    async run(): Promise<void> {
        while (!this.stopped) {
            try {
                await this.connectOnce();
                this.attempt = 0;
            } catch (error) {
                if (this.stopped) return;
                this.attempt += 1;
                const wait = Math.min(1000 * 2 ** Math.min(this.attempt, 6), this.options.maxBackoffMs ?? 30_000);
                this.options.logger.warn('tunnel dropped, retrying', {
                    error: errorMessage(error),
                    attempt: this.attempt,
                    inMs: wait
                });
                await sleep(wait);
            }
        }
    }

    private async connectOnce(): Promise<void> {
        const controller = new AbortController();
        this.current = controller;

        const response = await fetch(this.attachUrl, {
            headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'text/event-stream' },
            signal: controller.signal
        });

        if (!response.ok || !response.body) {
            throw new Error(`the gateway answered ${response.status} to the attach request`);
        }
        this.options.logger.info('attached to the gateway', { core: this.options.coreUrl, name: this.options.name });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!this.stopped) {
            const { done, value } = await reader.read();
            if (done) throw new Error('the gateway closed the tunnel');
            buffer += decoder.decode(value, { stream: true });

            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                boundary = buffer.indexOf('\n\n');

                const data = block
                    .split('\n')
                    .filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).trim())
                    .join('');
                if (!data) continue;

                let frame: RequestFrame;
                try {
                    frame = JSON.parse(data) as RequestFrame;
                } catch (error) {
                    this.options.logger.warn('unreadable tunnel frame', { error: errorMessage(error) });
                    continue;
                }
                // Served without awaiting, so one slow call cannot stall the tunnel.
                void this.serve(frame);
            }
        }
    }

    /** Runs one tunneled request locally and streams the answer back. */
    private async serve(frame: RequestFrame): Promise<void> {
        const send = async (payload: unknown) => {
            await fetch(this.replyUrl, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(error => this.options.logger.debug('reply failed', { error: errorMessage(error) }));
        };

        try {
            const request = new Request(frame.url, {
                method: frame.method,
                headers: frame.headers,
                ...(frame.body !== undefined
                    ? { body: Buffer.from(frame.body, 'base64'), duplex: 'half' }
                    : {})
            } as RequestInit & { duplex?: 'half' });

            const response = await this.options.executor.handle(request);

            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });
            await send({ id: frame.id, kind: 'head', status: response.status, headers });

            if (response.body) {
                const reader = response.body.getReader();
                let seq = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    // Sequential on purpose: replies are separate HTTP requests
                    // and the gateway must see the body in order.
                    await send({ id: frame.id, kind: 'chunk', seq: seq++, data: Buffer.from(value).toString('base64') });
                }
            }
            await send({ id: frame.id, kind: 'end' });
        } catch (error) {
            await send({ id: frame.id, kind: 'error', message: errorMessage(error) });
        }
    }

    stop(): void {
        this.stopped = true;
        this.current?.abort();
    }
}

function ensureSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}
