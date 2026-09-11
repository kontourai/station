# Session tape replay

Status: accepted direction, v1 implemented. Issue #1935.

A replay is a normal dock chat under a **synthetic store key**. Recorded
canonical events are rewritten onto that id and folded through
`handleOrchestrationEvent`. The live `ChatDockBody` / `ChatMessageList` /
streaming row path is unchanged. Developer tools gates the **entry point**
only (`ChatSettingsPanel` → “Step through this conversation”).

## Isolation

- Membership in `replay-registry` is the replay test, not a name prefix.
- Replay chats set `replay: { sourceThreadId, tapeEventCount }` and do **not**
  copy `conversationId` / `currentSessionId` from the source (lineage
  fuzzy-match in `getChatKeyForExecutionSession`).
- `isDurableActiveChat` is false for replay chats, so they are never
  serialized.
- Effect sites (background-task ingest, toasts, tool-activity notifications,
  last-chosen-model writes, queue-drain POSTs) no-op when
  `isReplayThread(threadId)`. The spy test that folds a representative tape
  and asserts zero effects is the derivation; an allowlist comment is not.

Backward seek is destroy-and-refold of prefix `0..N`. Never rewind a live
thread.

## Agent observation

Each step publishes a `ReplayObservation` from the **same** `ChatUIState` the
dock renders (plus transcript DOM scroll when mounted). It is not a second
projector. The observation includes streaming vs settled rows, tool names,
`issues[]` (`duplicate-streaming-and-settled`, `streaming-after-turn-completed`,
`lineage-leak`, `empty-after-completed-turn`), and a `delta` vs the previous
step.

The composer slot of a replay chat is `ReplayTransport`: Back / Step, an
`aria-live` status line, issue list, and a `data-testid="replay-observation"`
JSON region. While a replay is active, `window.__stationReplay` exposes
`step` / `back` / `seek` / `observe` for computer-use agents.

Headless station-control tools that drive those operations over `/api/ui`
are a follow-up on this schema.

## Canonical fold

`handleOrchestrationEvent` is exhaustive over `CanonicalRuntimeEvent`.
Vendor-specific extras stay on `extension.notification` (ADR 0008): exact
`(namespace, type)` bindings, unknown tuples remain no-ops. Observed Grok
ACP / extra Kiro tuples that are host chrome are bound to `acp.host-chrome`
so they are folded without becoming transcript rows.

## Follow-ups

- Tape-backed `useSessionEventWindow` transport so **Load earlier events**
  runs the production prepend/anchor path.
- File import/export with redaction default-on.
- station-control `replay_session` open/step/observe.
- User-facing “view as of turn N” reuses the player and bar; debug inspector
  stays gated.
