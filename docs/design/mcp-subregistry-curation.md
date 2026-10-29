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
- **setup-required**: checked and addable, but sign-in needs an OAuth
  client the person registers with the provider, a path Station's own check
  did not complete.
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

Pre-registered OAuth clients are a separate lane. The listing reads one host
capability, `pre-registered-clients`
([source](../../src-server/services/plugins/tool-server-oauth-capabilities.ts)),
at listing time. Registration is not a security boundary: code in the
server process, including a trusted in-process plugin, already has the
host's authority, and a false registration only lists an entry as addable
whose sign-in then fails. Nothing registers it yet; the change that adds
pre-registered client support registers it with one
`registerToolServerOAuthCapability('pre-registered-clients')` call, and
GitHub and Gmail then list as **setup-required** with nothing changed in
their records. Gmail also needs your own Google Cloud OAuth client marked
for AI agents. Google's tool reference lists search, read, label and draft
tools and no send tool: `gmail.readonly` covers search and read, drafting
needs `gmail.compose`, and labeling needs `gmail.modify`.

An added entry is stored as an ordinary remote tool server, turned off, with
`credentialOwnership: { owner: "principal" }`, so each person signs in to
their own account. The registry entry's name and version are recorded as its
origin.

A catalog cannot add an endpoint on this host or its network: loopback,
private, link-local, shared, reserved and multicast addresses (IPv4, IPv6,
IPv4-mapped IPv6, and `localhost`, `*.localhost`, `*.local` names, with
repeated or terminal root dots removed first) are listed with that reason. An operator can allow them with
`STATION_MCP_SUBREGISTRY_ALLOW_PRIVATE_ADDRESSES=1`. A public name that
resolves to a private address is not caught at listing time. Tool servers
added by hand under **Connections → Tools** are unaffected.

An operator can add one network subregistry with `STATION_MCP_SUBREGISTRY_URL`
(https only). Its entries are unqualified. Pointed at the official registry's
whole feed, the server bound refuses it; narrow the query
(`?search=...&version=latest`) or use a subregistry.

## Untrusted content and outbound tools

The rule reuses Station's tool permission model. It is a default the person
can change, not a fixed gate.

- **Classification.** `ToolDef.contentTrust: "untrusted"` marks a server that
  returns content written by others. Station defaults plugin, external registry
  and CLI imports outside its curated catalog to trusted; the bundled catalog
  supplies its reviewed classification. The person can set `untrusted`.
- **Permission.** `ToolDef.untrustedContentPermissions` holds a `default`
  and per-tool entries, each `ask`, `allow` or `deny`. Absent means `ask`.
- **Order.** The called tool's own entry, then its integration's `default`,
  both read as own properties (a tool named `toString` or `constructor`
  never reads an inherited member); a stored value that is not a permission
  asks.
  Only when neither is set can a server's read-only hint (MCP
  `readOnlyHint`, recorded by the probe) exempt the tool, and only when that
  server's hints are trusted: its `contentTrust` is not `untrusted`, or
  `trustReadOnlyHints` is set by the person. MCP annotations
  are the server's own claim, so an untrusted server's hints count for
  nothing by default. Otherwise the answer is `ask`.
- **When it applies.** After a tool from an `untrusted` server returns in a
  turn, every later call in that turn takes the called tool's permission.
  The turn ends when the invocation ends, however it ends: each Station
  engine framework calls `endInvocation` on success, error and abort. At
  most 10,000 turns are held. If that capacity is exhausted, Station treats
  all turns as marked until restart, preserving active marks without tracking
  unbounded overflow. A result whose server
  definition cannot be read counts as untrusted, and a called tool whose
  definition cannot be read asks.
- **Delegation.** A conversation that has read untrusted content marks every
  child it delegates to from the start. A child that reads it marks its
  parent and root conversations, and the parent's next result read from a
  delegation tool (`delegate_task`, `get_task`, `get_task_events`,
  `continue_task`, `respond_to_task_request`, `list_delegated_tasks`) marks
  that parent turn. A child fixes the inherited mark into its own turn the
  first time the ledger sees it, and a record an active turn depends on is
  never forgotten, so neither later activity nor the memory bound clears a
  question mid-turn.

The [staged pre-tool evaluator](../../src-server/runtime/agents/pre-tool-policy.ts)
answers the permission before tool grants:

- `ask` is a required question, like an authored ask-before-use. An Agent's
  `autoApprove`, a guardian allow or an unattended opt-in cannot answer it.
  With nobody present it is refused.
- `deny` refuses with a reason naming the setting.
- `allow` adds nothing; the tool's usual permission decides. An always-allow
  in the Agent's `autoApprove` then runs the tool without a question.

Changes go through the existing integration save
(`PUT /api/integrations/:id`, operator-gated) or any other definition write.
The locked storage writer (`saveIntegrationConfig` and
`updateIntegrationConfig`, which `ConfigLoader` and a plugin's required-tool
install use) keeps the stored receipts (`untrustedContentChanges`) read
under its mutation lock, ignores receipts in the incoming definition, and
appends one (time, the authenticated request principal when known, new
value) for a person change or explicit reset of the classification, a
permission or `trustReadOnlyHints`. A plugin's install, update and rollback publish its integrations
through one locked operation, `publishPluginIntegrations`: the plugin's
trees are staged privately, then every affected integration's lock is held
from reading the stored definitions through renaming sanitized trees into
place. External definitions and backups cannot supply classification,
permissions, hint settings, receipts or ownership. Station supplies the
trusted default outside the curated catalog; a person's stored choices win for a still-present
integration. A list of
validators runs on each definition under the lock; other owners, such as
tool-server OAuth client rules, add theirs there. A reader sees the old
definition, briefly none, or the sanitized one, never the plugin's raw
bytes. Install and uninstall recovery also restore backups through the locked
writer. If an integration was retired, its person settings and history no
longer exist in the current definition; restoration or later reintroduction
uses Station's classification and ask defaults. This is a known limitation until a
durable person overlay is available. For a still-present integration, a
concurrent save keeps its receipts. The last 50 are kept. The rule itself is
`withUntrustedContentChange` in the tool contract.

Person ownership is recorded per field, so a reset to an absent default stays
authoritative even after older receipts leave the 50-entry history, while the
integration remains present. CLI imports strip the supplied trust fields and
history at their own filesystem writer under the integration lock; they do not
assert a verified Station principal.

If install and compensation both fail, the response includes an opaque backup
id. The local durable server log records that id and its full backup path; the
startup temp sweep keeps marked recovery backups. A restore workflow that
checks newer state and stale grants is follow-up work, not an available command.

### Coverage and gaps

- **Enforced:** tools the Station engine dispatches through its hooks
  ([agent-hooks.ts](../../src-server/runtime/agents/agent-hooks.ts)). The
  Registry says so: "In Station-engine sessions, asks before tools that send
  or change things by default."
- **Not enforced on external engines.** Claude Code, Codex and ACP sessions
  build their evaluator in `StationRuntime.resolveExternalPreToolPolicy`
  without this stage, and their tool results are not reported to Station's
  hooks per turn. Station shows no claim of coverage there.
- **MCP prompts.** A prompt from an untrusted server (`/<server>:<prompt>`)
  is fetched by the composer and sent as the person's own message; the turn
  is not marked. Marking it needs the prompt's origin carried with the
  message into the turn, which this change does not add.
- **Delegation memory.** The delegation records live in the server's memory
  (the most recent 10,000 conversations per record, never forgetting one an
  active turn depends on) and do not survive a restart. A child that starts
  after its parent's turn ended and after 10,000 newer records, before its
  own first tool call, is not marked. A delegated child on an external engine does not report its
  reads.
- **Tools without integration settings.** A tool not loaded from an
  integration (Station's built-in bash, file editor, HTTP request) takes the
  default `ask` in a marked turn and has no per-tool setting yet.
- **Earlier turns.** Content read in an earlier turn stays in the
  conversation history but no longer marks the turn.
- **No settings UI yet.** The fields are edited through the tool's settings
  (Raw JSON) or the API.
