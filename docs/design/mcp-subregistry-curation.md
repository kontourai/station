# MCP subregistries, Station curation and untrusted content

> **Reading status: current design for #3483's first slice.**
> [Subregistry source](../../src-server/providers/registries/mcp-subregistry.ts),
> [catalog provider](../../src-server/providers/registries/mcp-subregistry-provider.ts),
> [curated snapshot](../../src-server/providers/registries/curated/station-mcp-subregistry.json)
> and [untrusted-content permission](../../src-server/services/plugins/untrusted-content-policy.ts)
> own this behavior. This note does not claim a completed signed-in tool call
> for any curated server, multi-source management under #3139, or coverage on
> external engines.

## Problem

People want useful integrations, email first, without finding and pasting
server URLs. The official [MCP Registry](https://github.com/modelcontextprotocol/registry)
lists servers, but it is a preview service, lists tens of thousands of
entries, and carries no OAuth or tool metadata. Its own guidance is that hosts
consume a subregistry. Email also brings content written by strangers into an
Agent's turn, and that content can ask the Agent to send or change things.

## Subregistry source

A source is any URL that answers `GET /v0.1/servers` in the registry's
`ServerListResponse` shape. Station accepts server.json schemas
`2025-09-29` and `2025-12-11` and refuses other revisions by entry.

| Bound | Value | On max + 1 |
| --- | --- | --- |
| Bytes per page, counted as they arrive | 1 MiB | the whole index is refused |
| Pages followed through `metadata.nextCursor` | 10 | the whole index is refused |
| Server records across all pages | 500 | the whole index is refused |
| Whole refresh | 15 s | the attempt fails; the last good copy stays |

Nothing is truncated. A refused index leaves the previous listing in place,
marked stale, with the reason in the source status. Single entries are
refused with every reason (bad name, unsupported schema, non-https or
credential-bearing URL) and the rest are kept. A list with several versions
of one name keeps the one the source marks latest; otherwise that name is
refused. Names are parsed (`namespace/name`) and stored as
`namespace--name` in the tool id grammar, and two names that collide once
stored are both refused rather than one replacing the other.

The last good network copy is saved under `<home>/cache/mcp-subregistry/`.
When a refresh fails, that copy is served as **stale** and Add is refused
until the source is refreshed. Without a copy, the source reports its error
and lists nothing.

Only remote `streamable-http` endpoints can be added. SSE-only, templated
URLs, declared request headers and package-only entries are listed with the
reason they cannot be added. Packages are deferred: Station never runs a
package command from a catalog.

## Station curation

Station ships one curated subregistry in its server bundle, beside the
provider that reads it, so every distribution has it whether or not
`examples/` is present. It is a different format from the
`examples/registry` Station manifests and is not replaced by `registryUrl`.

Each curated entry carries a record under `_meta["ai.kontour.station/curation"]`:
the endpoint Station connects to, the authorization mode, the date and a
summary of what was checked, an optional launch stage, and an optional
`contentTrust: "untrusted"`. Station honors that namespace only from its own
bundled snapshot. Any other source, including one that writes Station's
namespace, is **unqualified**.

Qualification is derived, not written:

- **qualified**: Station checked it and nothing refuses Add.
- **blocked**: Station checked it and something Station cannot do yet
  refuses Add, for example an authorization mode it does not support.
- **unqualified**: from a source other than Station's curation.

| Server | Endpoint | Auth mode | State |
| --- | --- | --- | --- |
| Linear | `https://mcp.linear.app/mcp` | dynamic client registration | qualified |
| Notion | `https://mcp.notion.com/mcp` | dynamic client registration | qualified |
| Atlassian | `https://mcp.atlassian.com/v2/mcp` | dynamic client registration | qualified |
| GitHub | `https://api.githubcopilot.com/mcp/` | pre-registered client required | blocked |
| Gmail (Google Developer Preview) | `https://gmailmcp.googleapis.com/mcp/v1` | pre-registered client required | blocked |

On 2026-10-28, each endpoint and version matched the official registry
entry, except Gmail, which Google lists in its Cloud MCP product table but
has not published to the registry. Each endpoint answered with
protected-resource metadata. For Linear, Notion and Atlassian, Station's own
**Connect your account** flow registered a client and reached the provider's
authorization page with PKCE. GitHub's (`github.com/login/oauth`) and
Google's (`accounts.google.com`) authorization servers publish no
registration endpoint. A signed-in tool call has not been verified for any
entry.

Pre-registered OAuth clients are a separate lane. When Station can use one,
GitHub and Gmail become addable by changing nothing in their records. Gmail
also needs your own Google Cloud OAuth client marked for AI agents, and
read-only scopes are recommended; those are Google's requirements.

An added entry is stored as an ordinary remote tool server, turned off, with
`credentialOwnership: { owner: "principal" }`, so each person signs in to
their own account. The registry entry's name and version are recorded as its
origin.

An operator can add one network subregistry with `STATION_MCP_SUBREGISTRY_URL`
(https only). Its entries are unqualified. Pointed at the official registry's
whole feed, the server bound refuses it; narrow the query
(`?search=...&version=latest`) or use a subregistry.

## Untrusted content and outbound tools

The rule reuses Station's tool permission model. It is a default the person
can change, not a fixed gate.

- **Classification.** `ToolDef.contentTrust: "untrusted"` marks a server that
  returns content written by others. A curated entry provides it as the
  default when added; the person can set `trusted` for a server they trust.
- **Permission.** `ToolDef.untrustedContentPermissions` holds a `default`
  and per-tool entries, each `ask`, `allow` or `deny`. Absent means `ask`.
  It applies to the server's tools that the server does not declare
  read-only (MCP `readOnlyHint`, recorded by the probe).
- **When it applies.** After a tool from an `untrusted` server returns in a
  turn, every later call in that turn takes the called tool's permission.
  The turn ends when the invocation finishes.

The [staged pre-tool evaluator](../../src-server/runtime/agents/pre-tool-policy.ts)
answers the permission before tool grants:

- `ask` is a required question, like an authored ask-before-use. An Agent's
  `autoApprove`, a guardian allow or an unattended opt-in cannot answer it.
  With nobody present it is refused.
- `deny` refuses with a reason naming the setting.
- `allow` adds nothing; the tool's usual permission decides. An always-allow
  in the Agent's `autoApprove` then runs the tool without a question.

Changes go through the existing integration save
(`PUT /api/integrations/:id`), which is operator-gated. When the
classification or a permission changes, the route appends a receipt
(`untrustedContentChanges`: time, person, new value), keeps the last 50, and
ignores receipts in the request.

### Coverage and gaps

- **Enforced:** tools the Station engine dispatches through its hooks
  ([agent-hooks.ts](../../src-server/runtime/agents/agent-hooks.ts)).
- **Not enforced on external engines.** Claude Code, Codex and ACP sessions
  build their evaluator in `StationRuntime.resolveExternalPreToolPolicy`
  without this stage, and their tool results are not reported to Station's
  hooks per turn. Station shows no claim of coverage there.
- **Tools without integration settings.** A tool not loaded from an
  integration (Station's built-in bash, file editor, HTTP request) takes the
  default `ask` in a marked turn and has no per-tool setting yet.
- **Earlier turns.** Content read in an earlier turn stays in the
  conversation history but no longer marks the turn.
- **No settings UI yet.** The fields are edited through the tool's settings
  (Raw JSON) or the API.
