import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

/**
 * Executors that dial in, so there is no port to open on your side.
 *
 * The usual shape — core calls executor — needs the executor reachable: a
 * port, a tunnel, or a private network. Reversed, the executor opens one
 * long-lived stream *outwards* to the core and the core pushes requests down
 * it; replies come back as ordinary POSTs. A laptop behind NAT, a Raspberry
 * Pi on home broadband, or a box with no inbound rules at all can then serve
 * upstreams to a gateway running anywhere.
 *
 * Responses are streamed, not buffered, so an executor-hosted server can still
 * hold an SSE stream open and ask the agent a question through it. The tunnel
 * carries whole HTTP exchanges, which means the MCP client stack above it does
 * not know it is there: it is handed a `fetch` and nothing else changes.
 */

interface TunnelRequestFrame {
    id: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    /** Base64, so a binary body survives the round trip. */
    body?: string;
}

export type ReplyFrame =
    | { id: string; kind: 'head'; status: number; headers: Record<string, string> }
    | { id: string; kind: 'chunk'; seq: number; data: string }
    | { id: string; kind: 'end' }
    | { id: string; kind: 'error'; message: string };

interface InFlight {
    controller?: ReadableStreamDefaultController<Uint8Array>;
    settle: (response: Response) => void;
    fail: (error: Error) => void;
    headSent: boolean;
    nextSeq: number;
    pending: Map<number, string>;
    timer: ReturnType<typeof setTimeout>;
}

interface Attachment {
    name: string;
    send: (frame: TunnelRequestFrame) => void;
    close: () => void;
    attachedAt: number;
    inFlight: Map<string, InFlight>;
}

export interface TunnelHubOptions {
    logger: Logger;
    /** How long a tunneled request may take before it is given up on. */
    requestTimeoutMs: number;
    /**
     * Called when an executor attaches. The catalogue cached while it was
     * away says it has no tools, and nothing else would correct that until
     * the cache expired.
     */
    onAttach?: (name: string) => void;
}

export class TunnelHub {
    private readonly attached = new Map<string, Attachment>();

    constructor(private readonly options: TunnelHubOptions) {}

    isAttached(name: string): boolean {
        return this.attached.has(name);
    }

    status(): { name: string; attachedAt: number; inFlight: number }[] {
        return [...this.attached.values()].map(entry => ({
            name: entry.name,
            attachedAt: entry.attachedAt,
            inFlight: entry.inFlight.size
        }));
    }

    /**
     * Opens the stream an executor holds. One per executor: a second
     * attachment replaces the first, so a reconnecting executor takes over
     * instead of ending up with two half-live tunnels.
     */
    attach(name: string): Response {
        this.detach(name, 'replaced by a new attachment');

        const encoder = new TextEncoder();
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let keepAlive: ReturnType<typeof setInterval> | undefined;

        const body = new ReadableStream<Uint8Array>({
            start: controller => {
                streamController = controller;
                controller.enqueue(encoder.encode(': attached\n\n'));
                keepAlive = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(': ping\n\n'));
                    } catch {
                        if (keepAlive) clearInterval(keepAlive);
                    }
                }, 15_000);
                keepAlive.unref?.();
            },
            cancel: () => {
                if (keepAlive) clearInterval(keepAlive);
                this.detach(name, 'the executor went away');
            }
        });

        const attachment: Attachment = {
            name,
            attachedAt: Date.now(),
            inFlight: new Map(),
            send: frame => {
                streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
            },
            close: () => {
                if (keepAlive) clearInterval(keepAlive);
                try {
                    streamController?.close();
                } catch {
                    /* already closed */
                }
            }
        };

        this.attached.set(name, attachment);
        this.options.logger.info('executor attached', { executor: name });
        this.options.onAttach?.(name);

        return new Response(body, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            }
        });
    }

    detach(name: string, why: string): void {
        const attachment = this.attached.get(name);
        if (!attachment) return;
        this.attached.delete(name);
        for (const [, call] of attachment.inFlight) {
            clearTimeout(call.timer);
            call.fail(new Error(`the executor detached: ${why}`));
            try {
                call.controller?.error(new Error(why));
            } catch {
                /* already gone */
            }
        }
        attachment.inFlight.clear();
        attachment.close();
        this.options.logger.info('executor detached', { executor: name, why });
    }

    /** A `fetch` that goes down the tunnel instead of over the network. */
    fetchThrough(name: string): FetchLike {
        return async (url, init) => {
            const attachment = this.attached.get(name);
            if (!attachment) {
                throw new Error(`the executor "${name}" is not attached; it dials in, so start it and it will come back`);
            }

            const id = randomUUID();
            const headers: Record<string, string> = {};
            new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => {
                // Hop-by-hop headers belong to the tunnel, not to the request.
                if (['host', 'connection', 'content-length'].includes(key.toLowerCase())) return;
                headers[key] = value;
            });

            const body = init?.body;
            const encoded =
                typeof body === 'string'
                    ? Buffer.from(body, 'utf8').toString('base64')
                    : body instanceof Uint8Array
                      ? Buffer.from(body).toString('base64')
                      : undefined;

            return new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => {
                    attachment.inFlight.delete(id);
                    reject(new Error(`the executor "${name}" did not answer in time`));
                }, this.options.requestTimeoutMs);
                timer.unref?.();

                attachment.inFlight.set(id, {
                    settle: resolve,
                    fail: reject,
                    headSent: false,
                    nextSeq: 0,
                    pending: new Map(),
                    timer
                });

                attachment.send({
                    id,
                    url: url.toString(),
                    method: init?.method ?? 'GET',
                    headers,
                    ...(encoded !== undefined ? { body: encoded } : {})
                });
            });
        };
    }

    /** Handles one reply frame coming back up from an executor. */
    reply(name: string, frame: ReplyFrame): { ok: boolean; why?: string } {
        const attachment = this.attached.get(name);
        if (!attachment) return { ok: false, why: 'not attached' };
        const call = attachment.inFlight.get(frame.id);
        if (!call) return { ok: false, why: 'no such request' };

        try {
            switch (frame.kind) {
                case 'head': {
                    if (call.headSent) return { ok: false, why: 'the head was already sent' };
                    call.headSent = true;
                    clearTimeout(call.timer);
                    const stream = new ReadableStream<Uint8Array>({
                        start: controller => {
                            call.controller = controller;
                        },
                        cancel: () => {
                            attachment.inFlight.delete(frame.id);
                        }
                    });
                    call.settle(new Response(stream, { status: frame.status, headers: frame.headers }));
                    return { ok: true };
                }
                case 'chunk': {
                    // Chunks are ordered by the executor, but a retry could
                    // still land out of order; hold them until their turn.
                    call.pending.set(frame.seq, frame.data);
                    while (call.pending.has(call.nextSeq)) {
                        const data = call.pending.get(call.nextSeq) as string;
                        call.pending.delete(call.nextSeq);
                        call.nextSeq += 1;
                        call.controller?.enqueue(new Uint8Array(Buffer.from(data, 'base64')));
                    }
                    return { ok: true };
                }
                case 'end': {
                    attachment.inFlight.delete(frame.id);
                    call.controller?.close();
                    return { ok: true };
                }
                case 'error': {
                    attachment.inFlight.delete(frame.id);
                    clearTimeout(call.timer);
                    if (!call.headSent) call.fail(new Error(frame.message));
                    else call.controller?.error(new Error(frame.message));
                    return { ok: true };
                }
            }
        } catch (error) {
            return { ok: false, why: errorMessage(error) };
        }
    }

    closeAll(): void {
        for (const name of [...this.attached.keys()]) this.detach(name, 'the gateway is shutting down');
    }
}

/** Constant-time token check, so an attach endpoint cannot be probed. */
export function tokenMatches(given: string, expected: string): boolean {
    if (given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
