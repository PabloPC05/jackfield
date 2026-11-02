import type { NotifyConfig } from '../config/schema.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { matchesGlob } from '../util/names.js';

export type NotifyEvent = 'call' | 'result' | 'asked' | 'denied' | 'error' | 'approval';

export interface NotifyPayload {
    event: NotifyEvent;
    client: string;
    tool: string;
    upstream: string;
    detail?: string;
    /** An approval link. Sent to the notifier and to nowhere else. */
    link?: string;
}

/**
 * Sends a line somewhere when something sensitive happens.
 *
 * Fire and forget, by design: a notifier that is slow or down must never delay
 * or fail a tool call. The point is that you find out an agent deleted
 * something, not that the gateway refuses to work when ntfy is unreachable.
 */
export class Notifier {
    constructor(
        private readonly config: NotifyConfig | undefined,
        private readonly logger: Logger
    ) {}

    get enabled(): boolean {
        return Boolean(this.config);
    }

    /** Whether a tool is one of the sensitive ones. */
    watches(upstreamId: string, localName: string): boolean {
        if (!this.config) return false;
        return this.config.tools.some(glob => matchesGlob(glob, upstreamId, localName));
    }

    send(payload: NotifyPayload): void {
        const config = this.config;
        if (!config) return;
        // An approval link is the whole point of asking out of band, so it is
        // sent whatever `events` says: a configuration that swallowed it would
        // leave a call waiting for a link nobody ever got.
        if (payload.event !== 'approval' && !config.events.includes(payload.event)) return;

        const title = `${config.title}: ${payload.event}`;
        const body =
            `${payload.client} → ${payload.tool} (${payload.upstream})` +
            (payload.detail ? `\n${payload.detail}` : '') +
            (payload.link ? `\n\nDecide: ${payload.link}` : '');

        const headers: Record<string, string> = {};
        if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

        const request =
            config.kind === 'ntfy'
                ? fetch(config.url, {
                      method: 'POST',
                      headers: {
                          ...headers,
                          Title: title,
                          Priority:
                              payload.event === 'approval'
                                  ? 'urgent'
                                  : payload.event === 'denied' || payload.event === 'error'
                                    ? 'high'
                                    : 'default',
                          Tags: payload.event
                      },
                      body,
                      signal: AbortSignal.timeout(5000)
                  })
                : fetch(config.url, {
                      method: 'POST',
                      headers: { ...headers, 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ...payload, title, at: new Date().toISOString() }),
                      signal: AbortSignal.timeout(5000)
                  });

        void request.catch(error => this.logger.debug('notification failed', { error: errorMessage(error) }));
    }
}
