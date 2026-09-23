# Design: server-ordered approval posture

> Status: **accepted (owner decision on #2436, 2026-09-23); implemented on the
> branch that closes #2436, #2418 and #2409.** It replaces the client-side pick
> bookkeeping that #2449 added in `src-ui/src/utils/approvalMode.ts`. Line
> references are to the tree this design was written against, at commit
> 7e6e3a531. That is the #2449 branch merged with `main`.

## 1. Problem

#2449 kept the approval pick honest with client bookkeeping. It recorded
pending and confirmed picks and stamped each with a stream position. A report
could only retire a pick when it was stricter. A confirmed Ask or Auto was
resent on every send, and full access was never resent. Six review rounds
compared that branch with `main`, and four known limits remain:

- Arrival order is not decision order. An offline pick is stamped with an old
  cursor.
- When another device re-picks the same posture, other clients cannot see it.
- Turns sent from outside the composer carry no posture (#2418).
- The residual **M1**: a confirmed Auto is resent after this device missed
  another device's tightening while disconnected.

No client-only rule can close all four, because each client orders decisions
by what it happened to receive.

## 2. Decision

The owner's decision (see #2436):

- **A command.** A new `setApprovalMode` orchestration command is recorded as
  a `session.approval-mode-set` event in the session's event stream. The
  event takes the server's global sequence like any other event.
- **Server application.** At every session start and every turn start, the
  server applies the conversation's latest recorded posture, whichever path
  sent the turn.
- **Client fold.** Every client folds the posture from the stream. The latest
  command wins by server sequence.
- **Removal.** The client-side resend bookkeeping is removed.

**The invariant.** It was the hard bar in #2449's review and it is this
design's acceptance bar. At every turn start, the engine is never more
permissive than the user's latest decision, ordered by the server. Section 8
states the one boundary it does not cover: the middle of a running turn.

## 3. Surface map (as found)

### 3.1 Orchestration command path

- **Command union.** `OrchestrationCommand` is in
  `packages/contracts/src/orchestration.ts:54-84`. The public HTTP body schema
  `orchestrationCommandSchema` is at
  `src-server/routes/orchestration/orchestration.ts:361-367`. It admits
  `adoptSession`, `interruptTurn`, `steerTurn`, `respondToRequest` and
  `stopSession`, but not `sendTurn` or `startSession`.
- **`POST /api/orchestration/commands`** is at `orchestration.ts:3693-3882`. It
  calls `orchestrationService.dispatchWithReceipt` at `:3765`, with a context
  built by `resolveDispatchActor` that carries `userId`, `principal`,
  `clientOrigin` and the tenant.
- **`dispatchWithReceipt`** is at
  `src-server/services/orchestration/orchestration-service.ts:5161`.
  - It performs the per-command authorization before any command runs:
    tenant, `canReadSessionForCommand`, quarantine, peer-activity, and
    read-only attached sessions (`:5210-5320`).
  - The `sendTurn` case begins at `:5327`. The turn input is composed at
    `:5385-5433`, the unsupported-key check is at `:5439`, and the adapter is
    called at `:5766-5768`.
- **Sessions.** `startSession` is handled through `sessionCommands.execute` or
  `executeInternal`, entered from `:5189`.
  - Materializing a dormant restored thread goes through
    `materializeRecoveredSession` (`:8038-8113`) and then
    `startRecoveredOrchestrationSession`
    (`orchestration-session-state.ts:1387-1470`). That path starts the engine
    with **no `modelOptions`**, so any posture set at spawn is lost today.
- **Foreground sends.** Every UI send goes through `POST /api/orchestration/chat`
  (`orchestration.ts:1721`) or `POST /chat/:conversationId/continue` (`:1915`).
  - Both reach `executeForegroundMessage`
    (`src-server/services/execution-target/execution-target-execution.ts:387`).
  - That function starts the session (`:665-667`) and dispatches `sendTurn`
    (`:879-881`), with the same `target.model.options` for both.
  - A stopped conversation continues in a new child thread,
    `<conversation>:session:<uuid>`, reserved in the conversation lineage
    before its start (`conversation-lineage.ts:171-289`).

### 3.2 Event store and event kinds

- **The event union.** `CanonicalRuntimeEvent` is at
  `packages/contracts/src/runtime-events.ts:1017-1044`.
  `session.stop-settled` (`:423`) is the precedent for a Station-originated
  event rather than one an engine reports.
- **Publishing.** Station-originated events use `projectAndPublishEvent`, which
  leads to `publishCanonicalEvent` (`orchestration-service.ts:7561-7830`). That
  function projects the event, calls `eventStore.appendEvent` (which assigns
  `sequence` and `global_sequence`, `event-store.ts:2896-2950`), and emits the
  SSE frame.
  - The SSE `id` is the global sequence (`orchestration.ts:4054-4087`).
- **Conversation lineage.** `eventStore.conversationForSession` and
  `conversationSessions` (`event-store.ts:7324-7337`) map a thread to its
  conversation and list that conversation's sessions.

### 3.3 Where a turn start resolves an approval mode, per engine

The only channel today is `modelOptions.approvalMode`. It is read by
`readApprovalMode` (`packages/contracts/src/provider.ts:487`).

- **Claude** (`src-server/providers/adapters/claude-adapter.ts`).
  - At spawn, `resolvePermissionMode` runs (`:1253`). The adapter grants
    `allowDangerouslySkipPermissions` only for `bypassPermissions`
    (`:2553-2554`), and that grant can be made **only at spawn**.
  - At each turn, `setPermissionMode` is called only when the mode is defined
    and changed (`:1468-1511`). An absent or `connection-default` mode is a
    **no-op**, and that no-op is the #2409 bug.
  - Escalating to `never` without the spawn grant publishes a `runtime.warning`
    with code `approval-escalation-requires-restart` (`:1479-1506`).
  - Applied reports come from `session.configured` metadata (`:1324-1345`), the
    SDK init message (`claude-adapter-events.ts:392-415`), and `turn.started`
    metadata (`:1605-1616`).
  - The mapping is in `claude-approval-mode.ts:5-49`.
- **Codex** (`codex-adapter.ts`, `codex-approval-mode.ts`).
  - The knobs are recomputed on every `turn/start` (`:2168-2206`). An absent
    mode omits the knobs, and Codex keeps the previous pair. There is no
    "reset to config" value, so a Default pick has the same no-op.
  - At thread start the knobs are sent only when they are defined
    (`:1740-1770`).
- **ACP, Ollama, Bedrock and Muse** do not accept `approvalMode`, and sending
  it throws `Unsupported option` (`provider.ts:533-610`). The `station-agent`
  adapter ignores it.

### 3.4 Client send paths

| Path | Where | Posture today (#2449) |
| --- | --- | --- |
| Composer send | `src-ui/src/hooks/useActiveChatSessionMessaging.ts:379-411` | `approvalModeToSend`, plus the Station default when starting |
| Offline replay | the same hook, with `executionSnapshot` | the same |
| Queued follow-up drain | `src-ui/src/hooks/orchestration/queueDrain.ts:205-219` | `approvalModeToSend` |
| Legacy needs-input reply | `components/attention/AttentionCard.tsx:545` | none (#2418) |
| Needs-input reply | `components/attention/NeedsInputReply.tsx:122` | none (#2418) |
| Delegated task coordinator | `components/session-detail/DelegatedTaskCoordinator.tsx:49` | none (#2418) |
| Session-detail composer | `hooks/useMutableSessionDetailState.ts:279` | none (#2418) |
| Steer | `useActiveChatSessionMessaging.ts:299`, `ChatDockBody.tsx:1021` | none (continues the open turn, so exempt) |

The four #2418 paths use `sendOrchestrationTurn`, which calls
`/chat/:id/continue`, or `sendExecutionMessage`, which calls `/chat`. Both end
at the server's `sendTurn` case, so server application covers them with no
client change.

### 3.5 Fold, chip and persistence (#2449)

- **The fold.** `settleApprovalPick` in `utils/approvalMode.ts` is called from
  `hooks/orchestration/sessionHandlers.ts:52` and `turnHandlers.ts:248`. The
  escalation refusal is handled at `turnHandlers.ts:600-640`.
  - Stream positions come from `hooks/orchestration/streamPosition.ts`.
- **The chip.** `components/badges/ApprovalModeChip.tsx`. It is fed by
  `sessionApprovalOverride` (`ChatDockBody.tsx:1398`, `ACPChatPanel.tsx:356`).
- **Persistence.** `contexts/active-chats-state.ts:347-369`, `:571-575`,
  `:746-762`, `:905-921` and `:1030-1032`. The pick fields are
  `pendingApprovalMode`, `pendingApprovalPickedAt`, `pendingApprovalBehindTurn`,
  `pendingApprovalAppliedAtPick` and `approvalModeOverride`.
- **The pick handler.** `hooks/useChatInput.ts:860-883`.

### 3.6 Pairing-route scopes

`POST /api/orchestration/commands` is `orchestration:operate`
(`src-server/security/pairing-route-scopes.ts:2389`). So are `/chat` (`:2395`)
and `/chat/:conversationId/continue`. Those routes already carry
`modelOptions.approvalMode`, including `never`.

## 4. Design

### 4.1 Contract

- **The event.** A new `SessionApprovalModeSetEvent`
  (`method: 'session.approval-mode-set'`, with `sessionId` and
  `approvalMode: ApprovalMode`) is added to the `CanonicalRuntimeEvent` union.
  Station emits it. No engine does.
- **The command.** A new `{ type: 'setApprovalMode'; threadId; approvalMode }`
  is added to `OrchestrationCommand` and to the `/commands` body schema. The
  result is `{ threadId, approvalMode, sequence }`, where `sequence` is the
  event's global sequence.
- **Carried decisions.** `setApprovalMode?: ApprovalMode` is added to
  `OrchestrationSendTurnInput`, to the session-start input, and to the
  foreground `/chat` and continue bodies.
  - A decision carried by a send is recorded when the server receives it,
    before that send's session start or turn is applied.
  - This is how a pick made before the chat has any session, or a pick made
    offline, reaches the server ordered at its receipt.

### 4.2 Server application: one resolution at every start and turn

`OrchestrationService.resolveApprovalMode(threadId, carried)` resolves the
posture as follows:

1. The latest `session.approval-mode-set` across the thread's conversation
   (every session in its lineage), ordered by global sequence.
2. Otherwise, the `modelOptions.approvalMode` the start or turn carried. This
   is the default channel: the Station or connection default the UI sends when
   a session starts, and the CLI's `--approval-mode`. Its behaviour does not
   change, and it is never recorded as a decision.

A recorded posture replaces whatever the turn carried. The resolved value is
written into `modelOptions.approvalMode` only for an adapter whose
`unsupportedModelOptionKeys` admits it. It is applied at:

- `sendTurn` (`:5433`);
- `startSession`, through both dispatch paths;
- `materializeRecoveredSession`. This means a dormant thread is restored at its
  recorded posture, which closes the posture loss found in §3.1.

The posture is scoped to the conversation rather than to one thread. That is
forced by the invariant. A continuation child is a new thread, and starting it
at the defaults would be looser than a recorded Ask whenever the Station
default is looser.

### 4.3 Station's default, and the Default pick (#2409)

- **Station's default is unchanged.** It is resolved client-side and sent only
  on a message that starts a session (`approvalModeForDispatch`). It rides the
  default channel, so it is never recorded and never outranks a recorded
  decision.
- **A Default pick** records `connection-default`. At a start or turn, that
  resolves to a concrete posture in this order:
  1. `AppConfig.defaultApprovalMode`. The server reads it through the new
     `resolveStationDefaultApprovalMode` option, wired like
     `resolveStationDefaultWorkspaceIsolation`
     (`runtime-initialize.ts:605`) and loaded per call.
     - The option's signature also accepts the connection id. The engine
       connection's own `config.approvalMode` is not consulted on the server
       yet, because the only server reader of it is the full
       connection-inventory listing, and that is too heavy to run on every
       turn start.
     - The chip shows whatever the engine reports as applied once a turn has
       run, so what it names cannot drift from what the engine did (§8).
  2. If neither is set and Station has put a concrete posture on this live
     thread, the result is **`ask`**. This is the engine's own standard mode:
     Claude's `default` permission mode, and Codex's
     `untrusted`/`workspace-write`. The engine is then actually moved off
     bypass. The applied report then names Ask first, and the chip shows
     "Default" with that applied posture in its accessible name.
     - Station has put a posture on the thread when the service itself passed
       a concrete `approvalMode` to that thread's start or turn. This is
       tracked per thread in the service and cleared on `session.exited`.
     - The engine's own configured default cannot be observed once Station has
       overridden it at spawn, so `ask` is the concrete choice. It is at least
       as strict as every other posture.
  3. Otherwise nothing is sent, and the engine keeps its own configuration
     (#1950).

### 4.4 A session already running with a spawn-time posture

A session spawned before this change has nothing recorded.

- Its first recorded decision applies at its next turn, as a `modelOptions`
  mode does today.
- Claude's spawn-only bypass grant still applies. A recorded `never` on a
  session spawned without bypass is refused by the adapter, with the existing
  warning.
- Server application would repeat that refusal on every turn, so the adapter
  now warns once per session for the same refused target. `turn.started`
  still reports `approvalEscalationRejected`. The chip reads that report and
  says that full access needs a restart, not "next turn".
- A child session started after that point spawns at `never` with bypass
  granted.

### 4.5 Codex and ACP per-turn posture

- **Codex** already takes the knobs on every `turn/start`. The server now
  always resolves a concrete pair when anything is recorded, so a Default pick
  is no longer a no-op (§4.3).
- **ACP, Ollama, Bedrock, Muse and the Station agent** have no knob.
  - The command is refused for a thread whose engine has no knob, with the
    error "This engine has no approval control".
  - A posture recorded while the conversation ran on a knob engine is not
    sent to a no-knob engine after a handoff. It applies again if the
    conversation returns to a knob engine.
  - ACP's session `mode` is a separate control and is unchanged.

### 4.6 Offline and early picks

- **Online, with a session that exists server-side.** The pick handler sends
  `setApprovalMode` at once. Until the result arrives, the pick is held as
  `queuedApprovalMode`, and the chip shows it as requested.
- **Offline, a failed command, or a chat with no session yet.** The pick stays
  in `queuedApprovalMode`, which is persisted. The next composer send, offline
  replay or drain carries it as `setApprovalMode`, and the server records it
  when it receives it.
  - An offline pick is therefore ordered by when the server receives it, not
    by when the user picked it. That is the honest order: it is when the
    decision became known to everyone else.

### 4.7 The client fold and the chip

- **Chat state.** `ChatUIState` keeps:
  - `approvalPosture` and `approvalPostureSequence`, the latest recorded
    decision and its global sequence;
  - `queuedApprovalMode`;
  - `lastAppliedApprovalMode`, the engine's report, unchanged;
  - `approvalEscalationRejected`, from `turn.started` metadata.
- **Sources of the posture fold.** The fold takes values from
  `session.approval-mode-set` events, which use the SSE `id` as their
  sequence, and from the command result.
  - A send that carried a queued pick has succeeded only once the server has
    recorded that pick. The client then holds it as the posture, with an
    unknown sequence, until the event itself arrives.
  - A value replaces the current one only when its sequence is newer, or when
    either sequence is unknown. Because an HTTP result and the SSE stream can
    interleave, the display can briefly show an older value. It converges when
    the event arrives. The engine is never affected by this.
- **Chip states.** The chip shows the queued pick, else a concrete recorded
  posture.
  - Its state is `requested` until an applied report matches it, then
    `confirmed`.
  - "Takes effect next turn" is now true on every send path, so #2449's
    `unconfirmed` state and its copy are removed.
- **Removed.**
  - The pending and confirmed fields and their stamps.
  - `settleApprovalPick`, `approvalModeToSend`, `approvalPickUpdate` and
    `approvalPickOverridingDefaults`.
  - The stricter-only rule.
  - The per-send resend.
  - The client's "latest position seen" tracker, and
    `chatSessionKnownEnded`. `streamPosition.ts` keeps only each event's own
    position, which is what the fold orders by.

### 4.8 Who may set posture

The command inherits the tier of `/commands`, which is `orchestration:operate`.
This is the same tier that already sends a turn carrying
`modelOptions.approvalMode`, including `never`.

Command authorization (`canReadSessionForCommand`,
`session-authorization.ts:489`) admits only the session owner and that owner's
own principals: the operator and paired devices. It admits no other human
member.

So the command grants no authority that does not already exist, and there is
no multi-user shared session for which "who may set it" is a new question.
This is reported as a choice, not a fork.

## 5. Migration of persisted chats

#2449 never merged to `main`, so its fields exist only in development state.
`main`'s persisted shape is an `approvalMode` inside the options bags.
`hydrateActiveChats` migrates both:

- It removes `approvalMode` from `requestedProviderOptions` and
  `providerOptions`.
- It takes the first of: a pending pick, a confirmed pick, or the bag value.
- If that value is `ask` or `auto`, it becomes `queuedApprovalMode`, so the
  decision is recorded on the next send. A pending `never` is kept, because it
  was an explicit request that had not been sent.
- A confirmed or bag `never` is dropped, as #2449 did, so stale state never
  re-escalates.
- `connection-default` is dropped.

## 6. Tests

The acceptance bar is the invariant.

- **The probe table, end to end**
  (`src-server/routes/orchestration/__tests__/approval-posture.lifecycle.test.ts`).
  This drives the real `/chat`, `/chat/:id/continue` and `/commands` routes,
  the real foreground executor, the real `OrchestrationService` and the real
  event store, with a fake engine.
  - The #2449 probe table is re-derived under server order (§7). Devices are
    modelled as commands. An offline pick is a pick carried on a later send.
  - Every turn completes, so each continuation is a new child session, and
    the posture has to carry across the children.
  - A malformed mode is refused on `/commands`.
- **The service**
  (`src-server/services/orchestration/__tests__/approval-posture.test.ts`).
  This drives the real command path on one live session. It covers:
  - the recorded event and its sequence;
  - M1;
  - a same-posture re-pick from another device;
  - the ordering of a carried offline pick;
  - the respawn of a dormant session;
  - Codex;
  - refusal on an engine with no approval control;
  - each #2409 Default case.
- **Client lifecycle** (`approvalPick.lifecycle.test.tsx`). This goes through
  the real `useChatInput`, send hook, drain, event fold and `ApprovalModeChip`.
  It covers:
  - the pick becoming a command, or staying queued offline;
  - the queued pick riding the next send;
  - the fold ordering by sequence;
  - the chip's states;
  - the migration.
- **#2418.** Every path in §3.4 ends at `sendTurn`. The server test sends turns
  with no posture through the two public entry points those paths use
  (`/chat` and `/chat/:id/continue`) and asserts the recorded posture on the
  engine.

## 7. The probe table under server order

This is the engine posture at the next turn start. "Decision" means a recorded
`setApprovalMode`. A report is not a decision.

| Probe | Sequence | #2449 | Server-ordered |
| --- | --- | --- | --- |
| E | Desktop decides never, then the phone decides Ask | Ask | Ask |
| E2 | E, with a desktop reload in between | Ask | Ask |
| E3 | Never decided, a reload, then the phone decides Ask unseen | Ask | Ask |
| G | Desktop decides never online, then the phone decides Ask | Ask | Ask |
| G-off | Desktop picks never offline, the phone decides Ask, then the desktop reconnects and sends | Ask | **never**: received last, so it is the latest decision |
| R | Desktop decides Ask, then the phone decides never | Ask | **never**: the latest decision |
| R-report | Desktop decides Ask, and the phone's turn only *reports* never | Ask | Ask |
| T1 | Ask picked offline, looser reports replayed | Ask | Ask |
| S1 | Ask decided, the phone decides never, the session ends | Ask | **never**: the latest decision, carried to the child |
| Q | Ask decided, the phone decides never, the desktop sends | Ask | **never** |
| T3 | Ask decided, a reload mid-turn, Station default never | Ask | Ask: recorded outranks the default |
| S2 | Auto decided, the phone decides Ask | Ask | Ask |
| H | Default decided, no defaults, nothing applied by Station | nothing | nothing |
| H-2409 | Claude at never, then Default decided with no defaults | nothing (bug) | **Ask**, moved off bypass |
| I | Never decided, Ask decided, the phone's turn reports never | Ask | Ask |
| N | Never decided, the session ends, Station default auto | auto | **never**: recorded, carried to the child |
| M1 | Auto decided, the phone decides Ask while the desktop is disconnected, then the desktop sends | Auto (M1) | **Ask** |

Every "never" in the right-hand column is the user's latest decision in
server order. No row leaves the engine more permissive than that decision.
The rows where #2449 applied Ask because a later decision was invisible to it
now follow that later decision. That is the ordering the owner decided on.

## 8. Boundaries and non-goals

- **A running turn keeps its posture until the next turn starts,** as on
  `main` and on #2449. A tightening made mid-turn applies at the next turn
  start. Applying it mid-turn through Claude's live `setPermissionMode` is a
  possible follow-up and is not in this change.
- **Remote Environments.** The foreground executor can send turns to another
  Station. A carried `setApprovalMode` is forwarded only as far as that
  Station's own contract accepts it, and an older remote Station ignores it.
  Posture on a remote conversation is not covered.
- **A connection's own approval default is not read on the server.** A Default
  pick resolves to the Station default, or to `ask` (§4.3). If an engine
  connection sets its own `config.approvalMode`, the chip still displays that
  value until the first turn reports what the engine applied. This is a
  display gap, and it errs toward the stricter posture.
- **The posture is not added to the session-summary snapshot.** A client that
  reconnects through a snapshot folds the posture from the next event, or from
  its own command result. The engine is correct either way, because the
  server applies the posture. What the chip shows between a snapshot and the
  next posture event is a display lag, not an enforcement gap.
