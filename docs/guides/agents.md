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
| `model` | Bedrock model ID — falls back to `defaultModel` in app.json |
| `tools` | MCP server IDs, allow-list, auto-approve list |
| `guardrails` | `maxSteps`, `maxTokens`, `temperature` |

### MCP Tool Configuration

`tools` in agent.json controls which MCP servers connect and which tools are exposed:

```json
{
  "tools": {
    "mcpServers": ["filesystem", "github"],
    "available": ["read_file", "list_directory", "create_pull_request"],
    "autoApprove": ["read_file", "list_directory"],
    "aliases": { "ls": "list_directory" }
  }
}
```

- `mcpServers` — IDs of MCP servers to connect (each defined in `<STATION_HOME>/integrations/<id>/tool.json`)
- `available` — allowlist of tool names exposed to the agent; omit or set `["*"]` to expose all tools from connected servers
- `autoApprove` — tools that execute without user confirmation; all other tools trigger the approval flow
- `aliases` — rename tools in prompts without changing the underlying tool name

Station negotiates MCP automatically. It tries the current `2026-07-28`
discovery flow first and falls back to the legacy `initialize` flow when a
deployed stdio server is older. Existing integration files do not need a
protocol-version field, and there is no era selector to maintain.

### Guardrails

Guardrails constrain model inference per agent:

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

The runtime loads and manages agents through a defined lifecycle:

```
load → MCP connect → ready → chat → reload
```

1. **load** — `station-runtime.ts` reads `agent.json`, resolves the Bedrock model, and creates a memory adapter for the agent's conversation history
2. **MCP connect** — for each distinct entry in `tools.mcpServers`, Station owns one negotiated MCP connection, loads the raw tool schemas and metadata, and shares that connection across agents that use the integration
3. **ready** — the agent is registered in `activeAgents` and available for requests
4. **chat** — `POST /api/agents/:slug/chat` streams a response; the runtime creates an `InjectableStream` to interleave approval events with model output
5. **reload** — `reloadAgents()` prepares the replacement connection set, publishes the new agents, and retires superseded connections without a full restart

Health is checked every 60 seconds and emitted as `agent-health` monitoring events.

---

## Tool Approval Flow

Tools not in `autoApprove` pause the stream and request user confirmation before executing.

Flow:
1. `beforeToolCall` hook fires — checks `autoApprove` list via `isAutoApproved()`
2. If not auto-approved, the hook calls `requestApproval` (wired per-request by the chat handler)
3. `requestApproval` injects a `tool-approval-request` SSE event into the stream
4. The client renders a confirmation UI and `POST /tool-approval/:approvalId` with `{ approved: true/false }`
5. `ApprovalRegistry.resolve()` unblocks the hook; the tool executes or is skipped

The `InjectableStream` wrapper ensures approval events are emitted in the correct position in the SSE stream, even when the model is mid-reasoning.

---

## Agent Hooks

`agent-hooks.ts` provides framework-agnostic lifecycle hooks wired into whichever runtime adapter is active. Hooks receive typed context objects — no framework imports.

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
| `POST /api/agents/:slug/chat` | Streaming chat (SSE) |
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

**Key rule**: Plugins import from `@kontourai/station-sdk` only.

### Cross-Tab Navigation

Plugins must use SDK hooks for navigating between layout tabs — never use raw `sessionStorage`, `window.history.pushState`, or `window.dispatchEvent` directly.

```typescript
import { useNavigation, useLayoutNavigation } from '@kontourai/station-sdk';

const nav = useNavigation();
const { setTabState, getTabState } = useLayoutNavigation();

// Navigate to another tab with state:
setTabState('crm', 'selectedAccount=<id>');       // write state for target tab
nav.setLayout('my-project', 'my-layout');          // navigate to layout

// Read state on the receiving tab:
const state = getTabState('crm');                  // read in useEffect([activeTab])
const params = new URLSearchParams(state);
const accountId = params.get('selectedAccount');
```

**Rules:**
- `setTabState(tabId, state)` writes to sessionStorage + syncs URL hash
- `setLayout(projectSlug, layoutSlug)` handles client-side URL navigation
- Receiving tab reads state via `getTabState(tabId)` in a `useEffect` triggered by `activeTab`
- State format is URL search params string (e.g., `'event=abc&date=2026-01-01'`)

### Running a layout locally

Start Station through `./station`, never through `npm run dev:server` /
`dev:ui` directly — the CLI orchestrates the server and UI builds in the right
order. Use a named instance on ports that cannot collide with the defaults
(3141/3000 are reserved for the user's own testing) and `--temp-home` so the
run does not touch `~/.station`:

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

Never use hardcoded hex colors. Use CSS variables from `src-ui/src/index.css` (`--text-primary`, `--bg-secondary`, `--border-primary`, `--accent-primary`, `--accent-acp`, etc). For status colors use the Tailwind palette: green `#22c55e`, amber `#f59e0b`, red `#ef4444`. Buttons use `className="button button--secondary"`. See [frontend.md](../patterns/frontend.md) for details.

### Styling

**Prefer CSS classes over inline styles.** Define styles in the component's CSS file (or `index.css` for shared styles) and reference them via `className`. Inline `style={}` should only be used for truly dynamic values (e.g., computed widths, conditional colors from data). All colors, spacing, and theming must use CSS variables — never hardcoded hex values.

### Confirmation Dialogs

Never use `window.confirm()` or `window.alert()`. Always use the `ConfirmModal` component for destructive or significant actions:

```tsx
import { ConfirmModal } from '@/components/ConfirmModal';

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
import { AgentIcon } from '@/components/AgentIcon';
<AgentIcon agent={agent} size={20} />
```

### ACP Connection Detection

Never hardcode ACP connection prefixes (e.g., `startsWith('kiro-')`). Use
`agent.source === 'acp'` from the Agents list when code must distinguish this
connection method. ACP metadata (`planUrl`, `planLabel`, `connectionName`) is
available on Agent configs for dynamic UI. User-facing copy names the engine;
it does not present ACP as an agent category.

### Plugin Workflow

```bash
station plugin remove my-layout
station plugin install ./examples/my-layout
npm run dev:ui
```

### Attention inbox

`/notifications` is the Inbox: it puts active operator attention ahead of
ordinary notification history. An approval uses its persisted notification's
existing Allow/Deny action, `needs_input` sends a normal orchestration turn to
the owning session, and `review_pending` only opens that session. The header
badge is the same deduplicated active-attention count shown in the Inbox.
Concrete approval requests suppress a duplicate lifecycle item for the same
session; attention clears only when its authoritative source changes. This is
not a Flow gate inbox (archive#612 remains outside this projection).
