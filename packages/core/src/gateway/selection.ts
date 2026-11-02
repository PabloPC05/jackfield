import type { ClientConfig, Config, PermissionRule, ProfileConfig } from '../config/schema.js';
import { ConfigError } from '../util/errors.js';
import type { PrefixMode } from '../util/names.js';

/**
 * What one client is allowed to see, after profiles and overrides are merged.
 *
 * A profile is the reusable half (what a kind of agent gets) and the client is
 * the specific half (who it is). Keeping them separate is what makes a layered
 * setup — a small core for every agent, more for the ones that can take it —
 * expressible without repeating the whole list per client.
 */
export interface Selection {
    upstreamIds: string[];
    include: string[];
    exclude: string[];
    expose: 'all' | 'search';
    alwaysExpose: string[];
    prefix: PrefixMode;
    separator: string;
    instructions?: string;
    /**
     * Rules from this client and its profiles. The global rules in
     * `config.permissions` are applied as a floor on top of these.
     */
    permissions: PermissionRule[];
}

/** Resolves upstream selectors (`*`, `id`, `tag:name`, `glob*`) to concrete ids, in config order. */
export function resolveUpstreamSelectors(config: Config, selectors: string[] | undefined): string[] {
    const all = Object.entries(config.upstreams).filter(([, upstream]) => upstream.enabled);
    // Not saying which is "all of them". Saying "none of them" is an empty
    // list, and must stay empty: a client that was given nothing on purpose
    // should not quietly end up with everything.
    if (selectors === undefined) return all.map(([id]) => id);
    if (selectors.length === 0) return [];

    const chosen = new Set<string>();
    for (const selector of selectors) {
        if (selector === '*') {
            for (const [id] of all) chosen.add(id);
        } else if (selector.startsWith('tag:')) {
            const tag = selector.slice(4);
            for (const [id, upstream] of all) if (upstream.tags?.includes(tag)) chosen.add(id);
        } else if (selector.includes('*')) {
            const pattern = new RegExp(`^${selector.split('*').map(escapeRegExp).join('.*')}$`);
            for (const [id] of all) if (pattern.test(id)) chosen.add(id);
        } else {
            for (const [id] of all) if (id === selector) chosen.add(id);
        }
    }
    return all.map(([id]) => id).filter(id => chosen.has(id));
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Flattens a profile's `extends` chain, parents first, detecting cycles. */
function flattenProfile(config: Config, id: string, seen: string[] = []): ProfileConfig[] {
    if (seen.includes(id)) throw new ConfigError(`profiles.${id}: extends forms a cycle (${[...seen, id].join(' -> ')})`);
    const profile = config.profiles[id];
    if (!profile) throw new ConfigError(`no profile named "${id}"`);
    const out: ProfileConfig[] = [];
    for (const parent of profile.extends ?? []) out.push(...flattenProfile(config, parent, [...seen, id]));
    out.push(profile);
    return out;
}

/**
 * Merges profile chain and client overrides.
 *
 * `upstreams`, `expose` and `prefix` are replaced by the most specific layer
 * that sets them. `include`, `exclude` and `alwaysExpose` accumulate, so a
 * client can never widen what a profile denied: deny wins by construction.
 */
export function resolveSelection(config: Config, clientId: string): Selection {
    const client: ClientConfig | undefined = config.clients[clientId];
    if (!client) throw new ConfigError(`no client named "${clientId}"`);

    const layers: (ProfileConfig | ClientConfig)[] = client.profile ? flattenProfile(config, client.profile) : [];
    layers.push(client);

    let upstreams: string[] | undefined;
    let expose: 'all' | 'search' | undefined;
    let prefix: PrefixMode | undefined;
    const include: string[] = [];
    const exclude: string[] = [];
    const alwaysExpose: string[] = [];
    const instructions: string[] = [];
    const permissions: PermissionRule[] = [];

    for (const layer of layers) {
        if (layer.upstreams) upstreams = layer.upstreams;
        if (layer.expose) expose = layer.expose;
        if (layer.prefix) prefix = layer.prefix;
        if (layer.include) include.push(...layer.include);
        if (layer.exclude) exclude.push(...layer.exclude);
        if (layer.alwaysExpose) alwaysExpose.push(...layer.alwaysExpose);
        if (layer.instructions) instructions.push(layer.instructions);
        if (layer.permissions) permissions.push(...layer.permissions);
    }

    return {
        upstreamIds: resolveUpstreamSelectors(config, upstreams),
        include,
        exclude,
        alwaysExpose,
        expose: expose ?? config.defaults.expose,
        prefix: prefix ?? config.defaults.prefix,
        separator: config.defaults.separator,
        permissions,
        ...(instructions.length ? { instructions: instructions.join('\n\n') } : {})
    };
}
