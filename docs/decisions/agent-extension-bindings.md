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
    ref: src-server/providers/adapters/acp-steer.ts
  - kind: doc
    ref: src-server/providers/adapters/acp-child-work.ts
  - kind: doc
    ref: src-server/providers/adapters/acp-reattach-identity.ts
---

# Agent extension bindings

[ADR 0013](../adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md)
still decides how Station consumes agent extensions. A binding is data: an
id, the exact wire method or flag, a basis and its evidence. "Delivered"
means this session's `initialize` declares the method or flag, or a reviewed
handshake-identity entry matches. Station never infers support from method
names or launch commands. This record amends it in three places, and section
4 records rows for engines other than Kiro.

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

## 4. Other engines' rows, read from vendor source (2026-11-13)

These rows rest on each vendor's published source at a named commit, not on
a live run, and each says so in its `observed` field. Each matches a handshake
identity the engine states at `initialize`, never a launch command.

| Engine (identity) | Row | Table | Source |
|---|---|---|---|
| Goose (`agentInfo.name` `goose`) | steer with `_goose/unstable/session/steer`, joining the run Goose announced as `_meta.goose.activeRunId`; with no run announced, or a -32602 refusal, cancel + re-prompt | steer table, `acp-steer.ts` | aaif-goose/goose v1.59.0 `crates/goose/src/acp/server.rs`, `crates/goose-sdk-types/src/custom_requests.rs` |
| Qwen Code (`agentInfo.name` `qwen-code`) | subagents from nested tool calls (`_meta.provenance: 'subagent'`, `parentToolCallId`) | `ENGINE_EXTENSION_BINDINGS` `qwen-code.tool.subagent` and the reporter table in `acp-child-work.ts` | QwenLM/qwen-code 6f754be65489 `SubAgentTracker.ts`, `tool-call-emitter.ts`, `transcript-replay.ts` |
| Hermes (`agentInfo.name` `hermes-agent`) | a reattach answer naming another session in `_meta.hermes.sessionProvenance.acpSessionId` fails the resume (`hermes acp` up to v0.22.0 and in v0.22.2; confirmed live on 0.17.0) | `acp-reattach-identity.ts` | NousResearch/hermes-agent v0.22.0 `acp_adapter/server.py`, v0.23.1 `gateway_server.py`, `provenance.py` |
| Gemini CLI (`agentInfo.name` `gemini-cli`) | a `session/load` refused with `Authentication required` (-32000), on a connection that has a `GEMINI_API_KEY`, starts a new engine session with a visible warning naming the fix, and the next turn re-delivers the first-turn instructions; without the key the resume fails; Station never calls `authenticate` for it | `acp-reattach-identity.ts` | google-gemini/gemini-cli 4ed06ed0dd `packages/cli/src/acp/acpSessionManager.ts`, `acpRpcDispatcher.ts` |

Goose declares `_meta.goose` feature flags at `initialize` but no method
list. Its steer is therefore an identity row, not a declared one.

**Unbound by decision:**

- Cursor's `cursor/task`. Its documentation describes a completion
  notification only, with no start, no session id and no handshake identity,
  and it also gives the notification a response type. A child cannot be
  listed running from it.
- Copilot CLI subagent ids. Its 1.0.81 changelog entry says ACP clients receive
  them, but the wire shape is not public.
- Goose `subagent_id`. It appears only inside an MCP log entry that Goose
  relays as `_meta.toolNotification` on the parent tool call. That entry has
  no start or end, and the emitter could not be pinned in Goose's current
  source.
