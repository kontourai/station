# MCP subregistries, Station curation and untrusted content

> **Reading status: current design for #3483's first slice.**
> [Subregistry source](../../src-server/providers/registries/mcp-subregistry.ts),
> [catalog provider](../../src-server/providers/registries/mcp-subregistry-provider.ts),
> [curated snapshot](../../packages/shared/src/curated/station-mcp-subregistry.json)
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
| GitHub | `https://api.githubcopilot.com/mcp/` | pre-registered client required | setup-required |
| Gmail (Google Developer Preview) | `https://gmailmcp.googleapis.com/mcp/v1` | pre-registered client required | setup-required |

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
whose sign-in then fails. The Station runtime composition root registers
pre-registered client support with one
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
`STATION_MCP_SUBREGISTRY_ALLOW_PRIVATE_ADDRESSES=1`. Tool servers
added by hand under **Connections → Tools** are unaffected.

A public name can still resolve to a private address later, so the same
rules apply when Station connects
([remote-address-guard.ts](../../packages/shared/src/remote-address-guard.ts),
[remote-mcp-address-policy.ts](../../src-server/services/plugins/remote-mcp-address-policy.ts)).
For a server a catalog added (its recorded origin is a registry, or the
origin record cannot be read), each connection resolves each hostname once,
refuses the name if any address it gets is private, and connects only to the
addresses it checked. The URL, TLS server name and `Host` header keep the
hostname, and redirects are not followed. This covers Station's own MCP
client (including OAuth discovery and sign-in through the transport), the
OAuth proxy external engines use, and Station's token refresh. Station never
hands such a server to Claude Code or Codex to connect to directly: without
the proxy the session is refused, because Station could not check the
addresses the engine reaches. ACP sessions receive no remote servers. The
operator opt-in above also allows private addresses here.

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
- **Later turns.** The mark is also kept for the conversation
  ([untrusted-conversation-marks.ts](../../src-server/services/plugins/untrusted-conversation-marks.ts)):
  once any turn reads untrusted content, every later turn of that
  conversation, and every child it delegates to, is marked, including after
  a restart. The record sits beside the conversation acknowledgement store
  in the Station home, keyed by conversation id. A later turn waits for a
  mark whose classification read has not settled. The record holds 10,000
  conversations; past that it records saturation instead of forgetting one,
  and every conversation counts as marked. A record Station cannot read
  counts as marked. Only the operator, signed in as a person, can clear a
  mark: `POST /api/integrations/untrusted-content/conversations/:id/clear`
  (`*` clears every mark and the saturation) records a receipt with the
  time and the person, and
  `GET /api/integrations/untrusted-content/conversations/:id` shows the mark
  and its receipts
  ([routes](../../src-server/routes/agents/untrusted-content-routes.ts)).
  There is no button for this yet.

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
writer. A versioned person overlay outside the integration directory retains
explicit settings, resets and receipts through retirement and reintroduction.
Legacy person fields are migrated under the integration lock: the overlay is
published before removing them from the definition, so an interrupted migration
can be retried. Legacy grant-expanding values whose ownership cannot be verified (a
`trusted` classification, an `allow`, trusted read-only hints) are refused
for person review; the definition and its history are retained, and the
integration does not load. The integration list and
`GET /api/integrations/:id` show it with `trustReview` (the stored values,
not applied) and without those settings; Connections → Tools shows **Needs
your review** whether or not the trust settings preview is on
([review panel](../../src-ui/src/views/integrations/IntegrationTrustReview.tsx)).
`POST /api/integrations/:id/trust-review` with `keep` or `reset` (operator,
signed in as a person) publishes the overlay under the integration lock with
the kept values or Station's defaults and a receipt naming the person; the
definition then loads normally.
An unreadable overlay refuses the read. Person deletion clears
the overlay. A concurrent save keeps its receipts. The last 50 are kept. The rule itself is
`withUntrustedContentChange` in the tool contract.

Person ownership is recorded per field, so a reset to an absent default stays
authoritative even after older receipts leave the 50-entry history, while the
integration is retired. CLI imports strip the supplied trust fields and
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
- **External engines (Claude Code, Codex, ACP).** Enforced on every MCP call
  Station carries for them
  ([mediated-untrusted-content-gate.ts](../../src-server/services/plugins/mediated-untrusted-content-gate.ts)):
  station-control calls, at the station-control authority guard, and calls to
  remote servers signed in through Station's OAuth proxy, at the proxy. A
  proxied `tools/call` result from an `untrusted` server (or one whose
  definition cannot be read) marks the session durably. In a marked session
  each call that sends or changes things (station-control tools that are not
  read-only; proxied `tools/call` without a trusted read-only hint) takes the
  tool's permission: `deny` refuses, `allow` passes, and `ask` passes only
  on a person's approval of that tool in that session, recorded when an
  authenticated person (not a station-control call) accepts the engine's
  request for it; one approval admits one call within ten minutes. Neither
  seam can ask a person itself, so an `ask` without an approval is refused.
  Claude Code and ACP route their tool requests through the external staged
  evaluator, which now applies the same permission, so they ask the person
  for an `mcp__<server>__<tool>` call in a marked session. Station's
  pre-tool evaluator does not run for Codex's MCP calls, so a gated Codex
  call that would ask has no approval and is refused; set the tool to
  `allow` or `deny`. A route several station-control
  tools share takes the strictest of their permissions.
- **Servers an engine connects to itself.** Stdio servers (Claude Code, Codex
  and ACP spawn or reach them) and remote servers Station hands over without
  its proxy are called directly by the engine. Station cannot gate those calls
  or see their results, so their content does not mark the session. The
  integration API (`engineCoverage` on `GET /api/integrations` and
  `GET /api/integrations/:id`) and **Other engines** in the trust settings
  show this per engine: `station-gated`, `engine-direct` or `not-delivered`,
  derived from the transport and how Station delivers the server. Claude
  Code's pre-tool hook still asks for those calls in a marked session, but
  that is not enforcement. External-engine marks are keyed by the session;
  another session of the same conversation is not marked by them.
- **MCP prompts.** The composer carries the source of `/<server>:<prompt>`
  through the foreground send and Station's authorized relay. The Station
  engine marks the turn before its first tool when that source is untrusted
  or unreadable. A Station that cannot carry the origin refuses the send.
  Prompt sends to another Station or an external engine, and prompt steering
  into an active turn, are refused rather than sent without the mark.
- **Delegation memory.** The parent-to-child direction reads the durable
  conversation mark, so it survives a restart. The child-to-parent record
  (a parent turn marked by a child's result) lives in the server's memory
  (the most recent 10,000 conversations, never forgetting one an active turn
  depends on); the child's own conversation stays marked durably.
- **Built-in tools.** Station's bash, file editor and HTTP request use their
  integration's per-tool permission when their loader-owned identity is
  available. An unknown tool without verified identity asks by default.
- **Engine-native web reads (#4828).** Reading the web with an engine's own
  tools sets the same mark as an `untrusted` integration's result
  ([native-web-read-marks.ts](../../src-server/services/plugins/native-web-read-marks.ts)).
  `GET /api/integrations/untrusted-content/coverage` returns
  `nativeWebReads` (`NativeWebReadCoverage` in the tool contract) per
  engine. An engine Station cannot see is `uncovered`, never assumed safe:

  | Engine | Coverage | Marked from | Not seen |
  | --- | --- | --- | --- |
  | Station | covered | `afterToolCall` of the HTTP request built-in; marks the turn and the conversation | |
  | Claude Code | covered | an in-process `PostToolUse` hook Station registers, when `WebFetch` or `WebSearch` returns, in a subagent too | |
  | Codex | covered | a completed `webSearch` item (search, page open, find in page) on the app-server stream, the session's or a subagent's | after the mark, Station's pre-tool policy still does not run for Codex's own file changes and commands |
  | ACP | partial | a tool call the agent reports with kind `fetch` | a web tool the agent reports as another kind |
  | muse | uncovered | nothing: Station does not know which muse tools read the web, and muse has no hook Station can install | every web read |

  On every engine, a shell command that downloads (`curl`, `wget`) is not
  recognised as a web read. Station's browser tools mark the caller's session
  and conversation at the browser-agent route, for every engine they are
  delivered to, on each authorized call except `browser_status` and
  `browser_close` (the call is marked before it runs). The mark is recorded
  before the hook or handler returns, so the engine's next pre-tool check
  sees it; Claude Code may still run a call it batched alongside the read.
- **Instructions and git hooks after a mark (#4828): a best-effort early
  check, not containment.** For the rest of a marked conversation, and in
  every conversation it delegates to, Station denies writes to known
  instruction-file and git-hook locations by path, before the tool runs.
  **This does not contain git hook execution.** A path check before a tool
  runs cannot see every place git will run a hook from; six ways around it
  have run a planted hook (below). Enforcement at the OS level is
  [#4860](https://github.com/kontourai/station/issues/4860).

  The staged pre-tool evaluator refuses a write, move, rename or copy with
  any endpoint at one of these locations:
  - an agent-instruction file (`AGENTS.md`, `AGENTS.override.md`,
    `CLAUDE.md`, `CLAUDE.local.md`), at any depth;
  - anything under `.agents/`, `.claude/` or `.codex/`;
  - a project's `.mcp.json`;
  - a repository's `.git/hooks/**` or `.git/config` (a worktree's or
    submodule's under `.git/` too);
  - the conventional hook folders `.githooks/` and `.husky/`;
  - the `core.hooksPath` git reports for the repository that contains an
    absolute write target.

  The checks are in
  [untrusted-persistence-protection.ts](../../src-server/services/plugins/untrusted-persistence-protection.ts).
  The hooks path comes from git (`git -C <root> config --type=path --get
  core.hooksPath`, a fixed argument list with no shell, prompt or pager, and
  a short timeout). That command reads configuration only and runs no hook,
  `core.fsmonitor` or other program the repository names; a test pins this.
  When git is missing or cannot answer, every folder a raw `hooksPath` line
  names is checked instead, and every `git config` shell command asks.

  A shell command asks the person, because Station cannot tell what a shell
  command does, when it:
  - names one of these locations;
  - sets a value with `git config`;
  - gives git a global option before its subcommand that configures it or
    points it elsewhere (`-c`, `--config-env`, `--git-dir`, `--work-tree`,
    `--exec-path`, `--namespace`), or any global option Station does not
    recognise;
  - or assigns `GIT_DIR` or `GIT_CONFIG*`.

  A loaded MCP tool is classified by its original name from the loader, and
  tool names compare without case or separators. Paths are compared by
  segment, case-insensitively.

  A delegated child gets the check when its parent or root is marked. A
  child's untrusted read reaches its parent with the child's result: when
  the parent reads it through a delegation tool (the Station engine's
  `afterToolCall`, Claude Code's `PostToolUse`, and the station-control
  guard for any engine), or when Station delivers the result into the
  parent's conversation. Either marks the parent durably.

  The check runs wherever the staged evaluator runs: the Station engine,
  Claude Code's `PreToolUse` and ACP's named permission requests. ACP edit,
  move and delete requests are also checked from their kind, locations and
  input, whether or not the agent named the tool.

  Known gaps, each shown in verification to run a planted hook after a mark
  ([#4860](https://github.com/kontourai/station/issues/4860)):
  - a `core.hooksPath` naming an absolute directory outside the repository,
    set locally or globally;
  - a bare repository's hooks, where a receive hook runs on push;
  - a repository nested inside another repository's hooks folder;
  - a hooks folder reached through a symlink (paths compare lexically);
  - a writable `[include]` file that retargets `core.hooksPath` (only the
    value at check time is known, and the fallback without git does not read
    includes);
  - git invoked inside a quoted `sh -c "…"` payload or through a shell
    alias.

  Other limits:
  - a write through any other link whose name is not checked;
  - a path a command builds at run time;
  - a relative path's effective hooks folder (only its name is checked);
  - Codex's own file changes and commands, which never reach the evaluator;
  - the child-to-parent record is held in memory until the parent reads the
    result. A restart in between leaves only the child marked; the delivery
    path then marks the parent from the child's durable mark.

  Flow Agents config protection (linter configuration in opted-in
  workspaces) is unchanged. A confined session's sandbox keeps `.git/hooks`
  and `.git/config` read-only whether or not the conversation is marked. To
  make such a change after a mark, make it yourself or clear the
  conversation's mark.
- **Earlier turns.** Covered: a conversation stays marked until a person
  clears it (above).
- **Settings UI.** The Content trust settings Feature Preview exposes the
  classification, permissions, hint trust, and receipts in Connections →
  Tools. The operator API remains available independently of the preview.
