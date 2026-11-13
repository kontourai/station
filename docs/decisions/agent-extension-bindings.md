---
status: current
subject: Agent extensions bind as evidenced data rows to declared mechanisms; credentials only through reviewed bindings
decided: 2026-11-13
evidence:
  - kind: adr
    ref: docs/adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md
  - kind: doc
    ref: src-shared/extension-notification-bindings.ts
  - kind: doc
    ref: src-server/services/acp/acp-handshake-facts.ts
  - kind: doc
    ref: packages/contracts/src/engine-commands.ts
  - kind: doc
    ref: src-server/services/acp/__tests__/fixtures/kiro-v3-2.35.0-session-frames.jsonl
  - kind: doc
    ref: src-server/services/acp/__tests__/fixtures/grok-1.0.77-session-frames.jsonl
  - kind: doc
    ref: src-server/providers/adapters/acp-child-work.ts
---

# Agent extension bindings

[ADR 0013](../adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md)
still decides how Station consumes agent extensions. A binding is data: an
id, the exact wire method or flag, a basis and its evidence. "Delivered"
means this session's `initialize` declares the method or flag, or a reviewed
handshake-identity entry matches. Station never infers support from method
names or launch commands. This record amends it in three places, and section 4
records what Grok Build's evidence changed.

## 1. Credential requests: superseded

ADR 0013's standing invariant that no Station-held credential is ever bridged
into an agent's extension request (its Layer 1 and failure-mode sections) is
superseded by [engine credentials through a typed, scoped
provider](engine-credential-provider.md). A credential-shaped method is still
refused unless a reviewed engine-credential or engine-secret binding answers
it, and the generic registry's name tripwire still throws.

## 2. Layer 3: command routes

Engine slash commands get a typed route
([`engine-commands`](../../packages/contracts/src/engine-commands.ts)):
prompt text, an engine request, or an adapter action. An engine-request route
applies only when the live session declares its method (or a reviewed
identity entry matches), and its output is engine-attributed. These rows
change:

| Extension | Was | Now |
|---|---|---|
| `_kiro/session/compact` | engine-action affordance | command route `engine-request`, declared |
| `_kiro/session/context` | not bound | command route `engine-request`, declared, read-only |
| `_kiro/codeIntelligence`, `_kiro/config/template` | passthrough, no surface | command route `engine-request`, declared |
| `_kiro/knowledge` | not bound (option A) | **option B**: an engine-attributed command route, shown beside Station's knowledge and never merged into it. ADR 0009's authority holds. |
| `_kiro/memory/list`, `_kiro/memory/get` | not bound | read-only command routes; memory create, update, delete, import, export and sync stay unbound |
| `_kiro.dev/commands/execute` (v2) | not bound | `undeclared-engine` route keyed on `agentInfo.name`, falling back to prompt text on `-32601` |

## 3. Live kiro-cli 2.35.0 evidence

kiro-cli 2.35.0 was run signed in on 2026-11-13. `--agent-engine v2` and
`--agent-engine v3` both complete `initialize`. The v3 frames, scrubbed of
host paths, session ids and private agent names, are the repository fixtures
`src-server/services/acp/__tests__/fixtures/kiro-v3-2.35.0-*.json*`.

- The `_kiro` v3 notification spelling is now observed. Each observed method
  and `session_info_update._meta.kiro` kind is a row of
  `ENGINE_EXTENSION_BINDINGS` with that capture as evidence. A test checks
  every such row against the capture.
- `_kiro/terminal/shell_type` (`{sessionId}`) still arrives, but a `-32601`
  answer no longer fails `session/new`. It is bound as the
  `client.terminal-facts` answer and is no longer a blocker.
- v3 declares `_meta.kiro` features. `acp-handshake-facts.ts` projects them,
  bounded, and resolves the engine variant (`kiro-v3` from the declared
  namespace, `kiro-v2` from `agentInfo.name`) through the same identity
  matcher the steer table uses.
- **Unbound by decision:**
  - `executionTargets` `cloud-sandbox`, `sessionSources` `remote`,
    `_kiro/environment/*` and `_kiro/sourceProviders/*`: they leave the
    host's confinement.
  - `_kiro/hooks/*`: Station's tool-policy seam governs instead.
  - `_kiro/workflow/*`: pre-release.
  - `_kiro/permissions/presets/add|remove`: they bypass Station's
    `requestPermission` policy.
  - `_kiro/mcp/toggle`: it stops the whole MCP subsystem.
  - `_kiro.dev/session/terminate`: Station runs one process per session.
  - `_kiro/session/rename`: no consumer.

  [The ACP guide](../guides/acp.md#kiro-extensions-station-does-not-support)
  keeps the full list.
- The v3 `autopilot` config option (`on` by default) did not self-approve.
  With it on and off, the engine still sent `session/request_permission`,
  and a reject was honored. Station treats it as an ordinary engine option.

## 4. Live grok 1.0.77 evidence

grok 1.0.77 (`grok agent stdio`) was run signed in on 2026-11-13, with a
background command, a background subagent, a monitor (with a wake cancelled
mid-run), an MCP server Station passed that fails, a model question
answered, declined and refused, a rewind previewed and applied, a fork at a
prompt loaded in a new process, and an MCP server removed and passed again.
The
frames, scrubbed of host paths, ids and private names, are
`src-server/services/acp/__tests__/fixtures/grok-1.0.77-session-frames.jsonl`.

- Grok's `initialize` result sets `_meta.grokShell: true` and sends no
  `agentInfo`. That flag is a reviewed handshake identity: engine variant
  `grok-build`. Grok lists no extension methods, so its rows are
  `undeclared-engine`.
- **Child work is the engine's.** ACP has no subagent concept, so the ACP
  capability cell for subagent observability is `declared`, and the adapter
  decides per session from the handshake which subagent wires it reads
  (`acpSubagentWires` in `acp-child-work.ts`): Kiro's roster and
  `agent-subtask` wires, and Grok's background-task and subagent-lifecycle
  wires keyed on `_meta.grokShell`. A session whose handshake names none
  states `not-reported` once at start.
- **One frame, several facts.** A row may name `also` consumers it feeds.
  Grok's `turn_completed` ends a turn and states that turn's cost, so its row
  is `session.turn-boundary` with `also` `usage.reported-cost`. A row runs
  only when every consumer it names is implemented. Grok's token counts are
  not published: usage scope is declared per provider, and `acp` stays
  context-occupancy-only.
- **Engine-opened turns.** `session.turn-boundary` is implemented: a prompt
  the engine runs while no turn is open, and that Station never sent, opens a
  `PROVIDER_TURN_TRIGGER` turn. `_x.ai/session/prompt_complete` follows only
  Station's own prompts, so it does not close one. A wake whose process exits,
  or that credential-refusal recovery replaces, is ended by the adapter,
  since its own end cannot arrive.
- **Another session's frames are not this session's.** A Grok subagent
  streams as its own session on the same connection. The adapter drops any
  session-scoped frame naming another session than its process's own.
- `_x.ai/ask_user_question` is a reviewed inbound request, answered from the
  person's choice.
- **Rewind and fork name a prompt by index.** Grok declares neither, so both
  are keyed on its handshake identity (`acp-session-actions.ts`). Every
  prompt it runs takes an index, but only a client's is listed as a point (a
  wake takes an index and lists none), so Station's turns are lined up with
  the last points listed, and every turn from the chosen one on must have
  exactly its point's `prompt_preview` before anything is sent. A rewind is a dry run
  (`force: false`) first; files changed outside the engine since then fail
  it rather than being overwritten. A fork copies through the named prompt,
  inclusive.
- **MCP reconnect replaces the list.** Grok's one MCP call replaces the
  servers the client passed, so reconnecting one sends the list without it,
  then with it. A server taken out reports `unavailable` `config_removed`,
  read as `disabled`, not `failed`.

What Station leaves unbound, and why, is listed in
[the ACP guide](../guides/acp.md#grok-extensions-station-does-not-support).

