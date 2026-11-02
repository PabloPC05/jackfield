import type { Config } from '../config/schema.js';
import type { Logger } from '../util/logger.js';
import { UpstreamConnection } from './connection.js';
import type { DownstreamBridge, UpstreamStatus } from './types.js';

export interface PoolOptions {
    config: Config;
    /** Upstream ids this pool may open, already resolved from the client's selection. */
    upstreamIds: string[];
    logger: Logger;
    bridge: DownstreamBridge;
}

/**
 * The set of upstream connections behind one agent session.
 *
 * Connections are per session on purpose. An upstream that asks the agent a
 * question has to reach *that* agent, and the protocol gives no way to tell
 * which of several sessions an incoming server request belongs to. Sharing one
 * connection between sessions would send one agent's form to another.
 */
export class UpstreamPool {
    private readonly connections = new Map<string, UpstreamConnection>();

    constructor(private readonly options: PoolOptions) {
        const { config } = options;
        for (const id of options.upstreamIds) {
            const upstream = config.upstreams[id];
            if (!upstream || !upstream.enabled) continue;
            this.connections.set(
                id,
                new UpstreamConnection({
                    id,
                    config: upstream,
                    executors: config.executors,
                    defaults: config.defaults,
                    requestTimeoutMs: config.server.requestTimeoutMs,
                    startupTimeoutMs: config.defaults.startupTimeoutMs,
                    logger: options.logger,
                    bridge: options.bridge
                })
            );
        }
    }

    get ids(): string[] {
        return [...this.connections.keys()];
    }

    get(id: string): UpstreamConnection | undefined {
        return this.connections.get(id);
    }

    /** Opens every connection at once, tolerating failures. Used by `jackfield check`. */
    async warmUp(): Promise<UpstreamStatus[]> {
        await Promise.all([...this.connections.values()].map(connection => connection.ensureConnected().catch(() => undefined)));
        return this.statuses();
    }

    statuses(): UpstreamStatus[] {
        return [...this.connections.values()].map(connection => connection.status);
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.connections.values()].map(connection => connection.close()));
        this.connections.clear();
    }

    get bridge(): DownstreamBridge {
        return this.options.bridge;
    }
}
