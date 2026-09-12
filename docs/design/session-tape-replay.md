# Session tape replay

Status: debugger implementation. Original replay: #1935; event-to-render
debugging and shared-device streaming: #1958. Future conversation controls: #563.

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

The composer slot is `ReplayTransport`, collapsed by default to preserve the
transcript viewport. Expand it for Back, Step, Play/Pause, speed, seek, and
Run until issue. `window.__stationReplay` exposes asynchronous `step`, `back`,
`seek`, and `observe` operations, plus `play`, `pause`, `runUntilIssue`, and
the synchronous `observeState`. Asynchronous observations wait beyond the
live text batching interval and sample the committed transcript DOM. They
report mounted rows, visible row bounds, scroll position, mutations, and
observation wait time. Wait time is not React render CPU time, and a timeout
or unmounted transcript is explicitly reported.

Record a live conversation from chat developer settings to include committed
history reads, runtime events, transport transitions, snapshots, and the
initial visible state. Capture is opt-in and stops explicitly at 16 MiB or
20,000 frames. A server-event tape cannot reconstruct the original client's
history responses or network timing; `coverage` distinguishes it from a
client capture. Imported captures use the production history projector with
recorded reader responses and cannot issue live history requests.

Export redacts content by default. Content-preserving export is explicit;
redacted tapes preserve structure but cannot prove original text layout.
Replay forms, sends, feedback, and Task actions cannot mutate the source
conversation. Replaying a snapshot does not modify live chats or background
tasks.

The browser matrix in `tests/chat-replay.spec.ts` pairs each frame's screenshot
with its observation. It covers waiting and thinking timers, text streaming,
concurrent and sequential tools, approval, errors after partial text,
reconnecting, catch-up, revoked credentials, multiple turns, incomplete history,
virtualized long history, and reduced motion in both themes. This is browser
evidence; native lifecycle and device delivery require separate verification.

Chat activity uses one aligned phrase, `Working for m:ss`, before content;
reported reasoning uses `Thinking for m:ss`. Active tool rows supply their own
animation, and streamed answer text has a caret. Approval and transport
recovery have explicit states. A timer measures observed waiting, never an
estimate of completion.

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

- station-control `replay_session` open/step/observe.
- Bounded archive loading and seeking checkpoints for exceptionally large
  tapes; profiling must justify checkpoint retention and cadence.
- User-facing read-only “view as of turn N”, return to latest, and explicit
  fork/continue can reuse this foundation. Workspace rollback is a separate
  action. These controls remain future work under #563.
