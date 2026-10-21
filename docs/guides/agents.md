# Configure Agents

This is the configuration reference for Agents: where an Agent is stored,
which fields it has, how its tools, shared Projects and guardrails work, and how
tool approval behaves in attended and unattended runs. To build an Agent or an
application with the SDK, use
[Develop Agents and applications](agent-development.md). Code conventions for
contributors live in [Frontend patterns](../patterns/frontend.md) and
[Backend patterns](../patterns/backend.md).

## Agent Configuration

Agents live in `<STATION_HOME>/agents/<slug>/agent.json`. The directory name is the agent's slug.

For full field reference see [docs/reference/config.md](../reference/config.md). Key fields:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `prompt` | Agent instructions (supports `{{key}}` template variables); delivered as a system prompt where supported, or with the first message on Codex and other first-turn engines |
| `model` | Station-engine model preference; see resolution order below |
| `execution.agentConnectionId` | Saved engine connection binding; absence selects Station's engine |
| `execution.modelConnectionId` | Model connection selection for Station's engine; separate from the engine binding |
| `execution.modelId` | Explicit model preference on that execution binding |
| `tools` | MCP server IDs, allow-list, auto-approve list |
| `guardrails` | `maxSteps`, `maxTokens`, `temperature` |
| `audience` | Who besides the operator may list, read and use the Agent; absent means operator only ([reference](../reference/config.md#audience)) |

### MCP Tool Configuration

The **Tools** section is shared by creating, copying, and editing an Agent.
Choose **Add tools**, search the list, then choose **Add**. The list covers MCP
sources and tool-providing plugins. Engine-native tools use their engine’s
settings. Each row shows its
source: Station, a registry, a plugin, or a connection on this Station. Open a
source for its description and actions. Click an action name for its description;
approval choices sit beside selected actions. **About this source** holds
provenance, Station-wide Project sharing and external connection settings. Click a registry name to browse its tools without leaving
the draft. Catalog browsing retains Project permissions and approval defaults.
**Origin not recorded** means provenance is missing, invalid, or no longer
matches the saved connection; it does not describe connection health.

When Station Control is available to an Agent, Personal Board authoring uses
three actions from that source: `list_personal_boards` and `get_personal_board`
are readers; `propose_personal_board` writes a private proposal. Search
**Add tools** for `propose_personal_board`, then open the matching source and
select those actions for an Agent that should build dashboards. Review the proposal action's approval choice beside its
selection. These tools cannot publish: the person reviews and applies the
proposal in the Board. **Build with chat** offers context in a new projectless
chat without sending it; see [Personal Boards](../user/personal-boards.md).

Station Control publishes native MCP titles, behavioral annotations and
`ai.kontour/tool-group` hints. These catalog hints do not grant access or change
approval rules. MCP has no standard category field; grouping does not require
separate servers.

On Station and Claude, newly added Station-classified reads default to **Always
allow**. Changes, unknown actions and publisher-classified reads default to
**Ask me**. Existing choices remain. Other engines show their supported controls;
explicit Ask rules refuse startup on an engine that cannot deliver them.
**Check for new tools** in source details fetches the current list without
changing selections. **Edit connection** opens the server settings. Built-in
Station sources need neither control. **Include new tools automatically** opts
into actions added later, with Ask protection on Station and Claude.

Operators can add catalog sources or **Connect your own source** without leaving
the Agent draft. Sources that need configuration open setup before attachment.
Tool-providing plugins use the existing package permission review. Catalogs mark
these with `providesTools: true`; this is a browsing hint, not a permission grant.

### Shared Projects

The Station operator installs and connects sources. Project Admins and Owners
can create and edit Project agents and attach permitted installed sources. An
uninstalled source offers **Request**, then **Pending**. The operator handles
requests in the existing Inbox, including connection or plugin consent setup.
Requests survive restarts and become available only when setup succeeds and the
Project still permits the source. Installation approval never widens an Owner's
selected policy.

Project **Tool permissions** defaults to all sources shared by the operator. A
Project Owner can select a smaller list. The operator can withdraw a source from
Projects using **About this source → Share with Projects**. This setting covers
all Projects on the Station; turning it off blocks new Project runs using the
source without uninstalling it. Already-running engines without pre-tool
interception cannot guarantee immediate withdrawal. Station Control remains
operator-only. Installed tools,
Project permissions and personal account sign-in are separate; installing a
source does not share someone's OAuth credentials. Personal tool accounts
require the managed Station engine; external engines cannot deliver that
principal-bound connection and report it as unsupported. Existing instance-level
credentials retain their existing execution semantics.

Open **Profile → My access** to see Station authority and roles across Projects.
Admins and Owners can reach **Agents and tools** there and from their shared
Project. Shared Project pages load Agent management only when it is opened;
viewers and contributors do not load the tool catalog. This authoring surface does not enable member agent execution: member
turns remain refused by the existing execution gate. Computer contribution and
execution authority remain separate requirements. The engine picker includes
managed **Station** alongside installed engines. Station Agents keep no external
engine binding; editing and saving preserves that choice and its tool approvals.

New and recovered sessions both recheck authored tools against current Project
permissions. Missing Agent definitions or unreadable Project policy refuse
engine startup; the conversation stays recoverable after the cause is fixed.

**Browser access** is a separate Agent capability. The current delivery path
connects Claude Code to the Project's Station browser; other engines disclose
that this delivery is unavailable. **Workflow files** holds the workflow editor.
Browser access is independent of attaching MCP sources. See the
[browser and computer capability proposal](../design/agent-interaction-capabilities.md)
for the proposed cross-engine behavior; it is not implemented.

Claude and Codex offer **Keep harness tools**. New Agents add integrations to
the harness configuration; existing Agents keep their previous behavior until
you change this switch. Turning it off replaces the configured MCP list; the harness keeps its built-in tools. Claude
also offers **Harness default**, **On demand**, and **Always available** loading.
On demand uses Claude's native tool search and requires a compatible model and
endpoint; it is not a Station search proxy. Other engines keep their own loading
behavior.

`tools` selects MCP connections and exposed tools. Station applies its runtime
filter; Claude applies SDK exclusions plus a pre-tool refusal, and Codex receives
its native `enabled_tools` / `disabled_tools` configuration. Station Control also
filters its served catalog and calls to the session's selection. Engines reached
through the generic connected-engine protocol cannot deliver individual-tool
selection: a restricted integration is reported undelivered rather than widened.
An explicit conversation engine override refuses required profile capabilities
that cannot actually be delivered; it does not start with a reduced profile.
See [execution overrides](../reference/session-api.md#preserve-an-agent-profile-with-an-execution-override).
External policy delivery follows the [engine policy contract](../conformance/tool-policy-delivery.md):

```json
{
  "tools": {
    "mcpServers": ["filesystem", "github"],
    "available": ["read_file", "list_directory", "create_pull_request"],
    "autoApprove": ["read_file", "list_directory"]
  }
}
```

- `mcpServers` — IDs of MCP servers to connect (each defined in `<STATION_HOME>/integrations/<id>/integration.json`)
- `mcpMode` — `add` preserves harness integrations; `replace` supplies only the Agent's list. Omission retains legacy engine behavior
- `mcpLoading` — `on-demand` or `always`, delivered through Claude's `ENABLE_TOOL_SEARCH`; omission preserves the harness setting
- `available` — allowlist of tool names exposed to the agent; omit or set `["*"]` to expose all tools from connected servers; an empty list exposes none from these integrations
- `autoApprove` — patterns consulted for automatic approval; they do not override earlier runtime-generation, delegation or configuration-protection refusals. A pattern covers plain calls to a tool and never an escalation or a plan exit, even `*` (see [below](#what-autoapprove-never-covers))
- `askBeforeUse` — requires a person on Station and Claude, even after a session grant or guardian allow. Exact choices override wildcard defaults; Ask wins equally specific conflicts. Earlier refusals and guardian denies still apply. Without an approval channel the call is denied
- `unattendedAutoApprove` — explicit opt-in for tools the agent may run when nobody is there to confirm (see [Unattended runs](#unattended-runs))

The picker writes approval keys as `mcp/<server>/<action>`, with
`mcp/<server>/*` for future-tool Ask defaults. Legacy names remain readable;
legacy flattened Always grants cannot override these source Ask defaults.
Server and action components are percent-encoded; literal `*` becomes `%2A`
except the terminal source wildcard. These approval keys are separate from `available` selections.

`tools.aliases` is retired. Older files still load because the loader removes
that key before validation, and the next save omits it. It did not rename tools
at execution time. Use the exposed tool names; see the
[configuration loader](../../src-server/domain/config-loader-agents.ts).

Station negotiates MCP automatically. It tries the current `2026-07-28`
discovery flow first and falls back to the legacy `initialize` flow when a
deployed stdio server is older. Existing integration files do not need a
protocol-version field, and there is no era selector to maintain.

### Guardrails

For the Station engine, guardrails constrain model inference per Agent. External
engines apply only the controls their adapter and live capabilities support; a
Station guardrail declaration does not establish external enforcement:

```json
{
  "guardrails": {
    "maxSteps": 30,
    "maxTokens": 8192,
    "temperature": 0.3
  }
}
```

- `maxSteps` — maximum agentic steps per turn before the runtime halts the loop
- `maxTokens` — maximum output tokens per model call (overrides `defaultMaxOutputTokens` from app.json)
- `temperature` / `topP` — standard inference parameters. On VoltAgent, `topP` is ignored when `temperature` is also set (see the [config reference](../reference/config.md)).
- `stopSequences` — accepted and typed, but not currently applied by any engine. Do not rely on it to constrain model output.

---

## Agent Lifecycle

For Station-engine Agents, the server loads and manages this lifecycle.
External-engine Agents use the canonical [Session API](../reference/session-api.md)
and their own adapter; they are not entries in this native `activeAgents` loop:

```
load → MCP connect → ready → chat → reload
```

1. **load** — `station-runtime.ts` reads the Agent configuration and resolves its connection and model. Model preference is `execution.modelId` → `spec.model` → connection default → app `defaultModel`; the selected connection determines the provider, not a hardcoded Bedrock choice. The native runtime creates the Agent's conversation memory adapter.
2. **MCP connect** — for each distinct entry in `tools.mcpServers`, Station owns one negotiated MCP connection, loads the raw tool schemas and metadata, and shares that connection across agents that use the integration
3. **ready** — the agent is registered in `activeAgents` and available for requests
4. **chat** — `POST /api/agents/:slug/chat` streams a response; the runtime creates an `InjectableStream` to interleave approval events with model output
5. **reload** — `reloadAgents()` prepares the replacement connection set, publishes the new agents, and retires superseded connections without a full restart

Read health through the Agent health endpoint. This guide does not promise a
periodic `agent-health` event. The model-resolution owner is
`src-server/runtime/plugins/runtime-provider-resolution.ts`.

`POST /api/agents/:id/chat` is the Station-engine route. For an external-engine
Agent it returns HTTP 409 with guidance to use `POST /api/orchestration/chat`;
it does not forward or redispatch that request. Use the canonical Session API
when a client must support either engine kind.

---

## Tool Approval Flow

In attended Station-engine chat on the per-Agent route, tools not otherwise
approved pause for user confirmation. This section describes that route’s
legacy SSE approval transport. Canonical orchestration clients instead read
`request.opened` and send `respondToRequest` through the
[Session API](../reference/session-api.md#respondtorequest).

The [staged evaluator](../../src-server/runtime/agents/pre-tool-policy.ts)
can allow, deny, or request an interactive decision. It checks current runtime
generation, delegation and configuration protection before grants; the approval
guardian can also decide a call. The following is the interactive branch, not
every possible tool outcome:

1. `beforeToolCall` invokes the staged policy with the current invocation.
2. If the result requires interaction and a requester exists, the hook calls
   `requestApproval` (wired per conversation by the chat handler).
3. `requestApproval` injects a `tool-approval-request` SSE event into the stream
4. The client renders a confirmation UI and `POST /tool-approval/:approvalId` with `{ approved: true/false }`
5. `ApprovalRegistry.resolve()` unblocks the hook; the tool executes or is skipped

The `InjectableStream` wrapper ensures approval events are emitted in the correct position in the SSE stream, even when the model is mid-reasoning. An injected event is emitted as soon as it is injected rather than waiting for the model's next chunk, so a request raised while a tool call blocks (an MCP server's form elicitation, #3284) still reaches the person; see the [MCP host design](../design/mcp-ui-host.md#elicitation-path).

### Pending approvals in the Inbox

`/notifications` is the Inbox: it puts active operator attention ahead of
ordinary notification history. An approval or `review_pending` item with an
exact request reference opens the request's decision controls. An approval
without that reference uses its persisted notification's Allow/Deny actions;
`review_pending` without one opens the session. `needs_input` sends a normal
orchestration turn to the owning session. An item for a delegated task that
runs on a paired Station offers no reply. It says to answer on that Station
and opens the Activity detail. The header
badge is the same deduplicated active-attention count shown in the Inbox.
Concrete approval requests suppress a duplicate lifecycle item for the same
session. Gate exceptions also suppress that session's lifecycle duplicate;
gate route-back and blocked items remain separate and offer re-evaluation.
The Inbox can accept a gate exception, while Survey/Flow gate-review items
open the review workbench for decisions and continuation.

The [attention projection](../../src-server/services/projects/attention-projection.ts)
derives these items from their owning sources. Acknowledgement removes an item
from the pending count while retaining it in history; it does not resolve the
underlying approval or review. Hosted reads omit sources whose stores cannot
enforce tenant ownership. See the [Session API attention contract](../reference/session-api.md#review-work-in-the-attention-inbox).

### Questions from agent harnesses

Claude Code's `AskUserQuestion`, Codex's `requestUserInput` and Cursor's
questions appear as one form in the Session, rendered by the same card as a tool server's form
(#3390): inline on desktop, and in the request sheet on a phone. Each
question keeps the engine's short header above it, when it has one. Select an
option, choose several where the harness supports it, or choose Other to
enter a custom answer (Cursor's questions offer no Other: Cursor takes back
only the options it offered). Send checks every question first; an unanswered one is
marked on its own field with its reason, and focus moves to the first.
Ctrl/Cmd+Enter sends. Decline and Cancel return that action to the engine
instead of an answer. Answering a question never grants permission to later
tool calls, including under wildcard auto-approval.

Non-private drafts are saved on this device for the exact request and verified
Station authority. Without that verification or available storage, the draft
stays in the tab. Private answers are masked as you type and aren't saved as
drafts; this does not promise secrecy in the engine's own history. A failed
send keeps the entered answers. Optional Codex questions remain answerable
without pausing the running Session. Every question, form and approval with no
tool row of its own leaves a transcript record that shows what became of it
(answered, declined, cancelled, allowed, denied), including when it was
answered on another device.

### What autoApprove never covers

A pattern allows plain calls to a matching tool. It never answers a request
that reaches beyond the call or a plan exit, even when the pattern is `*`. On
Claude Code these always reach a person:

- a path outside the session's working directories on a single command or
  call (a `Read` pattern means reading the workspace, not reading anywhere),
  or a suggestion to widen them;
- a single command or call forced to ask by a `permissions.ask` rule, when
  the engine reports the rule that matched;
- a safety check the engine raises, on a read, a file edit (a sensitive
  file such as `.git/config`) or a shell command (the engine allows reads
  inside the working directories itself, so any Read, Glob, Grep or LSP ask
  it raises prompts);
- a single command or call a `permissions.ask` rule forced to ask, whether
  or not the engine names the rule, including a WebFetch domain rule
  (#2932);
- a chained Bash command (`a && b`, a pipeline) when any part raises a
  safety check, and every PowerShell command (#2932);
- a sandbox network-host ask (each new host prompts), a call that disables
  the sandbox, a tool whose approval is the user's own interaction, and an
  MCP tool the organization requires approval for (#2932);
- `ExitPlanMode`, so a plan is always reviewed.

On ACP engines a plan exit (a `switch_mode` tool call, `ExitPlanMode`, or
Cursor's plan review) always prompts, and answering it "for this session" allows that one exit
only. ACP reports no other escalation signal. Codex and Muse do not
honour `autoApprove`. Station reads why Claude Code asks from the engine's
own request, and a request it cannot read counts as an escalation, so a
pattern never answers one. A pattern such as `Bash` covers chained commands
too, and the engine does not report what their parts raise. So the first
two items above do not hold inside a chained Bash command: a
`permissions.ask` rule on the chain or on one part (when more than one part
needs approval), a write or delete outside the working directories in an `&&` or
`;` chain or behind a pipeline's output redirect, and a part's non-safety
warning are answered by the pattern. A safety check on any part still
prompts ([delivery boundary](../conformance/tool-policy-delivery.md)).

An approval-guardian allow has the same limits on these engines (#2947). The
guardian reviews the tool's name and arguments (and, on ACP, the call's
title); it isn't shown the session's working directories or why the engine
asks. On Claude Code its allow answers a plain call without a prompt, unless an
effective authored Ask rule requires approval, for the input it reviewed, and everything in the list above still reaches a person,
including a read outside the working directories that the guardian allowed.
Like a `Bash` pattern, a guardian allow answers a chained Bash command,
including the chained-command gaps described above: an ask rule or an
outside-directory write hidden inside the chain does not prompt. On ACP engines its allow answers any call except a
plan exit, a question, or a sandbox network-host ask. A guardian deny in
`enforce` mode still blocks the call. A delegated child that cannot grant
approvals is denied an escalation at once, guardian allow or not. With the
guardian enabled, a headless run on these engines that reaches an escalation
waits on an approval request where it used to run on the guardian's allow.

### Unattended runs

A run with nobody to confirm a tool call — a scheduled job, `/invoke`, the CLI,
or a delegated child session that cannot grant approvals — never waits on an
approval request. Station's engine either allows the call without asking or
denies it.

Sessions started by an [inbound webhook](inbound-webhooks.md) or the
[Discord gateway](discord-gateway.md) are also unattended: nobody can answer an
approval request from the webhook caller or from Discord.

External engines differ. On Claude Code and ACP, `autoApprove` does not cover
escalations or plan exits, even for `*` ([what autoApprove never covers](#what-autoapprove-never-covers)).
A headless run on those engines that reaches one waits on an approval request
until someone answers it (for example from the approval inbox). A delegated
child that cannot grant approvals is denied the call at once. On Claude Code
every PowerShell call is such an escalation, so a `PowerShell` pattern
answers nothing there: a headless run waits on each PowerShell call, and a
child that cannot grant approvals is denied it.

`autoApprove` is attended auto-approval. Attended chat matches a pattern against
both the original MCP tool name (`station-control_delete_agent`) and the runtime
name the model calls (`stationControl_deleteAgent`). Unattended runs match
legacy `autoApprove` against the runtime name only, so the usual
`station-control_*` pattern does not apply there. Exact loader-qualified
`mcp/station-control/list_agents` keys also apply unattended. Existing patterns
that match the runtime name, including `*`, keep working as before. Effective
Ask rules still require a person.

To let an agent run a tool unattended, list it in `unattendedAutoApprove`. For
a scheduled job, an operator can instead record an unattended tool grant for
that job alone through `/api/agents/unattended-grants`, keyed by the exact
runtime tool name (the name a denial quotes).

Example:

```json
{
  "tools": {
    "autoApprove": ["station-control_*"],
    "unattendedAutoApprove": ["station-control_list_agents"]
  }
}
```

`unattendedAutoApprove` uses the same pattern syntax and name forms as
attended `autoApprove`. It is honoured only after the other pre-tool checks: a
delegated child's allow and block lists and config protection still apply, and
the approval guardian is consulted before the opt-in. The guardian is **off by
default**. When enabled, its default mode is `review`; `enforce` is optional:

- In `review` mode, an `allow` authorizes execution and skips the attended
  approval prompt unless an explicit `askBeforeUse` rule requires it. A `deny`
  or `defer` leaves the ordinary approval and unattended opt-in rules to decide.
  Review mode is not advisory-only: an `allow` has authority.
- In `enforce` mode, a call that isn't already auto-approved (by `autoApprove`
  or an intrinsic grant, which allow before the guardian runs) runs unattended
  only on a guardian allow. A deny blocks it, and so does a defer — including
  the guardian's own fallback when its review fails or returns no usable
  verdict — because nobody is present to decide. This applies to
  `unattendedAutoApprove` and to a per-job grant alike. An explicit
  `askBeforeUse` rule still requires a person.

An `allow` in either mode overrides the ordinary unattended refusal and the
delegated child's `denyApprovals` denial. Scheduled, CLI and `/invoke` runs can
therefore execute tools that are not in `unattendedAutoApprove`. There is no
built-in destructive or sensitive tool-class ceiling on guardian allows.
Explicit `askBeforeUse` rules, Project policy and the preceding allow/block and
config-protection checks still bound execution.

Structured generation now reaches the configured model on both VoltAgent and
Strands. Previously, their schema adapter errors made guardian reviews fall back
to `defer`; configured guardians can now issue real `allow` and `deny` decisions.
Their modes and policy are unchanged; malformed or missing decisions still defer.
**If your installation already has `approvalGuardian.enabled: true`, review its
guardian mode and instructions before relying on these restored decisions.**

Tool names, descriptions and arguments remain untrusted model input. Fencing
keeps them separate from the guardian's instructions, but a prompt-injected tool
argument can still persuade the model to return `allow`.

Attended chat ignores `unattendedAutoApprove`; when the guardian defers, it asks
the person as before. External engines (Claude Code, ACP) do not deliver Station's
unattended checks ([delivery boundary](../conformance/tool-policy-delivery.md)),
so the opt-in has no effect on them.

### Tool purpose display support

Station can invite an agent to state a short purpose for a tool call only when
Station owns both the model-visible object schema and the execution adapter.
The purpose is untrusted display text; it never changes approval or policy.

| Tool source | Purpose field | Executor arguments |
| --- | --- | --- |
| Station-owned Strands tool with a plain object schema | Supported | Reserved metadata is stripped before execution |
| Station-owned VoltAgent tool with a plain object schema | Supported | Reserved metadata is stripped before execution |
| Composed, `$ref`, non-object, or colliding schema | Not injected | Arguments remain unchanged |
| MCP/provider tool or external Claude, Codex, or ACP schema | Not injected | Arguments remain unchanged |

The canonical event keeps actual tool identity, arguments, status, provenance,
and optional stated purpose as separate fields. History, replay, approval
previews, and live rows therefore agree without treating purpose as evidence
that a call is safe. The native framework adapter binds the purpose from the
first real tool-call stream event before Station publishes `tool.started`;
framework lifecycle hooks may run later and cannot be used as the ordering
source for the live row.

---

## Agent Hooks

`agent-hooks.ts` provides framework-agnostic hooks for the Station engine’s
native framework adapters. External engine adapters own their own event and
approval paths; these hooks do not establish external policy enforcement.

| Hook | When it fires | What it does |
|------|--------------|--------------|
| `beforeToolCall` | Before any tool executes | Checks auto-approve; triggers approval flow if needed |
| `afterToolCall` | After a tool returns | Debug logging |
| `afterInvocation` | After the full turn completes | Updates conversation stats (tokens, cost, tool call count) in the memory adapter |

`afterInvocation` also enriches the last assistant message with model metadata and pricing from the Bedrock model catalog.

---

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/agents/:slug/chat` | Station-engine streaming chat (SSE); external engines return 409 |
| `POST /api/orchestration/chat` | Canonical Environment + Agent execution entry for either engine kind |
| `POST /agents/:slug/invoke` | Silent tool invocation (no stream) |
| `POST /agents/:slug/invoke/stream` | Streaming invoke with optional JSON schema output |
| `GET /agents/:slug/tools` | List tools with full schemas |
| `PUT /agents/:slug/tools/allowed` | Update tool allow-list |
| `POST /tool-approval/:approvalId` | Resolve a pending tool approval |
| `GET /agents/:slug/health` | Agent health check (MCP connection status) |
