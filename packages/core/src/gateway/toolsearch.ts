import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { Catalog } from './catalog.js';

/**
 * The two meta-tools of `expose: search` mode.
 *
 * Some clients load every tool definition into the first prompt of every turn.
 * With a few hundred tools that is a six-figure token bill before the agent has
 * done anything. Clients that fetch definitions on demand do not need this;
 * for the rest, the gateway shows two tools and keeps the catalogue on the
 * server side, which is the one trick in this area with published evidence
 * behind it (RAG-MCP, MCP-Zero).
 */
export const FIND_TOOL = 'find_tool';
export const CALL_TOOL = 'call_tool';

export function metaToolNames(catalog: Catalog): { find: string; call: string } {
    const find = catalog.byName.has(FIND_TOOL) ? `jackfield_${FIND_TOOL}` : FIND_TOOL;
    const call = catalog.byName.has(CALL_TOOL) ? `jackfield_${CALL_TOOL}` : CALL_TOOL;
    return { find, call };
}

export function metaToolDefinitions(catalog: Catalog, upstreamIds: string[]): Tool[] {
    const { find, call } = metaToolNames(catalog);
    const groups = upstreamIds.join(', ');
    return [
        {
            name: find,
            title: 'Find a tool',
            description:
                `Search the tools behind this gateway and get their full input schemas. ` +
                `${catalog.tools.length} tools are available, grouped by source: ${groups}. ` +
                `Search before concluding that something cannot be done, then call it with ${call}.`,
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What you want to do, in words. Names, verbs and the source work: "send email", "github issues".'
                    },
                    limit: { type: 'integer', minimum: 1, maximum: 25, default: 5 },
                    source: { type: 'string', description: `Restrict to one source. One of: ${groups}.` }
                },
                required: ['query']
            },
            annotations: { readOnlyHint: true, openWorldHint: false }
        },
        {
            name: call,
            title: 'Call a tool',
            description: `Call a tool found with ${find}, by its exact name. Arguments must match the schema that ${find} returned.`,
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: `Exact tool name from ${find}.` },
                    arguments: { type: 'object', description: 'Arguments for that tool.', additionalProperties: true }
                },
                required: ['name']
            }
        }
    ];
}

export interface FindToolHit {
    name: string;
    source: string;
    title?: string;
    description?: string;
    inputSchema: unknown;
    score: number;
}

export function findTools(catalog: Catalog, query: string, limit = 5, source?: string): FindToolHit[] {
    const hits = catalog.index.search(query, Math.min(Math.max(limit, 1), 25) * (source ? 6 : 1));
    const out: FindToolHit[] = [];
    for (const hit of hits) {
        const exposed = catalog.byName.get(hit.id);
        if (!exposed) continue;
        if (source && exposed.upstreamId !== source) continue;
        out.push({
            name: exposed.name,
            source: exposed.upstreamId,
            ...(exposed.tool.title ? { title: exposed.tool.title } : {}),
            ...(exposed.tool.description ? { description: exposed.tool.description } : {}),
            inputSchema: exposed.tool.inputSchema,
            score: Math.round(hit.score * 1000) / 1000
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** Names close to a mistyped one, so a wrong call gets a useful answer. */
export function suggestNames(catalog: Catalog, name: string, limit = 5): string[] {
    const direct = catalog.index.search(name.replace(/[._-]/g, ' '), limit).map(hit => hit.id);
    if (direct.length) return direct;
    return catalog.tools
        .map(exposed => exposed.name)
        .filter(candidate => candidate.includes(name) || name.includes(candidate))
        .slice(0, limit);
}
