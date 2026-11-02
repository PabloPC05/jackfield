import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../config/schema.js';
import { Bm25Index } from '../util/bm25.js';
import type { Logger } from '../util/logger.js';
import { joinName, matchesGlob, sanitizeSegment, shortHash } from '../util/names.js';
import type { UpstreamPool } from '../upstream/pool.js';
import type { UpstreamTool } from '../upstream/types.js';
import type { Selection } from './selection.js';

/** A tool as the agent sees it, with the way back to the upstream that owns it. */
export interface ExposedTool {
    /** Name the agent calls. */
    name: string;
    tool: Tool;
    upstreamId: string;
    /** Name to send upstream. */
    wireName: string;
}

export interface Catalog {
    tools: ExposedTool[];
    byName: Map<string, ExposedTool>;
    /** Upstreams that were selected but could not be reached. */
    unavailable: { id: string; error?: string }[];
    index: Bm25Index;
    instructions?: string;
    builtAt: number;
}

export interface BuildCatalogOptions {
    config: Config;
    pool: UpstreamPool;
    selection: Selection;
    logger: Logger;
}

/**
 * Reads every selected upstream and turns their tools into one flat namespace.
 *
 * Collisions are the interesting part: two upstreams both offering `search`
 * must not shadow each other silently. With `prefix: always` they never
 * collide; with `auto` only the shared names get prefixed; with `never` the
 * first upstream in config order wins and the loser is renamed rather than
 * dropped, because a missing tool is harder to notice than an odd name.
 */
export async function buildCatalog(options: BuildCatalogOptions): Promise<Catalog> {
    const { pool, selection, logger } = options;
    const unavailable: { id: string; error?: string }[] = [];
    const perUpstream: UpstreamTool[][] = [];

    for (const id of selection.upstreamIds) {
        const connection = pool.get(id);
        if (!connection) continue;
        try {
            const tools = await connection.listTools();
            if (connection.status.state === 'failed') {
                unavailable.push({ id, ...(connection.status.error ? { error: connection.status.error } : {}) });
            }
            perUpstream.push(tools);
        } catch (error) {
            unavailable.push({ id, error: error instanceof Error ? error.message : String(error) });
            logger.warn('upstream excluded from catalog', { upstream: id });
        }
    }

    const selected = perUpstream.flat().filter(entry => keepTool(entry, selection));
    const nameCounts = new Map<string, number>();
    for (const entry of selected) nameCounts.set(entry.localName, (nameCounts.get(entry.localName) ?? 0) + 1);

    const tools: ExposedTool[] = [];
    const byName = new Map<string, ExposedTool>();

    for (const entry of selected) {
        const shouldPrefix =
            selection.prefix === 'always' || (selection.prefix === 'auto' && (nameCounts.get(entry.localName) ?? 0) > 1);
        const prefix = sanitizeSegment(options.config.upstreams[entry.upstreamId]?.prefix ?? entry.upstreamId);
        let name = shouldPrefix ? joinName(prefix, selection.separator, entry.localName) : entry.localName;

        if (byName.has(name)) {
            // Last resort: keep both, make the second one findable.
            name = joinName(prefix, selection.separator, `${entry.localName}_${shortHash(entry.upstreamId + entry.localName)}`);
            logger.warn('tool name collision resolved by suffix', { upstream: entry.upstreamId, tool: entry.localName, name });
        }

        const exposed: ExposedTool = {
            name,
            upstreamId: entry.upstreamId,
            wireName: entry.wireName,
            tool: { ...entry.tool, name }
        };
        tools.push(exposed);
        byName.set(name, exposed);
    }

    const index = new Bm25Index(
        tools.map(exposed => ({
            id: exposed.name,
            fields: [
                { text: exposed.name, weight: 3 },
                { text: exposed.upstreamId, weight: 2 },
                { text: exposed.tool.title ?? '', weight: 2 },
                { text: exposed.tool.description ?? '', weight: 1 }
            ]
        }))
    );

    return {
        tools,
        byName,
        unavailable,
        index,
        ...(buildInstructions(options, unavailable) ? { instructions: buildInstructions(options, unavailable) } : {}),
        builtAt: Date.now()
    };
}

function keepTool(entry: UpstreamTool, selection: Selection): boolean {
    if (selection.include.length && !selection.include.some(glob => matchesGlob(glob, entry.upstreamId, entry.localName))) {
        return false;
    }
    if (selection.exclude.some(glob => matchesGlob(glob, entry.upstreamId, entry.localName))) return false;
    return true;
}

function buildInstructions(options: BuildCatalogOptions, unavailable: { id: string }[]): string | undefined {
    const parts: string[] = [];
    if (options.selection.instructions) parts.push(options.selection.instructions);
    for (const id of options.selection.upstreamIds) {
        const text = options.pool.get(id)?.serverInstructions?.trim();
        if (text) parts.push(`## ${id}\n\n${text}`);
    }
    if (unavailable.length) {
        parts.push(`Not reachable right now: ${unavailable.map(entry => entry.id).join(', ')}. Their tools are not listed.`);
    }
    return parts.length ? parts.join('\n\n') : undefined;
}

/** Tools listed to the agent, given the exposure mode. */
export function visibleTools(catalog: Catalog, selection: Selection): ExposedTool[] {
    if (selection.expose === 'all') return catalog.tools;
    return catalog.tools.filter(exposed =>
        selection.alwaysExpose.some(glob => matchesGlob(glob, exposed.upstreamId, stripPrefix(exposed, selection)))
    );
}

function stripPrefix(exposed: ExposedTool, selection: Selection): string {
    const head = `${exposed.upstreamId}${selection.separator}`;
    return exposed.name.startsWith(head) ? exposed.name.slice(head.length) : exposed.name;
}
