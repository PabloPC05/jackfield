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
| `limits.maxResponseBytes` | `400000` | Largest tool result passed through, before trimming. |
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
| `tools.override` | Rewrite a tool's `title`, `description` and `annotations`. Keyed by the upstream's own name, so it survives a rename. |
| `limits.maxResponseBytes` | Largest result passed through, for this upstream. |
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

#### OAuth instead of a static token

```yaml
upstreams:
  vault:
    transport: http
    url: https://vault.example.com/mcp
    oauth:
      scope: "read write"
      # Only when the server does not do dynamic client registration:
      # clientId: abc123
      # clientSecret: ${file:secrets/vault.secret}
```

Then, once, as the operator:

```bash
jackfield login vault     # opens a browser, catches the callback
jackfield login vault --manual   # prints the URL, takes the code by hand
jackfield logout vault
```

Discovery, dynamic registration, PKCE and refresh are the SDK's job; Jackfield
stores the result in `auth.storeDir`, one file per upstream at mode 0600, and
refreshes it from then on. No agent ever sees a token.

The gateway will **not** start an authorization flow on its own. A gateway that
did could be pointed at an authorization server of an agent's choosing, so
logging in stays a command you run.

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

### `transport: cli`

A built-in MCP server that turns a few command-line programs into tools.

```yaml
upstreams:
  ops:
    transport: cli
    commandTimeoutMs: 60000
    maxOutputBytes: 100000
    commands:
      coolify:
        description: "Coolify CLI. Ask it for --help first."
        executable: coolify
        prefixArgs: ["--no-color"]
        allowedSubcommands: ["list", "deploy", "logs"]
        deniedArgs: ["--token"]
        maxArgs: 20
        cwd: /var/lib/jackfield
        env:
          COOLIFY_TOKEN: ${file:secrets/coolify.token}
```

The point is token cost: a service whose MCP server defines 120 tools, used
twice a month, pays for those definitions in every prompt; its command line
pays for one. The safety is structural rather than filtered —

- **no shell, ever.** The program is spawned with an argument array, so `;`,
  backticks and `$(…)` mean nothing to anything;
- the **executable is fixed in the config**: the agent chooses arguments,
  never the program;
- `allowedSubcommands` turns "a CLI" into "these operations of a CLI";
- `deniedArgs`, `maxArgs`, `commandTimeoutMs` and `maxOutputBytes` bound the
  rest.

A non-zero exit, a missing program or a kill after the time limit all come
back as a tool error the agent can read, never as a crash.

### `transport: executor`

```yaml
executors:
  # The gateway calls the executor: it has to be reachable.
  home:
    url: http://100.64.0.2:8795
    token: ${file:secrets/executor.token}

  # Or the executor calls the gateway: nothing has to reach it.
  laptop:
    attach: true
    token: ${file:secrets/laptop.token}

upstreams:
  browser:
    transport: executor
    executor: home
    remote: browser          # id on the executor; defaults to this upstream's id
```

## `auth`

| Key | Default | Meaning |
| --- | --- | --- |
| `storeDir` | `./.jackfield/auth` | Where OAuth credentials live, mode 0600. |
| `redirectUrl` | `http://127.0.0.1:7777/callback` | Redirect URI registered with authorization servers; the loopback listener `jackfield login` opens. |

## `permissions`

What to do before a tool runs. Within a list, the first matching rule wins.

```yaml
permissions:                       # the floor for every client
  - tools: ["*.delete_*", "github.merge_*"]
    action: ask
    reason: it changes something that is hard to put back
  - tools: ["shell.*"]
    action: deny

clients:
  laptop:
    permissions:                   # this client's own rules
      - tools: ["notes.*"]
        action: allow
```

`allow`, `ask`, `deny`. The client's rules and the global ones are both
evaluated, and **the stricter answer wins** — the global list is a floor, not a
default, so a client can tighten and never loosen.

### Where `ask` asks

```yaml
permissions:
  - tools: ["*.delete_*"]
    action: ask
    via: link            # client (default) | link | any
    timeoutMs: 600000
```

- **`client`** renders an MCP form in the agent's own interface. Right when a
  person is watching that window.
- **`link`** mints a one-time URL, sends it to your notifier and to nobody
  else, and holds the call — emitting progress so it does not time out — until
  someone opens it and decides. The agent never learns the URL, so it cannot
  approve itself, and this is the only route that works for an agent nobody is
  watching.
- **`any`** uses the client form when the client can show one, the link when it
  cannot.

A `via` other than `client` needs `approvals.publicUrl` and a `notify` block;
without them the configuration is refused rather than silently asking no one.

## `approvals`

| Key | Default | Meaning |
| --- | --- | --- |
| `publicUrl` | — | Base URL of the gateway as *you* reach it. Required for `via: link`. |
| `timeoutMs` | `600000` | How long a link stays open before the call is refused. |
| `passphrase` | — | A secret the page asks for on top of holding the link. |

The page lives at `/approve/<token>`, takes no client key — the token is the
credential — works once, and is never logged with the token in it.

`ask` puts the question to the user through an MCP elicitation form before the
call runs, with the tool name and its arguments. A client that cannot show
forms is **denied**, not waved through: an approval the agent grants itself is
not an approval, and the refusal says what the client would need so the cause
is visible.

In `stateless` mode there is no way to ask, so `ask` behaves as `deny`.

## `notify`

Where to send a line when something sensitive happens.

```yaml
notify:
  kind: ntfy                       # or webhook
  url: https://ntfy.example.com/my-topic
  token: ${file:secrets/ntfy.token}
  tools: ["*.delete_*", "shell.*"]  # what counts as sensitive
  events: [call, result, asked, denied, error]
  title: jackfield
```

Fire and forget by design: a notifier that is slow or down never delays or
fails a tool call. The point is that you find out an agent deleted something,
not that the gateway stops working when ntfy is unreachable.

| Event | When |
| --- | --- |
| `call` | a watched tool is about to run |
| `result` | it finished |
| `asked` | the user approved an `ask` rule |
| `denied` | a rule refused it, or the user declined |
| `error` | the upstream failed |

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
| `permissions` | This client's own rules, combined with the global ones by taking the stricter answer. |

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

## Response limits

A result over `limits.maxResponseBytes` is trimmed rather than passed on: text
blocks are cut largest-first, whole blocks are dropped from the end if that is
not enough, and the agent is told how much went and what to do instead —

```
[trimmed by the gateway: 184302 more characters.
 Ask for a narrower result, a page, or a filter.]
```

A single reply that fills the context window is worse than a trimmed one: the
agent loses the conversation either way, and with a trim it at least knows
what happened.

## Endpoints

Under `server.basePath`:

| Route | Who |
| --- | --- |
| `ALL /mcp` | client identified by `Authorization: Bearer <key>` |
| `ALL /k/<key>/mcp` | clients with `keyInPath: true` |
| `ALL /c/<client>/mcp` | the named client; the key must still match it |
| `GET /status`, `/status.json` | a client key; a read-only view of what that key sees |
| `GET /healthz` | anyone, when `server.health` is on |
| `GET`/`POST /approve/<token>` | whoever holds the link; no client key |
| `GET /executor/<name>/attach` | an executor that dials in, with its own token |
| `POST /executor/<name>/reply` | the same executor, carrying answers back |

## `/status`

A read-only page showing, for the key that asks: every server and its state,
the tools that key ends up with, and what those definitions cost in bytes and
rough tokens. `/status.json` returns the same as JSON.

Read-only on purpose. A panel that wrote configuration would move the real
state out of the file you can read in a diff. Turn it off with
`server.status: false`.
