# Agent Development Guide

> **Keep this file minimal.** This is a quick reference that points to detailed docs. Add specifics to the pattern files, not here.

## For AI Coding Assistants

When working on this codebase:

1. **Check pattern docs first** - Review the relevant pattern file before implementing
2. **Follow established patterns** - Use existing patterns rather than inventing new approaches
3. **Update docs when patterns are missing** - Add new patterns to the appropriate file
4. **Ask if unclear** - If a pattern isn't documented and you're unsure, ask before proceeding
5. **No TypeScript shortcuts** - Understand types before fixing errors; don't blindly use `as any`

### Pattern Documentation

| Area | File | When to Read |
|------|------|--------------|
| Frontend | [Frontend Patterns](../patterns/frontend.md) | React, hooks, styling, SDK, plugins |
| Backend | [Backend Patterns](../patterns/backend.md) | Routes, services, Station runtime, routes |

**Update these docs when:**
- You implement a reusable pattern not yet documented
- You discover a pitfall that others should avoid
- You establish a convention for a new area

---

## Agent Configuration

Agents live in `<STATION_HOME>/agents/<slug>/agent.json`. The directory name is the agent's slug.

For full field reference see [docs/reference/config.md](../reference/config.md). Key fields:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `prompt` | System instructions (supports `{{key}}` template variables) |
| `model` | Station-engine model preference; see resolution order below |
| `execution.agentConnectionId` | Saved engine connection binding; absence selects Station's engine |
| `execution.modelConnectionId` | Model connection selection for Station's engine; separate from the engine binding |
| `execution.modelId` | Explicit model preference on that execution binding |
| `tools` | MCP server IDs, allow-list, auto-approve list |
| `guardrails` | `maxSteps`, `maxTokens`, `temperature` |
| `audience` | Who besides the operator may list, read and use the Agent; absent means operator only ([reference](../reference/config.md#audience)) |

### MCP Tool Configuration

Open an Agent's **Tools** section to add integrations. **Station**
adds read-only built-in controls; expand the row to choose **Read only**, **All**,
**None**, or individual tools. Use the group picker to narrow Station controls to
Knowledge, Projects, Tasks, Scheduling, and other areas. The three shortcuts apply
to the chosen group and preserve choices elsewhere. Search narrows the checklist. The shield opens approval settings; the gear
opens harness settings. **Advanced** contains browser and workflow options.
Saved changes apply to new chats. Hover over or click an info icon for field
explanations and engine capabilities. Keyboard users can press Enter to open it,
use arrow or Page keys to scroll long help, and press Escape to dismiss it.

Station Control publishes native MCP titles and behavioral annotations. The
`ai.kontour/tool-group` vendor metadata organizes the picker; third-party
integrations can supply the same display hint. It does not grant access or
change approval rules. MCP has no standard category field; grouping does not
require separate servers.

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
- `unattendedAutoApprove` — explicit opt-in for tools the agent may run when nobody is there to confirm (see [Unattended runs](#unattended-runs))

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
- `temperature` / `topP` — standard inference parameters
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

### Questions from agent harnesses

Claude Code's `AskUserQuestion` and Codex's `requestUserInput` appear as one
form in the Session, rendered by the same card as a tool server's form
(#3390): inline on desktop, and in the request sheet on a phone. Each
question keeps the engine's short header above it, when it has one. Select an
option, choose several where the harness supports it, or choose Other to
enter a custom answer. Send checks every question first; an unanswered one is
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

On ACP engines a plan exit (a `switch_mode` tool call, or `ExitPlanMode`)
always prompts, and answering it "for this session" allows that one exit
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
asks. On Claude Code its allow answers a plain call without a prompt, for the
input it reviewed, and everything in the list above still reaches a person,
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
`autoApprove` against the runtime name only, so the usual
`station-control_*` pattern does not apply there. Existing patterns that do
match the runtime name, including `*`, keep working unattended as before.

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
the approval guardian is consulted before the opt-in. The guardian has two
modes, `review` and `enforce`:

- In `enforce` mode, a call that isn't already auto-approved (by `autoApprove`
  or an intrinsic grant, which allow before the guardian runs) runs unattended
  only on a guardian allow. A deny blocks it, and so does a defer — including
  the guardian's own fallback when its review fails or returns no usable
  verdict — because nobody is present to decide. This applies to
  `unattendedAutoApprove` and to a per-job grant alike.
- In `review` mode, the guardian never blocks the opt-in.

Attended chat ignores `unattendedAutoApprove` and asks as before; there a
guardian defer still means asking the person. External engines (Claude Code,
ACP) do not deliver Station's unattended checks
([delivery boundary](../conformance/tool-policy-delivery.md)), so the opt-in
has no effect on them.

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

---

## Quick Reference

### Core Boundaries

| Location | Contents |
|----------|----------|
| `src-ui/src/` | Core app: Contexts, SDK Adapter, App Shell |
| `packages/sdk/` | SDK: Query hooks, API utilities, Types |
| `examples/*/` | Plugins: Components, ViewModels, styles |

Use the public SDK and contracts for Station APIs. Plugins can also use their
declared package dependencies; they must not import private app modules.

### Cross-Tab Navigation

Legacy Layout tabs use the SDK navigation hooks. This example runs inside the
`my-layout` navigation provider; tab state belongs to that layout's scope.
Workspace Pane placement has its own [host contract](workspace-pane-authoring.md).

```typescript
import { useNavigation, useLayoutNavigation } from '@kontourai/station-sdk';

const nav = useNavigation();
const { setTabState, getTabState } = useLayoutNavigation();

// Select another tab in the current layout:
setTabState('crm', new URLSearchParams({ selectedAccount: accountId }).toString());
nav.setLayoutTab('my-layout', 'crm');

// Read state on the receiving tab:
const state = getTabState('crm');                  // read in useEffect([activeTab])
const params = new URLSearchParams(state);
const selectedAccountId = params.get('selectedAccount');
```

**Rules:**
- `setTabState(tabId, state)` writes to sessionStorage for this layout; it updates the URL hash immediately only for the active tab. Tab selection restores that tab's stored hash.
- `setLayout(projectSlug, layoutSlug)` handles client-side URL navigation
- Receiving tab reads state via `getTabState(tabId)` in a `useEffect` triggered by `activeTab`
- State format is URL search params string (e.g., `'event=abc&date=2026-01-01'`)

### Running a layout locally

Start Station through `./station`, never through `npm run dev:server` /
`dev:ui` directly — the CLI orchestrates the server and UI builds in the right
order. To run with hot reload, use `./station start --watch` (see
[development](development.md#running-a-second-station-in-development-mode)). Use a named instance on ports that cannot collide with the defaults
(3141/3000 are reserved for the user's own testing) and `--temp-home` so the
runtime data is isolated from the normal Station home. Shared client/instance
metadata can still use `STATION_ROOT`; select a separate root consistently for
start, stop, and client commands when those records also need isolation:

```bash
./station start --instance=layout-check --temp-home --clean --force \
  --port=3242 --ui-port=5274
```

```bash
./station stop --instance=layout-check
```

Multiple instances can run from one checkout as long as their port ranges do
not overlap, so this does not disturb a sibling agent's instance.

### Testing with Playwright

`playwright.config.ts` reads `PW_BASE_URL`, so point the run at the UI port of
the instance you started above:

```bash
PW_BASE_URL=http://localhost:5274 npx playwright test tests/schedule.spec.ts --reporter=list
```

The full coverage contract is `npm run verify:e2e:full`, which runs the product,
first-run, Starter clean-install, smoke-live, extended, screenshot, and Android
buckets. `npm run test:e2e:starter-clean-install` uses its own fresh temporary
home, disables inherited product/OTLP telemetry configuration, and pins the
resource observation healthy, so it can prove the Starter journey independently
of the developer's Station state and unrelated host load. Resource-posture
fault tests continue to prove honest deferral.
Every spec must be assigned to exactly one bucket in `tests/e2e-manifest.mjs`.

### Debugging

Frontend logging (never use `console.log`):
```typescript
import { log } from '@/utils/logger';
log.api('message');  // Enable: localStorage.debug = 'app:*'
```

### Theming & Colors

UI, brand and copy rules live in the `@kontourai/ui`
[design constitution (DESIGN.md)](https://github.com/kontourai/ui/blob/main/DESIGN.md).
New styles use its `--k-*` tokens; existing components also use the theme
variables in `src-ui/src/index.css`, such as `--text-primary`,
`--bg-secondary`, `--border-primary` and `--accent-primary`. Never hard-code
hex colors.

For status, map the domain value to a tone with the helpers in
[station-tones.ts](../../src-ui/src/components/kontour/station-tones.ts) and
render it with `StatusBadge` or `Badge` from `@kontourai/ui/react`, which
take a `tone` and always show the label. Station restyles the positive,
caution, negative and active `.tone-*` classes with AA-checked pairs. Custom status
styles use the tone tokens `--k-positive`, `--k-caution`, `--k-negative`,
`--k-active` and `--k-neutral`, with `--k-positive-soft`, `--k-caution-soft`,
`--k-negative-soft` and `--k-active-soft` as tinted fills (there is no neutral
soft fill), and always carry a text label; color only reinforces it. The
installed package (1.18.0) also defines `--k-status-contrast` (text on a
status fill), the `--k-trust-*` trust-state inks, fills and line styles, and
the `--k-action` and `--k-focus` interaction roles; check
`node_modules/@kontourai/ui/tokens/tokens.css` before using a token. Follow the
owning component's button style and [frontend guidance](../patterns/frontend.md).

### Styling

**Prefer CSS classes over inline styles.** Define styles in the component's CSS file (or `index.css` for shared styles) and reference them via `className`. Inline `style={}` should only be used for truly dynamic values (e.g., computed widths, conditional colors from data). All colors, spacing, and theming must use CSS variables — never hardcoded hex values.

### Confirmation Dialogs

Never use `window.confirm()` or `window.alert()`. Always use the `ConfirmModal` component for destructive or significant actions:

```tsx
import { ConfirmModal } from '@/components/modals/ConfirmModal';

<ConfirmModal
  isOpen={showConfirm}
  title="Delete Item"
  message="This cannot be undone."
  confirmLabel="Delete"
  cancelLabel="Cancel"
  variant="danger"
  onConfirm={handleConfirm}
  onCancel={() => setShowConfirm(false)}
/>
```

This ensures consistent theming, accessibility, and UX across all confirmation flows.

### Agent Icons

Always use the `AgentIcon` component — never manually check icon URLs or render `<img>` tags for agent icons:

```tsx
import { AgentIcon } from '@/components/icons/AgentIcon';
<AgentIcon agent={agent} size={20} />
```

### ACP Connection Detection

Never infer an engine from Agent ID prefixes. The current Agent catalog exposes
`engineId`, `engineDisplayName`, and `engineConnectionType`; use
`engineConnectionType === 'acp'` when the connection method matters. The saved
connection ID is `execution.agentConnectionId`, not the Agent ID or a legacy
`source` discriminator. Execution requests name the Agent and let the server
resolve that binding. User-facing copy names the engine.

A bound Agent's `engineId` comes from its connection's static identity (the
Adapter's engine, or `'acp'`), not from the live connection inspection, so a
failing or slow inspection does not remove it; `engineDisplayName` and
readiness still need the live read (#3355). When a row's Agent resolves, is
bound to an engine connection, and still reports no `engineId`,
`inboxRowIconAgent` draws the engine the row's own execution recorded
(`HomeWorkItem.provider`), only when that engine has a bundled mark and never
for an ACP-bound or unresolved Agent.

### Plugin Workflow

Use the [plugin development workflow](plugins.md#development-workflow) for
scaffolding, building, and installation. Select an isolated test Station and
review its grants before activating the plugin. The source launcher owns the
coordinated app start described above.

### Attention inbox

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
