# Configuration reference

One file holds everything the gateway does. YAML or JSON (YAML is a superset,
so a `.json` file parses too). There is no database and no admin panel: the
file is the state, which is what makes a deployment a diff you can read.

## Secrets

No secret belongs in the file. Any string may contain:

| Placeholder | Meaning |
| --- | --- |
| `${env:NAME}` | an environment variable |
| `${file:/path}` | the contents of a file, trimmed |
| `${file:relative/path}` | relative to the config file's directory |
| `${env?:NAME}`, `${file?:/path}` | optional: empty when missing |

Anything resolved this way is registered with the logger and replaced with
`«redacted»` before any line is written, so a key cannot reach a log by
accident. A missing non-optional secret stops startup rather than silently
serving a gateway that cannot authenticate.

## `server`

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Listen address. |
| `port` | `8790` | Listen port. `0` picks a free one. |
| `basePath` | `""` | Mount under a path, e.g. `/gateway` → `/gateway/mcp`. |
| `publicUrl` | — | Printed by `jackfield routes`. |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |
| `logFormat` | `pretty` | `json` for journald or a hosted platform. |
| `keepAliveMs` | `15000` | SSE keep-alive. Clients cut a stream that goes quiet. |
| `requestTimeoutMs` | `300000` | Default per-call timeout towards upstreams. |
| `sessionIdleMs` | `1800000` | Idle sessions are closed and their upstreams released. |
| `health` | `true` | Answer `GET /healthz` without a key. |
| `cors` | `false` | Send permissive CORS headers. Agents call from a server; an open gateway in a browser is a gift to any page the user has open. |
| `maxBodyBytes` | `4194304` | Largest POST accepted. |
| `stateless` | `false` | No sessions. Required for serverless, and it costs elicitation and sampling. |

## `defaults`

| Key | Default | Meaning |
| --- | --- | --- |
| `prefix` | `always` | `always`, `auto`, `never` — see below. |
| `separator` | `_` | Between prefix and tool name. |
| `failOpen` | `true` | An unreachable upstream is skipped, not fatal. |
| `startupTimeoutMs` | `20000` | How long an upstream gets to come up. |
| `expose` | `all` | `all` or `search`. |
| `catalogTtlMs` | `300000` | How long an aggregated catalogue is reused. |

### Prefix modes

Two upstreams may both offer `search`. With `always`, names arrive as
`github_search` and `notes_search` — predictable, and what you want for an
agent that keeps names in its context. With `auto`, only the names that
actually collide get prefixed. With `never`, names pass through and a collision
is resolved by appending a short hash, because a tool that silently disappears
is harder to notice than one with an odd name.

Names are capped at the 128 characters MCP allows; a name that would exceed it
is trimmed with a hash suffix rather than truncated into a duplicate.

## `upstreams`

Every upstream shares these keys:

| Key | Meaning |
| --- | --- |
| `description` | Shown in `find_tool` and `jackfield tools`. |
| `prefix` | Name used for prefixing. Defaults to the upstream id. |
| `enabled` | `false` keeps the definition but stops serving it. |
| `failOpen` | Override the default. |
| `timeoutMs` | Per-call timeout. Prefer progress notifications over a long one. |
| `tags` | Labels, usable as `tag:name` in a profile. |
| `tools.allow` | Globs kept, before any client sees them. |
| `tools.deny` | Globs removed. Deny wins. |
| `tools.rename` | `{ old: new }`, applied before prefixing. |
| `instructions` | `keep` (default) merges the server's own instructions, `drop` discards them. Dropping is often right: instructions are tokens every turn. |
| `forward` | `{ tools, resources, prompts }`. Tools only by default. |

### `transport: http`

```yaml
upstreams:
  example:
    transport: http
    url: https://example.com/mcp
    token: ${file:secrets/example.token}     # shorthand for a Bearer header
    headers:
      X-Anything: value
    hostHeader: 127.0.0.1:8791               # when the server validates Host
```

`hostHeader` exists because some MCP servers reject any `Host` they did not
expect with a 403, and a gateway forwards the agent's `Host` by default.

### `transport: sse`

The older transport. Same keys minus `hostHeader`.

### `transport: stdio`

```yaml
upstreams:
  notes:
    transport: stdio
    command: npx
    args: ["-y", "some-mcp-server"]
    env:
      API_KEY: ${env:SOME_API_KEY}
    inheritEnv: false        # default: the child gets only `env`
    cwd: /var/lib/something
```

With `inheritEnv: true` the gateway's environment is passed through, minus
variables whose names look like credentials.

### `transport: executor`

```yaml
executors:
  home:
    url: http://100.64.0.2:8795
    token: ${file:secrets/executor.token}

upstreams:
  browser:
    transport: executor
    executor: home
    remote: browser          # id on the executor; defaults to this upstream's id
```

## `profiles`

A profile is the reusable half of a selection: what a *kind* of agent gets.

```yaml
profiles:
  core:
    upstreams: ["tag:personal"]
    exclude: ["*.delete_*"]
  full:
    extends: [core]
    upstreams: ["*"]
```

`upstreams` selectors: an id, `*`, `tag:name`, or a glob like `mail*`.

## `clients`

A client is the specific half: who it is, and its key.

| Key | Meaning |
| --- | --- |
| `key` | At least 16 characters. Compared in constant time, never logged. |
| `altKeys` | Extra accepted keys, for rotating without downtime. |
| `keyInPath` | Also accept `/k/<key>/mcp`. The URL is then a secret. |
| `public` | Serve without a key. Only when something else authenticates. |
| `profile` | A profile to build on. |
| `enabled` | `false` refuses it. |
| `upstreams`, `include`, `exclude`, `expose`, `alwaysExpose`, `prefix`, `instructions` | Overrides. |

### How layers merge

Profiles are flattened parents-first, then the client is applied last.

- `upstreams`, `expose`, `prefix` — replaced by the most specific layer that sets them.
- `include`, `exclude`, `alwaysExpose` — accumulate.

Because exclusions accumulate, a client can never widen what a profile denied.
That is deliberate: a deny that a later layer can undo is not a deny.

## Exposure modes

`expose: all` lists every selected tool.

`expose: search` lists only `find_tool` and `call_tool`, plus anything matched
by `alwaysExpose`. The agent searches by intent and gets full input schemas for
the matches. Use it for clients that load every definition into every prompt;
clients that fetch definitions on demand are better off with `all`.

Tools stay callable by name in `search` mode — an agent that remembers a name
from earlier in a conversation should not be punished for it.

## Endpoints

Under `server.basePath`:

| Route | Who |
| --- | --- |
| `ALL /mcp` | client identified by `Authorization: Bearer <key>` |
| `ALL /k/<key>/mcp` | clients with `keyInPath: true` |
| `ALL /c/<client>/mcp` | the named client; the key must still match it |
| `GET /healthz` | anyone, when `server.health` is on |
