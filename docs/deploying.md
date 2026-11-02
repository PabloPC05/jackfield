# Running Jackfield

The HTTP layer is written against Web `Request`/`Response`. Nothing in the
gateway knows what is hosting it, so where it runs is a choice you make per
machine, not a property of the design.

## A process (the default)

```bash
jackfield serve --config /etc/jackfield/jackfield.yaml
```

Everything works: sessions, elicitation, streams that stay open for an hour,
stdio upstreams. Put it behind the reverse proxy you already have and give it
TLS there.

If your proxy logs request paths and any client uses `keyInPath`, turn those
logs off for this vhost. The gateway never logs a path; your proxy does not
know that it must not.

## systemd

[`deploy/systemd/jackfield.service`](../deploy/systemd/jackfield.service) is a
hardened unit: no new privileges, read-only system, a single read-only secrets
directory. If an upstream is a stdio server that needs a writable home,
uncomment the `ReadWritePaths` line.

## Docker

```bash
docker build -f deploy/docker/Dockerfile -t jackfield .
docker run --rm -p 127.0.0.1:8790:8790 \
  -v "$PWD/jackfield.yaml:/etc/jackfield/jackfield.yaml:ro" \
  jackfield
```

Or [`deploy/docker/compose.yaml`](../deploy/docker/compose.yaml). Mount
secrets as files and reference them with `${file:...}`; passing them as
environment variables puts them in `docker inspect`.

## NixOS

[`deploy/nix/module.nix`](../deploy/nix/module.nix) adds
`services.jackfield`. The configuration is an attribute set, written to the
Nix store — which is world-readable, so every secret must be a
`${file:/var/lib/jackfield/secrets/...}` reference, never a literal. The module
creates that directory with mode 0700; you put the files there.

`services.jackfield.executor.enable` adds the executor as a second unit on the
same machine.

The package derivation needs `npmDepsHash` filled in:

```bash
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

Keep `package-lock.json` in LF. A CRLF checkout changes that hash and the
build then fails for a reason that has nothing to do with the code.

## Serverless

[`deploy/vercel`](../deploy/vercel) has a function, a `vercel.json`, and a
config to copy. The function is five lines, because the adapter is
`createWebHandler` in the core:

```js
import { createWebHandler } from '@jackfield/core';

const handler = createWebHandler({ configPath: './jackfield.yaml', stateless: true });
export default (request) => handler(request);
```

The same handler shape fits Cloudflare Workers, Deno Deploy, Bun, and Hono.

**What you lose, and why.** A function does not outlive its request, so there
is no session to resume and no stream to send on. That costs:

- elicitation and sampling (a server cannot ask the agent anything),
- stdio upstreams (no child processes),
- calls longer than the platform's function limit,
- resumable streams.

What still works: every HTTP upstream, aggregation, profiles, keys, tool
search. For a gateway that is only plumbing in front of hosted servers, that is
the whole job.

The example is written and the code path is covered by tests
(`packages/core/test/stateless.test.ts` exercises stateless mode end to end),
but it has not been verified on a live Vercel deployment yet. Treat the
platform specifics — runtime name, `includeFiles`, rewrites — as a starting
point to check, not as a tested recipe.

## The split: core plus executor

This is the answer to "my host cannot do that". Instead of letting the host
decide what your tools may be, run an executor on a machine you own:

```
agents ──► core (anywhere, can be stateless) ──► hosted MCP servers
                              │
                              └──► executor (your machine) ──► stdio servers
                                                               a browser
                                                               a shell
```

On the machine:

```bash
jackfield-executor --config executor.yaml --token-file /etc/jackfield/exec.token
```

`executor.yaml` is an ordinary config file; only its `upstreams` are used.
Each one is served at `/upstream/<id>/mcp`, unprefixed, behind that single
token. Reach it on a private network — Tailscale, a VPN, a loopback tunnel —
rather than opening a port.

In the core:

```yaml
executors:
  home:
    url: http://100.64.0.2:8795
    token: ${file:secrets/executor.token}

upstreams:
  browser:
    transport: executor
    executor: home
```

### Or the other way round, with no port to open

A machine behind NAT, on home broadband, or one you would simply rather not
expose can **dial the gateway** instead:

```yaml
# in the gateway
executors:
  home:
    attach: true
    token: ${file:secrets/executor.token}
```

```bash
# on the machine
jackfield-executor --config executor.yaml \
  --token-file /etc/jackfield/exec.token \
  --core https://gateway.example.com --name home
```

The executor opens one long-lived stream outwards and the gateway pushes
requests down it; answers come back as ordinary POSTs, streamed chunk by chunk
so a server behind the tunnel can still hold an SSE stream open and ask the
agent a question through it. It reconnects on its own, with backoff.

Nothing has to reach the machine. The gateway only knows the executor by name
and its token.

The upstream definition itself does not change when you move it between the
core and an executor: the same two lines of `transport` and location, in a
different file. The core prefixes tool names once, at the core, so nothing
arrives as `browser_browser_open`.

## Restarts and sessions

Restarting the gateway invalidates open sessions. Clients that hold one get
`404` on their next request, which is the protocol's signal to start a new
session, and they recover without being touched. This is worth saying because
a gateway that answers `400` instead will leave clients retrying a dead
session indefinitely — the symptom is a connector stuck in error until it is
manually reconnected.

## Health

`GET /healthz` needs no key and returns the state of every upstream:

```json
{ "ok": true, "sessions": 2, "upstreams": [{ "id": "github", "state": "ready", "tools": 49 }] }
```
