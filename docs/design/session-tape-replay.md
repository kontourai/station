# Session tape replay

> **Reading status: current implementation note with recorded test evidence.**
> The [replay controller](../../src-ui/src/hooks/orchestration/replay/controller.ts)
> owns replay identity and opening/closing; the
> [player](../../src-ui/src/hooks/orchestration/replay/player.ts) drives the shared
> event fold. Use the [Session API](../reference/session-api.md) for current
> archive and streaming contracts. The browser matrix and engine mappings below
> are not a newly executed test result or proof of native-device behavior.

Status: debugger and read-only execution-timeline implementation. Original
replay: #1935; event-to-render debugging and shared-device streaming: #1958;
conversation controls: #563 / #342.

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

Backward seek is destroy-and-refold of prefix `0..N`; its fold measurement
includes the entire prefix. Never rewind a live thread.

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

Forward rendered steps compare a retained visible row's offset before and
after the event. A shift greater than eight pixels reports
`unexpected-scroll-jump`, except when the reader supplied pointer, touch,
wheel or keyboard input during that step, the viewport resized, both views
followed the bottom, or the row was replaced. Back/seek establish a new
baseline. This detects movement of retained anchors, not every possible
scroll defect. Missing completed-answer rows at the bottom are failures,
including when no assistant row is mounted at all. Observations include
visible anchors and the actual replay controls; replay replaces the live
composer, so these are not historical send/stop controls.
Mounted messages that all fall outside the viewport report
`empty-transcript-viewport`; a bounded DOM count alone cannot prove a usable
virtualized transcript. The virtualizer attaches its parent scroll ref after
the commit, when that ref is available.
Terminal message timestamps come from their runtime event, so replay and
reconnect preserve question/answer order instead of sorting answers by the
time the recording was played.

Record a live conversation from chat developer settings to include committed
history reads, runtime events, transport transitions, snapshots, and the
initial visible state. Capture is opt-in and stops explicitly at 16 MiB or
20,000 frames. A server-event tape cannot reconstruct the original client's
history responses or network timing; `coverage` distinguishes it from a
client capture. Imported captures use the production history projector with
recorded reader responses and cannot issue live history requests.

Archive loading reads the selected execution session in 100-event pages,
with the same 16 MiB / 20,000-event ceiling. It does not reconstruct an entire
conversation lineage. A capped recording reports an incomplete-capture issue.
Imports validate nested shapes, ordering, depth and size before replacing an
open replay; invalid JSON errors never echo recording contents. Finite
animations settle before a rendered observation; indefinite activity pulses
do not block it.

Export redacts content by default. Content-preserving export is explicit;
redacted tapes retain protocol fields, replace identity values with pseudonyms,
and mask content while preserving whitespace. They cannot prove original text
layout or guarantee removal of arbitrary sensitive text placed in protocol fields.
Replay forms, sends, feedback, and Task actions cannot mutate the source
conversation. Replaying a snapshot does not modify live chats or background
tasks.

The browser matrix in `tests/chat-replay.spec.ts` pairs each frame's screenshot
with its observation. It covers waiting and thinking timers, text streaming,
concurrent and sequential tools, approval, errors after partial text,
reconnecting, catch-up, revoked credentials, multiple turns, incomplete history,
virtualized long history, and reduced motion in both themes. This is browser
evidence; native lifecycle and device delivery require separate verification.

Chat activity uses one aligned phrase, `Working for m:ss`: the clock is the
open turn's, so the timed phrase names the turn, never its current phase.
Without a clock the row names the phase instead (`Thinking…`, `Working…`), and
the progress row beneath names a running or last tool. Active tool rows supply
their own animation, and streamed answer text has a caret. Approval and transport
recovery have explicit states. A timer measures observed waiting, never an
estimate of completion.

A replay renders these as inline rows, because that is what its scenarios pin.
A live chat pane presents the same facts in one floating status pill
([`ChatStatusPill`](../../src-ui/src/components/status/ChatStatusPill.tsx)):
approval first, then the live-update connection, then what the turn is doing,
with the same turn clock. A live-update outage is shown only after it outlasts
one reconnect cycle (2.5s), so a phone blip does not flash a status.

The separate [reasoning disclosure](../../src-ui/src/components/chat/ReasoningSection.tsx)
uses a compact summary row. Expanding it shows the text beneath an indented
rule, while its word count and the reader's open/closed choice remain available.

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

The mapping backlog lives in
[#2899](https://github.com/kontourai/station/issues/2899). Bias is promote
to a typed Station event. There is no in-product “accept unique” workflow.

## Queue vs steer

Two Station nouns. The composer distinguishes native steering from safe stop-and-send;
the adapter mechanisms below do not by themselves establish the dock capability:

| Noun | Station fact | When |
| --- | --- | --- |
| **Queue** | `queuedMessages`, drained on `turn.completed` / `runtime.error` as a **new** turn | Any engine when Queue is selected. |
| **Steer** | `steerTurn` → `turn.started` with `inputKind: 'steer'` | Additional user input on the **open** turn. |

Native send-while-busy uses `sessionAdapterSupportsSteering`, not a connection
`capabilities` string. The dock currently enables native steering for Claude
Code and Codex; ACP uses a safe-waiting fallback because its capability matrix
also admits interruptive cancel-and-reprompt. A steer fold appends a user row and
**does not** reset `streamingMessage`. The event-log projection
(`projectRuntimeEventsToMessages`) keeps the turn open at a steer but emits
what the engine produced before it as its own assistant row, so the steer
renders where it happened rather than above the whole turn. The turn's
provenance and answer eligibility stay on its final row, and so does the
turn's ownership: a start-less or late event for the turn lands on the row
after the steer, never on the one before it. Attachments have no steer channel, so
they remain in the composer until the current turn finishes. Durable outbound replay stays durable (`skipInMemoryQueueOnBusy`)
and is never collapsed into either path.

Adapter mappings, same Station event:

| Engine | Mechanism |
| --- | --- |
| Claude | `Query.streamInput` (additive) |
| Codex | app-server `turn/steer` `{ threadId, input, expectedTurnId }` (additive; does not emit a Codex `turn/started`) |
| Kiro | ACP extension **method** `_session/steer` when the command, arguments or reported agent name match Kiro (additive; not a notification) |
| Grok | ACP extension **method** `_x.ai/interject` (then `x.ai/interject`). `_x.ai/queue/changed` is the engine's prompt **queue**, host→agent interject is steer. |
| Any other ACP | Cancel + re-prompt fallback: `session/cancel` + `session/prompt` on the same Station `turnId` (interruptive: it also cancels any tool the prompt was running). Also the fallback when the native method returns JSON-RPC -32601. Its steer `turn.started` carries `steerInterruptedRun: true`, and the steer row says it was sent by stopping the running step. |

Muse still binds one prompt to one process — no live input channel. That is a separate backlog item, not invented here.

The pending-message section starts collapsed. Expanding it reveals each mode,
status and its explicit Send now action. Send remains separate from Stop. The
Send-mode picker defaults to Queue; native Steer is available for Claude Code
and Codex. Other engines hold steering until a supported safe boundary can be
proven, and currently wait for turn completion. Send now explicitly overrides
that waiting, stopping immediately and sending after a settled receipt.

Return uses the device preference and the selected Send mode. Desktop defaults
to sending; touch devices default to a new line. Shift+Return adds a line and
Ctrl/Cmd+Return sends, outside IME composition. Mobile submit controls are icons,
revealed for a sendable draft while their space stays reserved. See the
[composer contract](chat-composer.md#turn-activity-and-follow-up-delivery) for
current interaction and delivery policy. The adapter table above describes
explicit engine commands, not a promise of native steering on every ACP Session.

## User-facing execution timeline

Chat actions' **History** action loads the selected execution in
the same bounded 100-event archive pages and opens it under a synthetic replay
identity. User-turn landmarks come from the validated tape, not mounted DOM;
click, pointer drag, previous/next controls, and ordinary button keyboard
activation seek by destroy-and-refold. The ordinary transcript renderer stays
in use, while the debugger transport is replaced by a small historical-state
bar. Forms, sends, approvals, feedback, Task actions, and live queue draining
remain fenced by replay membership.

The conversation event window supplies the authoritative execution lineage.
The timeline loads each selected execution through its bounded archive and
shows the 16 MiB / 20,000-event stop only when reached. Returning closes the
synthetic replay and restores the source chat and its saved reader offset; its
draft and live identity were never changed. Forking is explicit and enabled only after a recorded
`turn.completed`; it passes the original durable session and turn identity to
the existing fork flow. It never uses the synthetic replay id as lineage and
does not restore workspace state.

## Follow-ups

- station-control `replay_session` open/step/observe.
- Seeking checkpoints only if measured prefix folding warrants their retained
  memory cost. The browser suite measures a mounted 20,000-event seek.
- Workspace rollback remains a separate action.
