# The alternatives

Jackfield exists because of a specific gap, not because the alternatives are
bad. Several of them are better than this one at things Jackfield does not try
to do. Here is the honest version.

**A caveat on dates.** This was written in November 2026 from each project's
own documentation. These projects move; most published comparisons of MCP
gateways are written by one of the vendors in them. Check anything here that
matters to your decision, including the claims about Jackfield.

## What Jackfield is for

A person or a small team with a dozen MCP servers and several agents, who
wants one endpoint per agent, a file in git that says who sees what, and no
server-side feature silently dropped on the way through.

## What the others are for

**agentgateway** — a general-purpose agent/AI proxy with MCP among its
protocols, configured by file, under a foundation rather than a vendor. The
closest thing to Jackfield in spirit, and the more mature project by a wide
margin. Where it differs: it is a much larger surface (it also does A2A, LLM
routing and service-mesh concerns), and the MCP-specific details Jackfield
exists for — forms that work through the gateway, a key in the path for a
client that cannot send headers, token-cost reporting per source — are not its
focus. If you want one proven, well-maintained proxy for everything, start
there.

**IBM ContextForge** — a full MCP gateway with a web admin UI, virtual servers
assembled from chosen tools, upstream OAuth with stored credentials, and
federation. The right answer if you want to add servers by clicking, and the
wrong answer if you want the configuration to be a file: its state lives in a
database.

**ToolHive** — runs MCP servers in containers from a registry, joins several
into one endpoint, and has an experimental optimiser that shows a model
`find_tool`/`call_tool` instead of hundreds of definitions. The container
isolation is genuinely good and Jackfield has no equivalent. Its optimiser and
Jackfield's `expose: search` solve the same problem the same way.

**MetaMCP** — a web app with namespaces of servers, API-key or OAuth
endpoints, and the ability to rename and disable tools. Everything is
configured from its own UI, which is the opposite of the trade Jackfield
makes.

**Obot** — catalogue, central OAuth and auditing, built for teams on
Kubernetes. Too much machinery for one person, and the right shape for a
company.

**Docker MCP Gateway** — profiles of servers and adding them while running,
built around Docker Desktop. Convenient if that is already your world.

**MCPJungle**, **MCPHub**, **Bifrost** — smaller or younger registries and
gateways in the same space, each with a different emphasis (single binary,
hub-style discovery, high-throughput LLM proxying). Worth a look if one of
those emphases is yours.

## The honest scorecard

Things Jackfield does that the others mostly do not:

- Bridges server-initiated requests — elicitation forms, sampling, roots — to
  the agent that made the call, and refuses clearly when the agent cannot
  answer.
- Forwards progress on the originating call's stream, so clients actually see
  it and long calls survive.
- Answers `404`, not `400`, for an unknown session, so clients recover from a
  restart on their own.
- Accepts the key in the URL path, and then keeps paths out of every log.
- Reports the token cost of what each client loads, per source.
- Keeps the whole configuration in one reviewable file, with secrets
  referenced rather than embedded.
- Splits into a core and an executor, so a host that cannot run processes does
  not get to decide what your tools are.

Things the others do that Jackfield does not:

- Container isolation per MCP server (ToolHive).
- A UI to add and wire servers (ContextForge, MetaMCP, Obot).
- Upstream OAuth with stored credentials and refresh (ContextForge, Obot).
  Jackfield handles token files and headers only.
- Multi-tenant auditing and team administration (Obot).
- Registries and discovery of servers you have not configured.
- Years of production use. Jackfield is new.
