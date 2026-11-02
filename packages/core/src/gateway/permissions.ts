import type { PermissionRule } from '../config/schema.js';
import { matchesGlob } from '../util/names.js';

export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionDecision {
    action: PermissionAction;
    reason?: string;
}

const STRICTNESS: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Within one list, the first matching rule wins.
 *
 * Rule order is explicit rather than most-specific-wins: a reader should be
 * able to tell what happens by reading top to bottom, which is not true of
 * specificity scoring.
 */
export function decide(rules: PermissionRule[], upstreamId: string, localName: string): PermissionDecision {
    for (const rule of rules) {
        if (rule.tools.some(glob => matchesGlob(glob, upstreamId, localName))) {
            return { action: rule.action, ...(rule.reason ? { reason: rule.reason } : {}) };
        }
    }
    return { action: 'allow' };
}

/**
 * Combines a client's rules with the global ones, taking the stricter answer.
 *
 * Not "first match across both lists": that would let a client's own `ask`
 * rule override a global `deny`, which turns the global list into a default
 * instead of a floor. The global rules are a floor — a client can tighten, and
 * never loosen.
 */
export function decideLayered(
    clientRules: PermissionRule[],
    globalRules: PermissionRule[],
    upstreamId: string,
    localName: string
): PermissionDecision {
    const own = decide(clientRules, upstreamId, localName);
    const global = decide(globalRules, upstreamId, localName);
    return STRICTNESS[own.action] >= STRICTNESS[global.action] ? own : global;
}

/** A short, readable summary of a call, for a confirmation prompt or a log. */
export function describeCall(toolName: string, args: unknown, maxLength = 400): string {
    let rendered: string;
    try {
        rendered = JSON.stringify(args ?? {}, null, 1)?.replace(/\n\s*/g, ' ') ?? '{}';
    } catch {
        rendered = '(arguments could not be shown)';
    }
    if (rendered.length > maxLength) rendered = `${rendered.slice(0, maxLength)}…`;
    return `${toolName} ${rendered}`;
}
