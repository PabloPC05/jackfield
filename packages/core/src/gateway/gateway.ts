import type { Config } from '../config/schema.js';
import { TunnelHub } from '../http/tunnel.js';
import { UpstreamPool } from '../upstream/pool.js';
import type { DownstreamBridge, UpstreamStatus } from '../upstream/types.js';
import { ConfigError } from '../util/errors.js';
import { createLogger, type Logger } from '../util/logger.js';
import { buildCatalog, type Catalog } from './catalog.js';
import { ApprovalStore } from './approvals.js';
import { Notifier } from './notify.js';
import { resolveSelection, type Selection } from './selection.js';
import { GatewaySession } from './session.js';

export interface GatewayOptions {
    config: Config;
    logger?: Logger;
    /** Where the configuration came from, so the panel knows what to edit. */
    configPath?: string;
}

interface CatalogEntry {
    catalog?: Catalog;
    building?: Promise<Catalog>;
    expiresAt: number;
}

/**
 * The gateway itself: configuration turned into something that can answer.
 *
 * It owns one set of upstream connections used only to read what each upstream
 * offers, and one aggregated catalog per client, cached and shared by that
 * client's sessions. Sessions own their own connections for actual calls.
 */
export class Gateway {
    private current: Config;
    readonly logger: Logger;

    private readonly selections = new Map<string, Selection>();
    private readonly catalogs = new Map<string, CatalogEntry>();
    private discovery: UpstreamPool;
    private readonly notifier: Notifier;
    readonly approvals: ApprovalStore;
    /** Executors that dial in rather than being called. */
    readonly tunnels: TunnelHub;
    private closed = false;
    /** The file this gateway was loaded from, when there was one. */
    readonly configPath: string | undefined;

    /** The configuration as it stands. Replaced wholesale by {@link reload}. */
    get config(): Config {
        return this.current;
    }

    constructor(options: GatewayOptions) {
        this.current = options.config;
        this.configPath = options.configPath;
        this.logger =
            options.logger ??
            createLogger({ level: this.config.server.logLevel, format: this.config.server.logFormat });

        this.tunnels = new TunnelHub({
            logger: this.logger.child({ part: 'tunnel' }),
            requestTimeoutMs: this.config.server.requestTimeoutMs,
            onAttach: () => this.invalidateCatalogs()
        });

        this.discovery = this.createDiscoveryPool();

        this.notifier = new Notifier(this.config.notify, this.logger.child({ part: 'notify' }));
        this.approvals = new ApprovalStore({
            ...(this.config.approvals.publicUrl ? { publicUrl: this.config.approvals.publicUrl } : {}),
            timeoutMs: this.config.approvals.timeoutMs,
            ...(this.config.approvals.passphrase ? { passphrase: this.config.approvals.passphrase } : {}),
            logger: this.logger.child({ part: 'approvals' })
        });

        this.rebuildSelections();
    }

    private createDiscoveryPool(): UpstreamPool {
        const enabled = Object.entries(this.config.upstreams)
            .filter(([, upstream]) => upstream.enabled)
            .map(([id]) => id);

        return new UpstreamPool({
            config: this.config,
            tunnelFetch: name => this.tunnels.fetchThrough(name),
            upstreamIds: enabled,
            logger: this.logger.child({ pool: 'discovery' }),
            bridge: this.createDiscoveryBridge()
        });
    }

    private rebuildSelections(): void {
        this.selections.clear();
        for (const clientId of Object.keys(this.config.clients)) {
            this.selections.set(clientId, resolveSelection(this.config, clientId));
        }
    }

    private readonly reloadListeners = new Set<(changedClients: string[]) => void>();

    /** Called after a reload with the clients whose surface changed. */
    onReload(listener: (changedClients: string[]) => void): () => void {
        this.reloadListeners.add(listener);
        return () => this.reloadListeners.delete(listener);
    }

    /**
     * Takes a new configuration without restarting.
     *
     * Conversations whose surface changed are closed on purpose: a client that
     * loses its session opens a new one by itself — the same mechanism that
     * makes a restart invisible — and comes back seeing the new set. Leaving
     * them on a stale view until they happened to reconnect is how a panel
     * ends up lying about what it just saved.
     */
    async reload(config: Config): Promise<string[]> {
        const before = new Map<string, string>();
        for (const [clientId, selection] of this.selections) before.set(clientId, fingerprint(selection));

        const previous = this.discovery;
        this.current = config;
        this.rebuildSelections();
        this.catalogs.clear();
        this.discovery = this.createDiscoveryPool();
        await previous.closeAll();

        const changed: string[] = [];
        for (const clientId of new Set([...before.keys(), ...this.selections.keys()])) {
            const now = this.selections.get(clientId);
            if (!now || before.get(clientId) !== fingerprint(now)) changed.push(clientId);
        }

        this.logger.info('configuration reloaded', { clients: this.clientIds().length, changed });
        for (const listener of this.reloadListeners) listener(changed);
        return changed;
    }

    /**
     * The bridge used while reading catalogs. It answers "no" to everything:
     * no agent is on the other side of a listing, and a server that insists on
     * asking during `tools/list` should hear that rather than hang.
     */
    private createDiscoveryBridge(): DownstreamBridge {
        const deny = (what: string) => async (): Promise<never> => {
            throw new Error(`${what} is not available while listing tools`);
        };
        return {
            capabilities: { elicitation: false, sampling: false, roots: false },
            elicitInput: deny('elicitation'),
            createMessage: deny('sampling'),
            listRoots: async () => ({ roots: [] }),
            progress: () => {},
            toolsChanged: () => this.invalidateCatalogs(),
            log: () => {}
        };
    }

    clientIds(): string[] {
        return Object.keys(this.config.clients).filter(id => this.config.clients[id]?.enabled);
    }

    selectionFor(clientId: string): Selection {
        const selection = this.selections.get(clientId);
        if (!selection) throw new ConfigError(`no client named "${clientId}"`);
        return selection;
    }

    /** Builds, or returns, the shared catalog for a client. */
    async getCatalog(clientId: string, options: { refresh?: boolean } = {}): Promise<Catalog> {
        const entry = this.catalogs.get(clientId) ?? { expiresAt: 0 };
        this.catalogs.set(clientId, entry);

        if (!options.refresh && entry.catalog && entry.expiresAt > Date.now()) return entry.catalog;
        if (entry.building) return entry.building;

        const selection = this.selectionFor(clientId);
        entry.building = buildCatalog({
            config: this.config,
            pool: this.discovery,
            selection,
            logger: this.logger.child({ client: clientId })
        })
            .then(catalog => {
                entry.catalog = catalog;
                // A catalogue missing an upstream is a catalogue that is wrong
                // as soon as that upstream comes back, so it is held briefly
                // rather than for the full term.
                const ttl = catalog.unavailable.length
                    ? Math.min(this.config.defaults.catalogTtlMs, 15_000)
                    : this.config.defaults.catalogTtlMs;
                entry.expiresAt = Date.now() + ttl;
                this.logger.debug('catalog built', {
                    client: clientId,
                    tools: catalog.tools.length,
                    unavailable: catalog.unavailable.map(item => item.id)
                });
                return catalog;
            })
            .finally(() => {
                entry.building = undefined;
            });

        return entry.building;
    }

    invalidateCatalogs(): void {
        for (const entry of this.catalogs.values()) entry.expiresAt = 0;
    }

    /** Opens connections and builds every catalog, so the first agent waits for nothing. */
    async warmUp(): Promise<UpstreamStatus[]> {
        const statuses = await this.discovery.warmUp();
        await Promise.all(this.clientIds().map(id => this.getCatalog(id, { refresh: true }).catch(() => undefined)));
        return statuses;
    }

    createSession(clientId: string): GatewaySession {
        if (this.closed) throw new Error('gateway is closed');
        const selection = this.selectionFor(clientId);
        const cached = this.catalogs.get(clientId)?.catalog;
        return new GatewaySession({
            clientId,
            config: this.config,
            selection,
            logger: this.logger,
            getCatalog: options => this.getCatalog(clientId, options ?? {}),
            notifier: this.notifier,
            approvals: this.approvals,
            tunnelFetch: name => this.tunnels.fetchThrough(name),
            ...(cached?.instructions ? { instructions: cached.instructions } : {})
        });
    }

    upstreamStatuses(): UpstreamStatus[] {
        return this.discovery.statuses();
    }

    async close(): Promise<void> {
        this.closed = true;
        this.tunnels.closeAll();
        this.approvals.clear();
        this.catalogs.clear();
        await this.discovery.closeAll();
    }
}

/** A cheap comparison of what a client is allowed to see. */
function fingerprint(selection: Selection): string {
    return JSON.stringify([
        selection.upstreamIds,
        selection.include,
        selection.exclude,
        selection.expose,
        selection.alwaysExpose,
        selection.prefix,
        selection.permissions
    ]);
}
