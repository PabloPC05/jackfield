import type { Catalog } from '../gateway/catalog.js';
import { visibleTools } from '../gateway/catalog.js';
import type { Selection } from '../gateway/selection.js';
import type { UpstreamStatus } from '../upstream/types.js';

/**
 * A read-only view of what a client actually sees.
 *
 * Read-only on purpose. A panel that wrote configuration would move the real
 * state out of the file you can read in a diff, and the whole point of this
 * gateway is that the file is the state. This page answers the question you
 * cannot answer by reading the file — what the servers are doing right now,
 * and what this key ends up loading — and nothing else.
 */

export interface StatusView {
    client: string;
    profile?: string;
    expose: 'all' | 'search';
    sessions: number;
    pendingApprovals: number;
    executors: { name: string; inFlight: number }[];
    upstreams: UpstreamStatus[];
    unavailable: { id: string; error?: string }[];
    tools: { name: string; source: string; bytes: number; description?: string }[];
    bySource: { source: string; tools: number; bytes: number }[];
    totals: { tools: number; listed: number; bytes: number; tokens: number };
}

export function buildStatusView(options: {
    clientId: string;
    profile?: string;
    selection: Selection;
    catalog: Catalog;
    upstreams: UpstreamStatus[];
    sessions: number;
    pendingApprovals: number;
    executors: { name: string; inFlight: number }[];
}): StatusView {
    const tools = options.catalog.tools.map(exposed => ({
        name: exposed.name,
        source: exposed.upstreamId,
        bytes: Buffer.byteLength(JSON.stringify(exposed.tool), 'utf8'),
        ...(exposed.tool.description ? { description: exposed.tool.description } : {})
    }));

    const grouped = new Map<string, { tools: number; bytes: number }>();
    for (const tool of tools) {
        const entry = grouped.get(tool.source) ?? { tools: 0, bytes: 0 };
        entry.tools += 1;
        entry.bytes += tool.bytes;
        grouped.set(tool.source, entry);
    }

    const bytes = tools.reduce((sum, tool) => sum + tool.bytes, 0);
    const listed = visibleTools(options.catalog, options.selection).length + (options.selection.expose === 'search' ? 2 : 0);

    return {
        client: options.clientId,
        ...(options.profile ? { profile: options.profile } : {}),
        expose: options.selection.expose,
        sessions: options.sessions,
        pendingApprovals: options.pendingApprovals,
        executors: options.executors,
        upstreams: options.upstreams,
        unavailable: options.catalog.unavailable,
        tools,
        bySource: [...grouped.entries()]
            .map(([source, entry]) => ({ source, ...entry }))
            .sort((a, b) => b.bytes - a.bytes),
        totals: { tools: tools.length, listed, bytes, tokens: Math.round(bytes / 4) }
    };
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, character =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string
    );
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const STYLE = `
  :root { color-scheme: light dark; --ink:#0a0a0a; --dim:#737373; --line:#e5e5e5; --bg:#fff; --bg2:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --ink:#fafafa; --dim:#8f8f8f; --line:#262626; --bg:#0a0a0a; --bg2:#111; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.5rem 4rem; background:var(--bg); color:var(--ink);
    font:14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width:min(72rem,100%); margin-inline:auto; }
  h1 { font-family:ui-monospace,Menlo,monospace; font-size:1.2rem; margin:0 0 0.25rem; }
  p.sub { color:var(--dim); margin:0 0 2rem; font-size:0.9rem; }
  h2 { font-size:0.75rem; letter-spacing:0.09em; text-transform:uppercase; color:var(--dim);
    margin:2rem 0 0.6rem; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:0.85rem; }
  th,td { text-align:left; padding:0.45rem 0.9rem 0.45rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:0.7rem; letter-spacing:0.07em; text-transform:uppercase; color:var(--dim); font-weight:600; }
  td.n, th.n { text-align:right; font-family:ui-monospace,Menlo,monospace; }
  code { font-family:ui-monospace,Menlo,monospace; background:var(--bg2); padding:0.08em 0.3em; border-radius:3px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:1rem; margin-bottom:0.5rem; }
  .card { border:1px solid var(--line); border-radius:6px; padding:0.8rem 0.9rem; }
  .card .v { font-family:ui-monospace,Menlo,monospace; font-size:1.3rem; }
  .card .k { color:var(--dim); font-size:0.78rem; }
  .bad { color:#b91c1c; } @media (prefers-color-scheme: dark){ .bad { color:#f87171; } }
  details summary { cursor:pointer; color:var(--dim); font-size:0.85rem; margin-top:0.6rem; }
`;

export function renderStatusPage(view: StatusView): string {
    const upstreamRows = view.upstreams
        .map(
            status => `<tr><td><code>${escapeHtml(status.id)}</code></td><td>${escapeHtml(status.transport)}</td>
      <td class="${status.state === 'failed' ? 'bad' : ''}">${escapeHtml(status.state)}</td>
      <td class="n">${status.toolCount}</td>
      <td>${status.error ? escapeHtml(status.error) : ''}</td></tr>`
        )
        .join('');

    const sourceRows = view.bySource
        .map(
            entry => `<tr><td><code>${escapeHtml(entry.source)}</code></td>
      <td class="n">${entry.tools}</td><td class="n">${formatBytes(entry.bytes)}</td>
      <td class="n">~${Math.round(entry.bytes / 4).toLocaleString('en-US')}</td></tr>`
        )
        .join('');

    const toolRows = view.tools
        .map(
            tool => `<tr><td><code>${escapeHtml(tool.name)}</code></td><td>${escapeHtml(tool.source)}</td>
      <td class="n">${formatBytes(tool.bytes)}</td>
      <td>${escapeHtml((tool.description ?? '').split('\n')[0]?.slice(0, 110) ?? '')}</td></tr>`
        )
        .join('');

    const executorRows = view.executors.length
        ? view.executors.map(entry => `<tr><td><code>${escapeHtml(entry.name)}</code></td><td>attached</td><td class="n">${entry.inFlight}</td></tr>`).join('')
        : '';

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(view.client)} — jackfield</title><style>${STYLE}</style></head>
<body><main>
  <h1>jackfield · ${escapeHtml(view.client)}</h1>
  <p class="sub">What this key sees. Read-only: the configuration file is the state.</p>

  <div class="cards">
    <div class="card"><div class="v">${view.totals.tools}</div><div class="k">tools reachable</div></div>
    <div class="card"><div class="v">${view.totals.listed}</div><div class="k">listed (<code>${view.expose}</code>)</div></div>
    <div class="card"><div class="v">${formatBytes(view.totals.bytes)}</div><div class="k">definitions</div></div>
    <div class="card"><div class="v">~${view.totals.tokens.toLocaleString('en-US')}</div><div class="k">tokens if all loaded</div></div>
    <div class="card"><div class="v">${view.sessions}</div><div class="k">open sessions</div></div>
    <div class="card"><div class="v">${view.pendingApprovals}</div><div class="k">waiting approvals</div></div>
  </div>

  <h2>Servers</h2>
  <table><thead><tr><th>id</th><th>transport</th><th>state</th><th class="n">tools</th><th>problem</th></tr></thead>
  <tbody>${upstreamRows}</tbody></table>

  ${executorRows ? `<h2>Executors dialled in</h2><table><thead><tr><th>name</th><th>state</th><th class="n">in flight</th></tr></thead><tbody>${executorRows}</tbody></table>` : ''}

  <h2>Cost by source</h2>
  <table><thead><tr><th>source</th><th class="n">tools</th><th class="n">definitions</th><th class="n">tokens</th></tr></thead>
  <tbody>${sourceRows}</tbody></table>

  <details><summary>Every tool (${view.tools.length})</summary>
  <table><thead><tr><th>name</th><th>source</th><th class="n">size</th><th>description</th></tr></thead>
  <tbody>${toolRows}</tbody></table></details>
</main></body></html>`;
}
