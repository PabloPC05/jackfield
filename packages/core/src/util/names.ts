/**
 * Tool, resource and prompt naming.
 *
 * Every upstream is free to name a tool `search`, so the gateway has to make
 * the names unique before an agent sees them. The MCP tool-name format allows
 * `A-Za-z0-9_.-` and up to 128 characters, which is the budget a prefix spends.
 */

export const MAX_TOOL_NAME_LENGTH = 128;
const ALLOWED = /^[A-Za-z0-9_.-]+$/;

export type PrefixMode =
    /** Always prefix: `github_list_issues`. Predictable, what most gateways do. */
    | 'always'
    /** Never prefix: names pass through and collisions are resolved by priority. */
    | 'never'
    /** Prefix only the names that two or more upstreams share. */
    | 'auto';

/** Makes an upstream id safe to use as part of a tool name. */
export function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[._-]+/, '');
    return cleaned.length > 0 ? cleaned : 'x';
}

export function isValidToolName(name: string): boolean {
    return name.length >= 1 && name.length <= MAX_TOOL_NAME_LENGTH && ALLOWED.test(name);
}

/**
 * Joins a prefix and a name, trimming the *name* (never the prefix) if the
 * result would exceed the 128-character budget. A trimmed name keeps a short
 * hash so two long names that share a head do not collapse into one.
 */
export function joinName(prefix: string, separator: string, name: string): string {
    const head = `${prefix}${separator}`;
    const full = `${head}${name}`;
    if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
    const room = MAX_TOOL_NAME_LENGTH - head.length - 5;
    if (room <= 0) return full.slice(0, MAX_TOOL_NAME_LENGTH);
    return `${head}${name.slice(0, room)}_${shortHash(name)}`;
}

/** A 4-character stable hash, enough to separate names inside one gateway. */
export function shortHash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36).slice(0, 4).padStart(4, '0');
}

/**
 * Matches a name against a glob of the form `upstream.tool`, `upstream.*`,
 * `*`, or a bare `tool`. Only `*` is special, and it does not cross the dot
 * unless it is the whole segment.
 */
export function matchesGlob(glob: string, upstreamId: string, localName: string): boolean {
    if (glob === '*' || glob === '**') return true;
    const dot = glob.indexOf('.');
    if (dot === -1) return globSegment(glob, localName);
    const [left, right] = [glob.slice(0, dot), glob.slice(dot + 1)];
    return globSegment(left, upstreamId) && globSegment(right, localName);
}

function globSegment(pattern: string, value: string): boolean {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return pattern === value;
    const parts = pattern.split('*').map(escapeRegExp);
    return new RegExp(`^${parts.join('.*')}$`).test(value);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
