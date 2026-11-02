import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Logger } from '../util/logger.js';

/**
 * Approvals that happen outside the conversation.
 *
 * The problem with asking the agent's own client is that the agent is the
 * thing being approved. A client that renders the form is fine when a person
 * is watching it; an unattended agent, or one whose client cannot show forms,
 * is not. So the gateway can instead mint a one-time link, hand it to a
 * notifier — never to the agent — and block the call until a human opens it.
 *
 * The agent is told that approval was requested and never learns the token, so
 * it cannot approve itself even if it wanted to.
 */

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
    id: string;
    /** The secret in the URL. Never logged, never returned to the agent. */
    token: string;
    client: string;
    tool: string;
    upstream: string;
    /** A short rendering of the arguments, for the person deciding. */
    summary: string;
    reason?: string;
    createdAt: number;
    expiresAt: number;
    state: ApprovalState;
}

export interface ApprovalOptions {
    /** Public base URL of the gateway, as a person would reach it. */
    publicUrl?: string;
    /** How long a link stays valid. */
    timeoutMs: number;
    /** Extra secret the page asks for, on top of holding the link. */
    passphrase?: string;
    logger: Logger;
}

export interface ApprovalRequest {
    client: string;
    tool: string;
    upstream: string;
    summary: string;
    reason?: string;
    timeoutMs?: number;
}

export interface PendingApproval {
    approval: Approval;
    /** The URL to send to a human. Not for the agent. */
    url: string;
    /** Resolves when someone decides, or when it expires. */
    settled: Promise<ApprovalState>;
}

export class ApprovalStore {
    private readonly byToken = new Map<string, Approval>();
    private readonly waiters = new Map<string, (state: ApprovalState) => void>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(private readonly options: ApprovalOptions) {}

    get configured(): boolean {
        return Boolean(this.options.publicUrl);
    }

    get wantsPassphrase(): boolean {
        return Boolean(this.options.passphrase);
    }

    create(request: ApprovalRequest): PendingApproval {
        const token = randomBytes(32).toString('base64url');
        const timeoutMs = request.timeoutMs ?? this.options.timeoutMs;
        const approval: Approval = {
            id: randomUUID(),
            token,
            client: request.client,
            tool: request.tool,
            upstream: request.upstream,
            summary: request.summary,
            ...(request.reason ? { reason: request.reason } : {}),
            createdAt: Date.now(),
            expiresAt: Date.now() + timeoutMs,
            state: 'pending'
        };
        this.byToken.set(token, approval);

        const settled = new Promise<ApprovalState>(resolve => {
            this.waiters.set(token, resolve);
            const timer = setTimeout(() => {
                if (approval.state === 'pending') approval.state = 'expired';
                this.finish(token, approval.state);
            }, timeoutMs);
            timer.unref?.();
            this.timers.set(token, timer);
        });

        this.options.logger.info('approval requested', {
            id: approval.id,
            client: approval.client,
            tool: approval.tool,
            expiresInMs: timeoutMs
        });

        const base = (this.options.publicUrl ?? '').replace(/\/+$/, '');
        return { approval, url: `${base}/approve/${token}`, settled };
    }

    /** Looks a token up in constant time, so the store cannot be probed. */
    find(token: string): Approval | undefined {
        let found: Approval | undefined;
        for (const [known, approval] of this.byToken) {
            if (known.length === token.length && timingSafeEqual(Buffer.from(known), Buffer.from(token))) {
                found = approval;
            }
        }
        if (found && found.state === 'pending' && found.expiresAt <= Date.now()) {
            found.state = 'expired';
            this.finish(found.token, 'expired');
        }
        return found;
    }

    decide(token: string, decision: 'approved' | 'rejected', passphrase?: string): { ok: boolean; why?: string; approval?: Approval } {
        const approval = this.find(token);
        if (!approval) return { ok: false, why: 'This link is not valid.' };
        if (approval.state !== 'pending') return { ok: false, why: `This request was already ${approval.state}.`, approval };

        if (this.options.passphrase) {
            const given = passphrase ?? '';
            const expected = this.options.passphrase;
            const same =
                given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
            if (!same) return { ok: false, why: 'Wrong passphrase.', approval };
        }

        approval.state = decision;
        this.finish(token, decision);
        this.options.logger.info('approval decided', { id: approval.id, tool: approval.tool, decision });
        return { ok: true, approval };
    }

    private finish(token: string, state: ApprovalState): void {
        const resolve = this.waiters.get(token);
        this.waiters.delete(token);
        const timer = this.timers.get(token);
        if (timer) clearTimeout(timer);
        this.timers.delete(token);
        resolve?.(state);
        // Kept briefly so the page can show the outcome, then dropped.
        setTimeout(() => this.byToken.delete(token), 120_000).unref?.();
    }

    get pendingCount(): number {
        return [...this.byToken.values()].filter(approval => approval.state === 'pending').length;
    }

    clear(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        for (const [token] of this.waiters) this.waiters.get(token)?.('expired');
        this.waiters.clear();
        this.byToken.clear();
    }
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.5rem;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #fff; color: #0a0a0a; }
  main { width: min(32rem, 100%); border: 1px solid #e5e5e5; border-radius: 8px; padding: 1.5rem; }
  h1 { font-size: 1.15rem; margin: 0 0 1rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1rem; margin: 0 0 1.25rem;
    font-size: 0.9rem; }
  dt { color: #737373; }
  dd { margin: 0; font-family: ui-monospace, Menlo, monospace; word-break: break-word; }
  .args { background: #fafafa; border: 1px solid #e5e5e5; border-radius: 6px; padding: 0.7rem;
    font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; white-space: pre-wrap;
    word-break: break-word; margin: 0 0 1.25rem; }
  form { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
  input { font: inherit; padding: 0.55rem 0.7rem; border: 1px solid #d4d4d4; border-radius: 5px;
    flex: 1 1 12rem; }
  button { font: inherit; font-weight: 600; padding: 0.55rem 1.1rem; border-radius: 5px;
    border: 1px solid #0a0a0a; cursor: pointer; }
  button.yes { background: #0a0a0a; color: #fff; }
  button.no { background: transparent; color: #0a0a0a; }
  p.note { color: #737373; font-size: 0.82rem; margin: 1.25rem 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #fafafa; }
    main, .args, input { border-color: #262626; }
    .args { background: #111; }
    dt, p.note { color: #8f8f8f; }
    button { border-color: #fafafa; }
    button.yes { background: #fafafa; color: #0a0a0a; }
    button.no { color: #fafafa; }
  }
`;

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, character => {
        switch (character) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return '&#39;';
        }
    });
}

/** The page a person sees when they open an approval link. */
export function renderApprovalPage(approval: Approval, options: { wantsPassphrase: boolean; message?: string }): string {
    const settled = approval.state !== 'pending';
    const minutes = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 60_000));

    const body = settled
        ? `<p class="note">Nothing more to do here. You can close this page.</p>`
        : `<form method="post">
      ${options.wantsPassphrase ? '<input name="passphrase" type="password" placeholder="passphrase" autocomplete="current-password" required>' : ''}
      <button class="yes" name="decision" value="approve" type="submit">Approve</button>
      <button class="no" name="decision" value="reject" type="submit">Reject</button>
    </form>
    <p class="note">This link works once and expires in about ${minutes} minute${minutes === 1 ? '' : 's'}. The agent that asked cannot see it.</p>`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${settled ? `Request ${escapeHtml(approval.state)}` : 'Approve this call?'} — jackfield</title>
<style>${PAGE_STYLE}</style></head>
<body><main>
  <h1>${settled ? `Request ${escapeHtml(approval.state)}` : 'Approve this call?'}</h1>
  <dl>
    <dt>Agent</dt><dd>${escapeHtml(approval.client)}</dd>
    <dt>Tool</dt><dd>${escapeHtml(approval.tool)}</dd>
    <dt>Server</dt><dd>${escapeHtml(approval.upstream)}</dd>
    ${approval.reason ? `<dt>Why</dt><dd>${escapeHtml(approval.reason)}</dd>` : ''}
  </dl>
  <div class="args">${escapeHtml(approval.summary)}</div>
  ${options.message ? `<p class="note">${escapeHtml(options.message)}</p>` : ''}
  ${body}
</main></body></html>`;
}

export function renderApprovalMissing(): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not valid — jackfield</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>This link is not valid</h1>
<p class="note">It may have been used already, or it may have expired. Ask the agent to try again.</p>
</main></body></html>`;
}
