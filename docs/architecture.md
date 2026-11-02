# How it works

```
                    ┌──────────────────────── Jackfield ────────────────────────┐
                    │                                                           │
 agent ──HTTP──►  Router ──► GatewaySession ──► UpstreamPool ──► UpstreamConn ──┼──► MCP server
                    │            │  ▲                                           │
                    │            ▼  │ bridge (forms, sampling, roots, progress)  │
                    │        Catalog (shared per client, cached)                 │
                    └───────────────────────────────────────────────────────────┘
```

## The pieces

**`Router`** (`http/router.ts`) turns a Web `Request` into an answer. It
authenticates, maps session ids to live sessions, and owns the HTTP-level
decisions: `401` with nothing else said, `404` for a session it does not know,
`413` for an oversized body. It does not know what MCP means.

**`Gateway`** (`gateway/gateway.ts`) is configuration made answerable. It owns
one *discovery pool* — connections used only to read what each upstream offers
— and one aggregated catalogue per client, cached and shared by that client's
sessions.

**`GatewaySession`** (`gateway/session.ts`) is the MCP server an agent talks
to, plus the upstream connections opened on its behalf.

**`UpstreamConnection`** (`upstream/connection.ts`) is one connection to one
MCP server, over HTTP, SSE, stdio, or an executor. It connects lazily and
caches its tool list.

## Decisions worth explaining

### Upstream connections are per session

An upstream that asks the agent a question — a login code, a confirmation —
has to reach *the agent that made the call*. MCP has no field that says which
in-flight client request a server-initiated request belongs to, so a
connection shared between sessions cannot route the question. It would arrive
at whichever agent happened to be listening.

So calls go through per-session connections. The cost is real (a stdio server
gets a child process per session) and the alternative is worse.

### Listing is separate from calling

`tools/list` reads the shared catalogue and opens nothing. A cold agent that
lists tools and then uses one wakes exactly one upstream, not twenty. The
catalogue is rebuilt on `notifications/tools/list_changed` from any upstream,
on a TTL, and whenever a call names a tool the catalogue has not seen.

### Progress carries `relatedRequestId`

A Streamable HTTP client reads a call's notifications on that call's own
stream. A progress notification sent without `relatedRequestId` goes to the
standalone stream, which most clients never open — so the agent watches a long
call sit silent and eventually gives up. Forwarding progress is easy; getting
it onto the right stream is the part that makes it work.

### An unknown session is 404

The spec says a client that gets `404` for a session id should start a new
session. A gateway that answers `400` instead leaves clients retrying a
session that will never exist again. This is a one-line decision that
determines whether a restart is invisible or needs a human.

### Deny accumulates

Profiles merge parents-first, client last. Scalars are replaced by the most
specific layer; `include`, `exclude` and `alwaysExpose` accumulate. A deny that
a later layer could undo is not a deny, so exclusions only ever grow.

### Fail open, and say so

An upstream that is down is left out of the catalogue, and the gateway's
instructions gain a line naming it. The agent is told what is missing rather
than finding a hole, and one broken server does not take the other twenty with
it. Set `failOpen: false` on an upstream where a silent absence would be worse
than an error.

### Keys are compared whole

Every candidate key is compared in constant time, and lookups walk the whole
table rather than returning early, so timing says nothing about which keys
exist. A key in the URL path is supported because some clients cannot send
headers; the consequence is that the gateway never writes a path to a log, and
the documentation tells you to turn off path logging in your proxy too.

## What is deliberately not here

- **No database.** The configuration is the state. A gateway holding every key
  you own should be reviewable in a diff.
- **No admin panel that writes.** A read-only view of what each client sees is
  planned; a panel that mutates state would put the real configuration
  somewhere you cannot read it.
- **No tool rewriting by an LLM.** Descriptions matter, but rewriting them at
  runtime means the agent and the server disagree about what a tool does.
