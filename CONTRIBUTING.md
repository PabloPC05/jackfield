# Contributing

## Getting set up

```bash
npm install
npm run build
npm test          # builds, then runs the test suites
```

Node 22 or newer. Tests are TypeScript run directly by `node --test`; they
import the built `dist/`, so a change needs a build before the tests see it
(`npm test` does both).

## Layout

```
packages/core        the gateway: config, upstreams, catalogues, HTTP
packages/cli         jackfield serve | check | tools | routes | keygen | init
packages/executor    the machine-side half, for upstreams a core cannot host
examples/            a working config with two demo MCP servers
deploy/              systemd, Docker, NixOS, serverless
docs/                configuration reference, deployment, architecture
```

## What a change should come with

- A test. The suite already covers aggregation, profiles, search mode,
  elicitation, progress, sessions, stateless mode and the core/executor split;
  a new behaviour should join them.
- A line in the docs if it changes the configuration file.
- No new runtime dependency without a reason in the pull request. The core has
  three: the MCP SDK, a YAML parser, and zod.

## House style

- Comments explain *why*, not what. If a line exists because a client or a
  server behaves surprisingly, say which and how — that is the part nobody can
  rediscover from the code.
- No secret may reach a log line. Anything resolved from `${env:}` or
  `${file:}` is registered for redaction; keep it that way.
- Errors that an agent will read should say what to do next. "no tool named X.
  Closest: Y, Z" is worth more than a correct error code.

## Security

Report anything exploitable privately rather than in an issue. A gateway holds
every key its owner has.
