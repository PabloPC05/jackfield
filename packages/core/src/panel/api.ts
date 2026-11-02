import type { Document } from 'yaml';

import type { Gateway } from '../gateway/gateway.js';
import type { Config } from '../config/schema.js';
import { ConfigError, errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { ConfigWriter, newKey } from './writer.js';

/**
 * What the panel can do.
 *
 * The shape on purpose mirrors how you think about this: there are *servers*
 * you have connected once, and there are *addresses* — one per AI — and the
 * only interesting operation is deciding which servers an address carries.
 * Everything else is naming and keys.
 */

export interface ServerView {
    id: string;
    kind: string;
    description?: string;
    state: string;
    toolCount: number;
    error?: string;
    /** An OAuth server nobody has logged in to yet. */
    needsLogin?: boolean;
}

export interface EndpointView {
    id: string;
    description?: string;
    /** `all`: everything, now and in future. `pick`: a chosen list. */
    mode: 'all' | 'pick';
    servers: { id: string; on: boolean }[];
    key?: string;
    keyInPath: boolean;
    expose: 'all' | 'search';
    enabled: boolean;
    url: string;
    urlWithKey?: string;
    toolCount: number;
}

export interface PanelState {
    writable: boolean;
    readOnlyReason?: string;
    configPath: string;
    servers: ServerView[];
    endpoints: EndpointView[];
}

export interface PanelApiOptions {
    gateway: Gateway;
    writer?: ConfigWriter;
    logger: Logger;
    /** Public base URL, for the addresses shown to copy. */
    publicUrl: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class PanelApi {
    constructor(private readonly options: PanelApiOptions) {}

    private get config(): Config {
        return this.options.gateway.config;
    }

    async state(): Promise<PanelState> {
        const gateway = this.options.gateway;
        const statuses = new Map(gateway.upstreamStatuses().map(status => [status.id, status]));

        const servers: ServerView[] = Object.entries(this.config.upstreams).map(([id, upstream]) => {
            const status = statuses.get(id);
            const oauth = (upstream.transport === 'http' || upstream.transport === 'sse') && upstream.oauth;
            return {
                id,
                kind: upstream.transport,
                ...(upstream.description ? { description: upstream.description } : {}),
                state: status?.state ?? 'idle',
                toolCount: status?.toolCount ?? 0,
                ...(status?.error ? { error: status.error } : {}),
                ...(oauth && status?.state === 'failed' ? { needsLogin: true } : {})
            };
        });

        const base = this.options.publicUrl.replace(/\/+$/, '') + this.config.server.basePath;
        const endpoints: EndpointView[] = [];

        for (const [id, client] of Object.entries(this.config.clients)) {
            const selection = (() => {
                try {
                    return gateway.selectionFor(id);
                } catch {
                    return undefined;
                }
            })();
            const explicit = client.upstreams && !client.upstreams.includes('*');
            const chosen = new Set(selection?.upstreamIds ?? []);
            // An address that carries everything turns a server off with an
            // exclusion rather than by dropping it, so the switch has to read
            // both to say what is actually reaching the agent.
            const excluded = new Set((selection?.exclude ?? []).map(glob => glob.replace(/\.\*$/, '')));

            let toolCount = 0;
            try {
                toolCount = (await gateway.getCatalog(id)).tools.length;
            } catch {
                toolCount = 0;
            }

            endpoints.push({
                id,
                ...(client.description ? { description: client.description } : {}),
                mode: explicit ? 'pick' : 'all',
                servers: Object.keys(this.config.upstreams).map(serverId => ({
                    id: serverId,
                    on: chosen.has(serverId) && !excluded.has(serverId)
                })),
                ...(client.key ? { key: client.key } : {}),
                keyInPath: client.keyInPath,
                expose: selection?.expose ?? 'all',
                enabled: client.enabled,
                url: `${base}/mcp`,
                ...(client.keyInPath && client.key ? { urlWithKey: `${base}/k/${client.key}/mcp` } : {}),
                toolCount
            });
        }

        const writer = this.options.writer;
        const writable = writer ? await writer.writable() : false;

        return {
            writable,
            ...(writer
                ? writable
                    ? {}
                    : { readOnlyReason: 'The configuration file cannot be written here. On a read-only host the panel can only show.' }
                : { readOnlyReason: 'The gateway was started without a configuration file, so there is nothing to write.' }),
            configPath: writer?.path ?? '(none)',
            servers,
            endpoints
        };
    }

    // --- changes -----------------------------------------------------------

    private get writer(): ConfigWriter {
        const writer = this.options.writer;
        if (!writer) throw new ConfigError('this gateway has no configuration file to edit');
        return writer;
    }

    private async apply(change: (document: Document) => void): Promise<PanelState> {
        const config = await this.writer.mutate(change);
        await this.options.gateway.reload(config);
        return this.state();
    }

    async addServer(input: {
        id: string;
        kind: 'http' | 'stdio' | 'cli';
        description?: string;
        url?: string;
        token?: string;
        oauth?: boolean;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
    }): Promise<PanelState> {
        if (!ID.test(input.id)) {
            throw new ConfigError('the name can have lowercase letters, digits, dashes and underscores');
        }
        if (this.config.upstreams[input.id]) throw new ConfigError(`there is already a server called "${input.id}"`);

        const definition: Record<string, unknown> = { transport: input.kind };
        if (input.description) definition['description'] = input.description;

        if (input.kind === 'http') {
            if (!input.url) throw new ConfigError('an address is needed');
            try {
                new URL(input.url);
            } catch {
                throw new ConfigError(`"${input.url}" is not a valid address`);
            }
            definition['url'] = input.url;
            if (input.oauth) definition['oauth'] = {};
            else if (input.token) definition['token'] = input.token;
        } else if (input.kind === 'stdio') {
            if (!input.command) throw new ConfigError('a command is needed');
            definition['command'] = input.command;
            if (input.args?.length) definition['args'] = input.args;
            if (input.env && Object.keys(input.env).length) definition['env'] = input.env;
        } else {
            throw new ConfigError('that kind of server is set up in the file, not here');
        }

        return this.apply(document => {
            document.setIn(['upstreams', input.id], document.createNode(definition));
        });
    }

    async removeServer(id: string): Promise<PanelState> {
        if (!this.config.upstreams[id]) throw new ConfigError(`there is no server called "${id}"`);
        return this.apply(document => {
            document.deleteIn(['upstreams', id]);
            // Leave no dangling references behind.
            for (const clientId of Object.keys(this.config.clients)) {
                const list = document.getIn(['clients', clientId, 'upstreams']) as { toJSON?: () => string[] } | undefined;
                const current = (list?.toJSON?.() ?? []) as string[];
                if (current.includes(id)) {
                    document.setIn(
                        ['clients', clientId, 'upstreams'],
                        document.createNode(current.filter(entry => entry !== id))
                    );
                }
                const excludes = (document.getIn(['clients', clientId, 'exclude']) as { toJSON?: () => string[] } | undefined)?.toJSON?.() ?? [];
                const cleaned = (excludes as string[]).filter(entry => entry !== `${id}.*`);
                if (cleaned.length !== excludes.length) {
                    if (cleaned.length) document.setIn(['clients', clientId, 'exclude'], document.createNode(cleaned));
                    else document.deleteIn(['clients', clientId, 'exclude']);
                }
            }
        });
    }

    async addEndpoint(input: { id: string; description?: string; mode: 'all' | 'pick'; servers?: string[]; keyInPath?: boolean }): Promise<PanelState> {
        if (!ID.test(input.id)) {
            throw new ConfigError('the name can have lowercase letters, digits, dashes and underscores');
        }
        if (this.config.clients[input.id]) throw new ConfigError(`there is already an address called "${input.id}"`);

        const definition: Record<string, unknown> = { key: newKey() };
        if (input.description) definition['description'] = input.description;
        if (input.keyInPath) definition['keyInPath'] = true;
        definition['upstreams'] = input.mode === 'all' ? ['*'] : (input.servers ?? []);

        return this.apply(document => {
            if (!document.hasIn(['clients'])) document.setIn(['clients'], document.createNode({}));
            document.setIn(['clients', input.id], document.createNode(definition));
        });
    }

    async removeEndpoint(id: string): Promise<PanelState> {
        if (!this.config.clients[id]) throw new ConfigError(`there is no address called "${id}"`);
        return this.apply(document => document.deleteIn(['clients', id]));
    }

    /**
     * The button this whole thing exists for.
     *
     * An address set to "everything" keeps meaning everything — turning a
     * server off adds an exception, so a server you connect tomorrow still
     * arrives. An address with a chosen list just gains or loses an entry.
     */
    async toggle(endpointId: string, serverId: string, on: boolean): Promise<PanelState> {
        const client = this.config.clients[endpointId];
        if (!client) throw new ConfigError(`there is no address called "${endpointId}"`);
        if (!this.config.upstreams[serverId]) throw new ConfigError(`there is no server called "${serverId}"`);

        const explicit = client.upstreams && !client.upstreams.includes('*');

        return this.apply(document => {
            if (explicit) {
                const current = new Set(client.upstreams ?? []);
                if (on) current.add(serverId);
                else current.delete(serverId);
                document.setIn(
                    ['clients', endpointId, 'upstreams'],
                    document.createNode(Object.keys(this.config.upstreams).filter(id => current.has(id)))
                );
                return;
            }

            const excludes = new Set(client.exclude ?? []);
            if (on) excludes.delete(`${serverId}.*`);
            else excludes.add(`${serverId}.*`);

            if (excludes.size) document.setIn(['clients', endpointId, 'exclude'], document.createNode([...excludes]));
            else document.deleteIn(['clients', endpointId, 'exclude']);
        });
    }

    async updateEndpoint(
        id: string,
        changes: { description?: string; expose?: 'all' | 'search'; enabled?: boolean; keyInPath?: boolean; mode?: 'all' | 'pick' }
    ): Promise<PanelState> {
        const client = this.config.clients[id];
        if (!client) throw new ConfigError(`there is no address called "${id}"`);

        return this.apply(document => {
            if (changes.description !== undefined) {
                if (changes.description) document.setIn(['clients', id, 'description'], changes.description);
                else document.deleteIn(['clients', id, 'description']);
            }
            if (changes.expose) document.setIn(['clients', id, 'expose'], changes.expose);
            if (changes.enabled !== undefined) document.setIn(['clients', id, 'enabled'], changes.enabled);
            if (changes.keyInPath !== undefined) {
                if (changes.keyInPath) document.setIn(['clients', id, 'keyInPath'], true);
                else document.deleteIn(['clients', id, 'keyInPath']);
            }
            if (changes.mode) {
                const selection = this.options.gateway.selectionFor(id);
                document.setIn(
                    ['clients', id, 'upstreams'],
                    document.createNode(changes.mode === 'all' ? ['*'] : selection.upstreamIds)
                );
                if (changes.mode === 'pick') document.deleteIn(['clients', id, 'exclude']);
            }
        });
    }

    async rotateKey(id: string): Promise<PanelState> {
        if (!this.config.clients[id]) throw new ConfigError(`there is no address called "${id}"`);
        return this.apply(document => document.setIn(['clients', id, 'key'], newKey()));
    }

    /** Routes one `/panel/api/...` request. */
    async handle(request: Request, path: string): Promise<Response> {
        const json = async <T>(): Promise<T> => (await request.json()) as T;

        try {
            if (path === '/state' && request.method === 'GET') return Response.json(await this.state());

            if (path === '/servers' && request.method === 'POST') {
                return Response.json(await this.addServer(await json()));
            }
            const server = /^\/servers\/([a-z0-9_-]+)$/.exec(path);
            if (server?.[1] && request.method === 'DELETE') {
                return Response.json(await this.removeServer(server[1]));
            }

            if (path === '/endpoints' && request.method === 'POST') {
                return Response.json(await this.addEndpoint(await json()));
            }
            const endpoint = /^\/endpoints\/([a-z0-9_-]+)$/.exec(path);
            if (endpoint?.[1]) {
                if (request.method === 'DELETE') return Response.json(await this.removeEndpoint(endpoint[1]));
                if (request.method === 'PATCH') return Response.json(await this.updateEndpoint(endpoint[1], await json()));
            }
            const toggle = /^\/endpoints\/([a-z0-9_-]+)\/toggle$/.exec(path);
            if (toggle?.[1] && request.method === 'POST') {
                const body = await json<{ server: string; on: boolean }>();
                return Response.json(await this.toggle(toggle[1], body.server, body.on));
            }
            const key = /^\/endpoints\/([a-z0-9_-]+)\/key$/.exec(path);
            if (key?.[1] && request.method === 'POST') {
                return Response.json(await this.rotateKey(key[1]));
            }

            return Response.json({ error: 'not found' }, { status: 404 });
        } catch (error) {
            const message = error instanceof ConfigError ? error.message : errorMessage(error);
            this.options.logger.warn('panel change refused', { error: message });
            return Response.json({ error: message }, { status: 400 });
        }
    }
}
