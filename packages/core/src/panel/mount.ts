import { timingSafeEqual } from 'node:crypto';

import type { Gateway } from '../gateway/gateway.js';
import type { Logger } from '../util/logger.js';
import { PanelApi } from './api.js';
import { renderPanel } from './ui.js';
import { ConfigWriter } from './writer.js';

const COOKIE = 'jackfield_panel';

/**
 * The panel's front door.
 *
 * Its key is its own: no agent key opens it, and it opens nothing else. You
 * arrive with the key in the address once, it moves into a cookie so it stops
 * being in your address bar, and writes additionally require a header a form
 * on another site cannot set.
 */
export class PanelMount {
    private readonly api: PanelApi | undefined;

    constructor(
        private readonly gateway: Gateway,
        private readonly logger: Logger
    ) {
        const key = gateway.config.panel.key;
        if (!key) return;

        const writer = gateway.configPath ? new ConfigWriter(gateway.configPath, logger) : undefined;
        this.api = new PanelApi({
            gateway,
            ...(writer ? { writer } : {}),
            logger: logger.child({ part: 'panel' }),
            publicUrl:
                gateway.config.panel.publicUrl ??
                gateway.config.server.publicUrl ??
                `http://${gateway.config.server.host}:${gateway.config.server.port}`
        });
    }

    get enabled(): boolean {
        return Boolean(this.api);
    }

    async handle(request: Request, path: string): Promise<Response> {
        if (!this.api) return new Response('the panel is off: give it a key in the configuration\n', { status: 404 });

        const url = new URL(request.url);
        const given = url.searchParams.get('key');
        const expected = this.gateway.config.panel.key as string;

        // Arriving with the key in the address: move it to a cookie and send
        // the visitor to a clean URL, so it is not left in history or in a
        // screenshot.
        if (given && matches(given, expected)) {
            const secure = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
            return new Response(null, {
                status: 303,
                headers: {
                    Location: url.pathname,
                    'Set-Cookie': `${COOKIE}=${encodeURIComponent(given)}; Path=${basePathOf(url.pathname)}; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`
                }
            });
        }

        if (!this.authorized(request, expected)) {
            this.logger.warn('panel: refused a visitor without the key');
            return new Response('<!DOCTYPE html><meta charset="utf-8"><title>jackfield</title><body style="font:15px system-ui;padding:2rem"><h1>Hace falta la clave</h1><p>Abre esta página con <code>?key=…</code> al final, con la clave del panel.</p>', {
                status: 401,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        if (path === '' || path === '/') {
            return new Response(renderPanel(), {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store',
                    'X-Robots-Tag': 'noindex, nofollow',
                    'Content-Security-Policy':
                        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
                }
            });
        }

        if (path.startsWith('/api/')) {
            // A page on another site can send a cross-origin POST, but it
            // cannot set this header without the browser asking us first.
            if (request.method !== 'GET' && request.headers.get('x-jackfield-panel') !== '1') {
                return Response.json({ error: 'missing panel header' }, { status: 403 });
            }
            return this.api.handle(request, path.slice('/api'.length));
        }

        return new Response('not found\n', { status: 404 });
    }

    private authorized(request: Request, expected: string): boolean {
        const header = request.headers.get('authorization') ?? '';
        const bearer = /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
        if (bearer && matches(bearer, expected)) return true;

        const cookies = request.headers.get('cookie') ?? '';
        for (const part of cookies.split(';')) {
            const [name, ...rest] = part.trim().split('=');
            if (name !== COOKIE) continue;
            if (matches(decodeURIComponent(rest.join('=')), expected)) return true;
        }
        return false;
    }
}

function matches(given: string, expected: string): boolean {
    if (given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function basePathOf(pathname: string): string {
    const index = pathname.indexOf('/panel');
    return index >= 0 ? pathname.slice(0, index) + '/panel' : '/panel';
}
