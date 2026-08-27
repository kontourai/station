# Route managed-agent chat through orchestration, behind a flag

## Context

Station has two parallel session stores for agent conversations. **Managed
(Station-agent) chat** goes straight to `POST /api/agents/:slug/chat`
(`src-server/routes/chat/chat.ts` → `streamPrimaryAgentChat`,
`chat-primary-stream.ts`), which streams a direct SSE vocabulary
(`conversation-started`/`text-delta`/`tool-approval-request`/`finish`) and
persists only to the NDJSON/JSON file memory store
(`FileMemoryAdapter`) — it never writes an orchestration event-store row.
**External-agent chat** (Claude Code, Codex, ACP, and any delegated task)
goes through `startSession`/`sendTurn` against `orchestration.sqlite`
(`src-server/services/orchestration/orchestration-service.ts`,
`event-store.ts`), emitting a canonical event vocabulary
(`content.text-delta`/`turn.completed`/`request.opened`) that `station runs`
and the run/session projections already read. A managed chat is therefore
invisible to `station runs`, to the orchestration session-board, and to any
future feature built only on the orchestration event stream — not because
managed chat is second-class, but because it was never invited to that
store.

The two paths are not as separate as they look. `delegateTask`'s
Station-agent branch (`src-server/tools/station-control-delegation.ts:1823-1876`)
already starts an orchestration session with `provider: 'station-agent'`
for a managed agent. The private `station-agent` adapter
(`src-server/providers/adapters/station-agent-adapter.ts`) that session
runs on does not reimplement execution — its own `sendTurn` calls
`POST /api/agents/:slug/chat` internally and translates that route's SSE
into the canonical vocabulary (`mapStationAgentStreamEvent`). So the
managed chat's feedback/behavior-guidelines/RAG/conversation-title
machinery inside `/chat` runs unchanged either way; the only question is
which envelope the interactive callers (CLI `station chat`, the chat UI)
use to reach it.

## Decision

**Option A — unify on orchestration as the store of record (chosen).**
Keep `/api/agents/:slug/chat` as the internal execution engine (the
`station-agent` adapter's relay stays exactly as it is — this is not a
migration of that route). Flip the *interactive* managed-chat callers to
start a `station-agent` orchestration session (mirroring `delegateTask`)
and drive it via `startSession`/`sendTurn`, instead of calling `/chat`
directly. Once a managed chat's session exists in `orchestration.sqlite`,
it is a first-class run (`engineExecution: 'station'`) with zero changes to
run-projection or run-service — that projection already handles any
provider generically.

**Option B — special-case managed chat into the runs/session projections**
(rejected). Teach `listAgentRuns`/the session-board to also read
NDJSON/JSON managed conversations as a second, parallel source. Rejected
because it would permanently fork the run-listing logic across two
unrelated storage shapes, is strictly more code for a strictly smaller
result (managed chat still would not get live orchestration events,
approvals-via-canonical-vocabulary, or session-board entries), and treats
the symptom (chat invisible to runs) rather than the cause (chat never
joined the store that runs are read from).

**The New Chat / engine-connection privacy constraint.** The
`station-agent` provider must never become a user-visible "engine" or
connection choice — it is purely the execution vehicle for an agent the
user already picked in New Chat (a Station agent). It is intentionally kept
out of the public provider registry (`withPrivateOrchestrationAdapter`,
`orchestration-adapter-registry.ts`): dispatchable via `get()`, absent from
`register()`. Auditing every New-Chat/engine-inventory source (station#980
Wave 0) found today's pickers are built from agents + engine connections,
never from `GET /api/orchestration/providers` — so nothing currently leaks
`station-agent` into inventory. `orchestration-service.listProviders()`
(which backs that route) now filters `station-agent` out of its result
defensively anyway, with a regression test pinning "station-agent absent
from inventory" (station#980 AC3) so a future inventory-shaped consumer of
that endpoint cannot reintroduce the leak silently.

**The cutover is flag-gated, not a rewrite.** `managed-chat-orchestration`
(`STATION_FEATURES=managed-chat-orchestration`, parsed in
`runtime-initialize.ts` next to the existing `strands-runtime` flag)
defaults **off**. Off is today's exact managed-chat behavior — direct
`/chat`, NDJSON only, current SSE vocabulary, identical request payload —
**output-identical**, not byte-identical at the wire level: the CLI now
consults `GET /config/app` once before a managed chat to read the (fail-closed)
flag, so flag-off issues one extra GET that did not exist before this ADR.
That check is placed *after* every existing usage-error guard on both the
CLI (`session-client.ts`) and UI (`useActiveChatSessionMessaging.ts`) send
paths, never before, so a usage error still throws before any network call;
chat output, the `/chat` payload itself, and NDJSON persistence are
unchanged. The flag is surfaced non-persisted through `GET /config/app`
(`managedChatOrchestration`, injected only when true — the same pattern as
`mcpUiFrameOrigin`) so the CLI and UI consult one server-computed value
rather than duplicating the environment check; that getter reads
`process.env.STATION_FEATURES` directly (never the mutable, disk-reloadable
`appConfig`, which loses the non-persisted field on every config-mutation
reload) so the flag stays live for the life of the process regardless of
unrelated agent/connection/app-config saves. On the flipped path,
`threadId === conversationId` (the same identity `delegateTask`/the adapter
already establish), so a resumed managed conversation's NDJSON transcript
and its orchestration session never desync.

**No data migration.** Existing `agents/<slug>/memory/conversations/*.json`
+ `sessions/*.ndjson` are left exactly as they are — legacy-readable, not
migrated. The conversations route already merges both stores
(`conversations.ts`, unioning `adapter.getConversations` with
`sessionMessageReader.listSessionConversations`), so pre-cutover
conversations keep opening and appending through the existing merged read
path. A legacy conversation whose id was minted by `createChatConversationId`
simply has no matching orchestration session and stays NDJSON-only forever
— that is an accepted, permanent state, not a gap to close later.

**Production enable is owner-gated and out of this slice.** This ADR and
its implementation land the flag default-off. Flipping the default to on
in production is the one-way cutover (once managed chats start landing
orchestration rows, `station runs`/session-board history changes shape for
every managed agent going forward) and is explicitly not taken here.

## Consequences

- With the flag on, a managed Station-agent chat started from the CLI
  (`station chat <managed-slug>`) or the UI appears in `station runs` with
  `engineExecution: 'station'`, agent identity (`metadata.agentId`) and
  model discoverable off the session/event-store record — exactly like a
  delegated or external-agent run, with zero run-projection changes.
- Approvals on the flipped path ride the orchestration `request.opened`/
  `request.resolved` vocabulary (reusing station#979's CLI surfacing and the
  UI's existing generic, provider-agnostic orchestration event consumption)
  instead of the managed-only `tool-approval-request` SSE chunk.
- `--title` has no carrier through the `station-agent` adapter's relay to
  `/chat` today (it forwards `conversationId`/`userId`/`delegation`/`model`,
  plus `providerManagedFallback`/`providerModel` whenever a model override
  is present (station#1288 — without them `/chat`'s model-override guard
  400s every flipped turn that carries a model, which is essentially every
  turn once this flag is on), never `title`) — the CLI's flipped path fails
  loudly on `--title` rather than silently dropping it; closing that gap is
  follow-up work, not a blocker for this slice.
- The private `station-agent` provider stays invisible to New Chat/engine
  pickers with the flag either on or off — the flag changes *how* a chosen
  Station agent executes, never *which* agents/engines are selectable.
- Rollback is trivial: the flag defaults off, so reverting behavior is
  "leave the flag off" or drop the branch — no data was moved, no schema
  changed.
- Retiring the UI's direct-SSE managed branch entirely, and defaulting the
  flag on in production, are explicitly deferred — this ADR records the
  mechanism and the constraint, not the cutover.
