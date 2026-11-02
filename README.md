# Jackfield

One MCP endpoint for every agent you use.

A *jackfield* is the panel of jacks in a telephone exchange: every line comes
in, and you patch any of them to any destination. This is that, for MCP
servers. You plug your servers in once, hand each agent a URL and a key, and a
file in git decides who reaches what.

```
   Claude Code ─┐                            ┌─ github (http)
      claude.ai ─┤                            ├─ mail, calendar, files (http)
         Codex ──┤──► https://you/mcp ──────►─┤─ a browser (needs a process)
   your own app ─┘        Jackfield            ├─ anything stdio
                                              └─ an executor on your machine
```

**Status: early.** 74 tests cover it end to end — aggregation, name collisions,
profiles, search mode, tool overrides, response trimming, permission rules,
notifications, elicitation, out-of-band approvals, OAuth against a full
authorization server, progress, sessions, stateless mode, the command-line
sandbox, the read-only view, and a split core/executor setup over both a direct
connection and a dial-in tunnel. It has not yet run for long in production, and
interfaces may still change before 1.0.

Everything it does: **<https://jackfield.ppardocotos.com>**

## Why another one

There are several MCP gateways. Most of them handle the easy half — forward
`tools/list` and `tools/call` — and quietly drop the rest. The half that gets
dropped is the half that breaks real setups:

- **A server can talk back.** MCP lets a server ask the agent for something
  mid-call: a form to fill in (elicitation), a model completion (sampling), the
  roots it may read. A browser-automation server asks you for a login code
  this way. Jackfield bridges those requests to the agent that made the call,
  and when the agent cannot answer, says so instead of hanging.
- **Long calls have to stay alive.** A call that goes quiet for five minutes is
  cut by some clients. Jackfield forwards upstream progress notifications
  *on the call's own stream*, which is the detail that makes clients actually
  see them, and keeps SSE alive underneath.
- **A lost session must be recoverable.** When the gateway restarts, a client
  holding an old session id has to be told `404`, not `400`. Told `400`, some
  clients retry the dead session forever and the connection never comes back.
- **Not every client can send a header.** At least one popular agent cannot,
  so Jackfield also accepts the key in the path — and then treats the whole
  URL as a secret: no log line can contain it.
- **Hundreds of tools cost real money.** A gateway with everything plugged in
  can put a six-figure token count in front of every turn. `jackfield tools
  --by-source` shows that bill per source, `expose: search` replaces the
  catalogue with two tools for clients that load every definition anyway, and
  `transport: cli` turns a service used twice a month into one tool instead of
  a hundred definitions you pay for every turn.
- **Some calls should need a person.** `permissions` gives every tool `allow`,
  `ask` or `deny`. `ask` puts the question to the user — as a form in their
  client, or with `via: link` as a one-time URL sent to your notifier and to
  nobody else, which is the only route that works when nobody is watching the
  agent. The agent never sees the link, so it cannot approve itself.
- **One reply should not eat the context window.** Results over a limit are
  trimmed, with a note saying how much went and to ask for less. Descriptions
  and hints can be rewritten per tool without touching the server.
- **Credentials belong to you, not to the agent.** OAuth upstream with
  discovery, PKCE and refresh; tokens in one file per server at mode 0600, and
  no agent ever sees one. The gateway never starts a login by itself — one that
  could is one an agent could aim at a server of its choosing.
- **Configuration belongs in git.** No database, no admin panel writing state
  behind your back. One file, secrets referenced rather than embedded, and a
  deployment is a diff you can read. `/status` reads it back to you; it never
  writes.

## Quickstart

```bash
git clone https://github.com/PabloPC05/jackfield && cd jackfield
npm install && npm run build

# A working example: two MCP servers, three clients, nothing to install.
node packages/cli/dist/bin.js check  -c examples/jackfield.yaml
node packages/cli/dist/bin.js tools  -c examples/jackfield.yaml --by-source
node packages/cli/dist/bin.js serve  -c examples/jackfield.yaml
```

Then point an agent at `http://127.0.0.1:8790/mcp` with
`Authorization: Bearer <key>`. `jackfield routes` prints exactly what to paste
for each client.

## The configuration

```yaml
server:
  host: 127.0.0.1
  port: 8790
  publicUrl: https://mcp.example.com

upstreams:
  github:
    transport: http
    url: https://example.com/mcp
    token: ${file:/etc/jackfield/secrets/github.token}

  notes:
    transport: stdio                 # a child process
    command: npx
    args: ["-y", "some-mcp-server"]
    env:
      API_KEY: ${env:SOME_API_KEY}

  browser:
    transport: executor              # lives on a machine of yours
    executor: home

  ops:
    transport: cli                   # 120 tools you rarely use → 1
    commands:
      coolify:
        description: "Coolify CLI. Ask it for --help first."
        executable: coolify
        allowedSubcommands: ["list", "deploy", "logs"]

permissions:                       # a floor every client inherits
  - tools: ["*.delete_*"]
    action: ask                      # asks the user, through an MCP form

profiles:
  core:
    upstreams: ["tag:personal"]
  full:
    extends: [core]
    upstreams: ["*"]
    exclude: ["github.delete_*"]     # deny accumulates and always wins

clients:
  laptop:
    key: ${file:/etc/jackfield/secrets/key-laptop}
    profile: full

  web-agent:
    key: ${file:/etc/jackfield/secrets/key-web}
    keyInPath: true                  # /k/<key>/mcp, for clients without headers
    profile: core

  thrifty:
    key: ${file:/etc/jackfield/secrets/key-thrifty}
    profile: full
    expose: search                   # find_tool + call_tool instead of 300 definitions
```

Full reference: [docs/configuration.md](docs/configuration.md).

## Running it

Jackfield's HTTP layer is written against Web `Request`/`Response`, so the same
gateway runs wherever you want it. Hosting is a choice, not an architecture.

| Where | How | Notes |
| --- | --- | --- |
| A process | `jackfield serve` | The default. Everything works. |
| systemd | [`deploy/systemd`](deploy/systemd) | Hardened unit file. |
| Docker | [`deploy/docker`](deploy/docker) | |
| NixOS | [`deploy/nix`](deploy/nix) | Module with options, secrets kept out of the store. |
| Serverless | [`deploy/vercel`](deploy/vercel) | Needs `stateless: true`; see the limits below. |
| Your machine | `jackfield-executor` | Hosts what a stateless core cannot. Can dial the gateway, so it needs no inbound port. |

A serverless function cannot keep a session, start a child process, or hold a
stream open for an hour. Rather than let that decide what your tools may be,
run a **Jackfield executor** on a machine you own: it serves exactly those
upstreams, and the core reaches them with `transport: executor`. Moving an
upstream between the two is a two-line edit.

See [docs/deploying.md](docs/deploying.md).

## Commands

```
jackfield serve     Run the gateway
jackfield check     Validate the config and connect to every upstream
jackfield tools     List what a client would see, with its size in tokens
jackfield routes    Print the URL and key each client needs
jackfield keygen    Generate a key
jackfield init      Write a starter config
```

## Design notes

- **Per-session upstream connections.** When an upstream asks a question, it
  has to reach *that* agent. The protocol gives no way to tell which of several
  sessions an incoming server request belongs to, so sharing one connection
  between sessions would send one agent's form to another.
- **Shared catalogues.** Listing tools does not open anything: the aggregated
  catalogue is built once per client and cached. Only a real call connects, and
  only to the upstream that owns the tool.
- **Lazy, and fail-open.** An upstream that is down is skipped, with a line in
  the gateway instructions saying so, instead of taking the whole list with it.

More in [docs/architecture.md](docs/architecture.md), and an honest comparison
with the alternatives in [docs/comparison.md](docs/comparison.md).

## Not done yet

- Resources and prompts are forwarded off by default and are untested.
- Stateless mode cannot do forms, sampling or `ask` rules, because there is no
  session to ask on. The executor exists for exactly that gap; carrying
  sessions in a shared store would close it properly.
- Code execution against the tools, local embeddings for tool search, and more
  than one person per gateway. See the roadmap on the site.
- Published npm packages; for now, build from source.

## The landing page

<https://jackfield.ppardocotos.com> is built from `site/`:

```bash
cd site && node build.mjs     # → site/dist, with content-hashed assets
```

It is a static page with no dependencies and no tracking. `deploy/lisa/` has
the NixOS module that serves it.

## License

MIT
