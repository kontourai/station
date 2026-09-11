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
`(namespace, type)` bindings. Station does **not** handle unbound tuples in
the product UI. Detection is for developers:

- server log (namespace/type/provider once per process, never the payload)
- session diagnostics (`namespace/type (unbound)`)
- `station.runtime.extension_notifications` if an OTLP exporter is set (field)

`EXTENSION_NOTIFICATION_PROMOTIONS` is the mapping backlog. Bias is promote
to a typed Station event. There is no in-product “accept unique” workflow.

## Queue vs steer

Two Station nouns. Engine differences live in the adapter and the capability
matrix; the dock always sees one of these:

| Noun | Station fact | When |
| --- | --- | --- |
| **Queue** | `queuedMessages`, drained on `turn.completed` / `runtime.error` as a **new** turn | Muse, Station. Attachments on a busy turn. |
| **Steer** | `steerTurn` → `turn.started` with `inputKind: 'steer'` | Additional user input on the **open** turn. |

Send-while-busy uses that matrix cell (`sessionAdapterSupportsSteering`), not
a connection `capabilities` string. A steer fold appends a user row and
**does not** reset `streamingMessage`. Attachments have no steer channel, so
they still queue. Durable outbound replay stays durable (`skipInMemoryQueueOnBusy`)
and is never collapsed into either path.

Adapter mappings, same Station event:

| Engine | Mechanism |
| --- | --- |
| Claude | `Query.streamInput` (additive) |
| Codex | app-server `turn/steer` `{ threadId, input, expectedTurnId }` (additive; does not emit a Codex `turn/started`) |
| Kiro / KAS | ACP extension **method** `_session/steer` (additive; not a notification) |
| Grok | ACP extension **method** `_x.ai/interject` (then `x.ai/interject`). `_x.ai/queue/changed` is the engine's prompt **queue**, host→agent interject is steer. |
| Any other ACP | T3-style `session/cancel` + `session/prompt` on the same Station `turnId` (interruptive). Also the fallback when the native method returns JSON-RPC -32601. |

Muse still binds one prompt to one process — no live input channel. That is a separate backlog item, not invented here.

The queued-messages chrome already offers **Send as steer** when the live
provider's matrix allows it.

While a turn is in flight, Enter **steers** on engines that can (Claude,
Codex, ACP). A **Queue** control next to Stop holds the draft as a follow-up
instead. Engines without a live channel, and any send that carries
attachments, still queue. There is no persistent follow-up-mode setting;
steer is the default whenever the engine can.

## Follow-ups

- Tape-backed `useSessionEventWindow` transport so **Load earlier events**
  runs the production prepend/anchor path.
- File import/export with redaction default-on.
- station-control `replay_session` open/step/observe.
- User-facing “view as of turn N” reuses the player and bar; debug inspector
  stays gated.
