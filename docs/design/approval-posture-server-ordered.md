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

The design was revised in a review fix round. The review found two paths
that did not meet the bar (HIGH-1 and HIGH-2), and the round also added
compare-and-set (MEDIUM-1). Two owner decisions came with it: escalation
authority (§4.8) and an Agent-level default (§4.9). This section describes
the design as built.

### 4.1 Contract

- **The event.** A new `SessionApprovalModeSetEvent`
  (`method: 'session.approval-mode-set'`, with `sessionId` and
  `approvalMode: ApprovalMode`) is added to the `CanonicalRuntimeEvent` union.
  Station emits it. No engine does.
- **The command.** A new
  `{ type: 'setApprovalMode'; threadId; approvalMode; basedOnSequence? }` is
  added to `OrchestrationCommand` and to the `/commands` body schema.
  - The result is `SetApprovalModeResult`, which is
    `{ threadId, recorded, approvalMode, sequence }`.
  - `sequence` is the standing decision's global sequence.
  - `recorded: false` means compare-and-set lost (§4.6). In that case
    `approvalMode` and `sequence` name the newer decision that stands.
- **Carried picks.** `setApprovalMode` and `setApprovalModeBasedOn` are added
  to the foreground `/chat` body, the continue body and
  `ForegroundMessageInput`.
  - The foreground executor records a carried pick **before** the send's
    session start and turn. The spawn is therefore already in it, and it is
    ordered by this receipt.
  - The executor reports the result on the receipt as `approvalMode`.
  - `OrchestrationSendTurnInput` and the session-start input carry no pick.
- **The refusal.** `APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE`
  (`approval-full-access-not-granted`) is returned with status 403 (§4.8).
- **The Agent default.** `AgentExecutionConfig.approvalMode` is new (§4.9).

### 4.2 Server application: one resolution at every start and turn

`ApprovalPosture.resolve` (`src-server/services/orchestration/approval-posture.ts`)
decides the `modelOptions` of every start and turn. It applies only to an
engine with an approval knob, and it resolves in this order:

1. **The latest recorded decision** across the thread's conversation (every
   session in its lineage), by global sequence. A recorded Default resolves
   through §4.3.
2. **Otherwise, a posture the start or turn itself carries** on
   `modelOptions.approvalMode`. Examples are `station chat --approval-mode`,
   and an older client or remote Station.
   - The UI no longer sends one.
   - Accepted residual (MEDIUM-2): a stale client can still send one while
     nothing is recorded. That is the same as `main`, where every client sent
     it.
3. **Otherwise, at a session start only, the defaults.** These are the
   Agent's own (§4.9), then this Station's `AppConfig.defaultApprovalMode`.
   - The server resolves them, so the Station default no longer depends on
     the client that started the session.
   - A turn on a live session carries no default. A default is the posture a
     session starts in, and re-requesting it would let an edit of the setting
     reconfigure a running chat (#2144 slice 6).

It is applied at:

- `sendTurn`;
- `prepareStart`, the common path for every session start;
- a dormant session's respawn (`materializeRecoveredSession`);
- a credential-profile recovery restart and its replay (HIGH-2), through
  `withApprovalPostureForStart` and `replayModelOptionsWithPosture`. Before
  this round, the replay reused the source turn's posture directly on
  `adapter.sendTurn`. That undid any tightening recorded since.

The posture is scoped to the conversation rather than to one thread. That is
forced by the invariant. A continuation child is a new thread, and starting it
at the defaults would be looser than a recorded Ask whenever a default is
looser.

### 4.3 The Default pick (#2409)

A Default pick records `connection-default`. At a start or turn it resolves in
this order:

1. **The Agent's default, then this Station's default.** The Station default
   is read per call through `resolveStationDefaultApprovalMode`, wired like
   `resolveStationDefaultWorkspaceIsolation`.
2. **Else `ask`,** if Station has put a concrete posture on this live thread.
   - `ask` is the engine's own standard mode: Claude's `default` permission
     mode, and Codex's `untrusted`/`workspace-write`.
   - The engine is actually moved off bypass. The applied report then names
     Ask first.
   - The engine's configured default cannot be observed once Station has
     overridden it at spawn. `ask` is at least as strict as every other
     posture.
3. **Else nothing,** and the engine keeps its own configuration (#1950).

An engine connection's `config.approvalMode` is **not** a layer.
`sanitizeRuntimeConfig` persists only named keys, so no writer can ever set
it. The client's display layer for it is replaced by the Agent default.

### 4.4 A session already running with a spawn-time posture

A session spawned before this change has nothing recorded.

- Its first recorded decision applies at its next turn.
- Claude's spawn-only bypass grant still applies. A recorded `never` on a
  session spawned without bypass is refused by the adapter.
- The adapter warns once per refusal, not on every turn.
  - `turn.started` still reports `approvalEscalationRejected`.
  - The chip says the pick needs a restart, not that it takes effect next
    turn.
- A child session started after that point spawns at `never`, with bypass
  granted.

### 4.5 Codex and ACP per-turn posture

- **Codex** takes the knobs on every `turn/start`. The server resolves a
  concrete pair whenever anything is recorded, so a Default pick is no longer
  a no-op.
- **ACP, Ollama, Bedrock, Muse and the Station agent** have no knob.
  - The command is refused on them with "This engine has no approval control".
  - A carried pick is not recorded for them.
  - After a handoff to such an engine, a recorded posture is not sent to it.
  - ACP's session `mode` is a separate control.

### 4.6 Offline and early picks, and compare-and-set (MEDIUM-1)

- **Online, with a session.** The pick handler sends `setApprovalMode` at once.
  Until the result arrives the pick is held as `queuedApprovalMode`.
- **Offline, a failed command, or no session yet.** The pick stays queued, and
  the queue is persisted. The next composer send, offline replay or drain
  carries it.
- **Compare-and-set.** Every pick names the latest decision sequence the chat
  had folded when the user picked. `null` means it had folded none.
  - The server records the pick only if no newer decision exists for the
    conversation. Otherwise it drops the pick and returns the standing
    decision.
  - The client folds that decision, clears the queue, and adds a one-line
    note: "Your approval pick was not applied: another device had already set
    it to …".
  - An API caller that sends no basis records unconditionally.
  - The check and the append are one synchronous step.
- **What this closes.**
  - **G-off.** An offline full access that never saw the phone's later Ask is
    dropped.
  - **The duplicate-carry race.** The command and a send that carries the same
    queued pick record it once.
  - **The spawn window.** A carried pick is recorded before its session
    starts.

### 4.7 The client fold and the chip

- **Chat state.** A chat keeps these fields:
  - `approvalPosture` and `approvalPostureSequence`;
  - `queuedApprovalMode`;
  - `lastAppliedApprovalMode`;
  - `approvalEscalationRejected`.
- **Sources of the fold.** The posture is folded from three places:
  `session.approval-mode-set` events, which are ordered by the SSE `id`; the
  command result; and the result a send reports.
- **A carried pick is settled only by a reported result, never by the send
  succeeding.**
  - A Station that reports nothing leaves the pick queued, and the next send
    carries it again. That Station is either an older one, or another Station
    this send was forwarded to that predates the command.
  - This matches how those Stations always treated the options channel.
- **Chip states.** The chip shows the queued pick, else a concrete recorded
  posture, else the defaults.
  - A recorded pick is `requested`, then `confirmed`. It is `refused` when it
    is a full access Claude refused.
  - The Agent's default reads, for example, "Full access (agent default)". It
    says so only while the engine has reported nothing different.
- **Refusal.** A 403 `approval-full-access-not-granted` on the command, or on
  a send that carried the pick, drops the queued pick with a note. It is not
  retried, because it could only be refused again.
- **Removed.** The pending and confirmed fields, the stricter-only rule, the
  per-send resend, the client-side default resolution
  (`approvalModeForDispatch`, `approvalModeFallback`), and the connection
  default display layer.

### 4.8 Who may set posture (owner decision: escalation authority)

- **Tightening is open.** Any `orchestration:operate` caller may tighten to
  Ask or Auto, or pick Default.
- **Full access (`never`) is gated.** It needs the operator in person, or a
  device holding the new operator-promotion scope `approval:full-access`.
  - The scope is in no preset and never in the default grant, like
    `engine:login` and #2412's `coding:exec`.
  - The operator grants it once per device, in the device access editor
    ("Allow full access").
- **One derivation.** The check is `mayGrantFullAccess` in
  `src-server/security/coding-authority.ts`, next to #2412's
  `mayRunCommandsOnHost`. It shares the same `isOperatorInPerson`.
- **Where it is enforced.** `routes/orchestration/approval-authority.ts`
  enforces it on every route that can put a session at full access:
  - `/commands` `setApprovalMode`;
  - `/chat`, `/chat/delegated` and `/chat/background` (a carried pick, or
    `target.model.options.approvalMode`);
  - `/chat/:id/continue`;
  - the conversation handoff;
  - `/delegations`, and a delegation continue;
  - task dispatch (`runtimeConfig.modelOptions`).
- **The refusal.** It is 403 with `approval-full-access-not-granted`, decided
  before the send or the command has any effect.
- **Who can reach a session at all.** Command authorization
  (`canReadSessionForCommand`) admits only the session owner's own
  principals. There is no multi-user shared session to decide for.

### 4.9 An Agent's default posture (owner request)

- **Field.** `AgentSpec.execution.approvalMode`. It sits under `execution`
  next to `credentialProfileRef`. Like that field, it is a per-Agent engine
  execution setting, read by the server where the engine session starts, and
  meaningful only on an engine with an approval knob.
- **Precedence at a session start:** the recorded decision, then the Agent's
  default, then the Station's. A Default pick returns to the Agent's default.
  A member can tighten below it at any time.
- **Write authority.** Saving `never` needs the same authority as §4.8.
  - Every Agent write from outside the server goes through `POST /agents` or
    `PUT /agents/:slug`: the editor, the SDK and CLI, and the Station-control
    MCP tools, whose schema does not accept `execution` at all.
  - Only raising a default to `never` is gated. An edit that leaves an
    existing `never` default as it is (a client resending the whole
    `execution` block) is not.
  - Agents have no per-member edit rights. Any operate caller may edit any
    Agent, global or Project-scoped, so the gate is by device authority, not
    by Project membership.
- **Display.** The chip shows the Agent's default. The Agent editor's Engine
  section has the "Default approval mode" field, and it names what full access
  means.
- **Schema.** `schemas/agent.schema.json` admits `execution.approvalMode`.
  Before this change its closed `execution` object rejected the field, so a
  saved default made the Agent unloadable.
- **Plugin-contributed Agents.** Their full-access default is not applied.
  - A plugin is installed at the ordinary operate tier, so a `never` it ships
    is full access that no one with the authority chose.
  - Their stricter defaults (Ask, Auto) apply.
  - A Workspace Pane action's admission captures the plugin Agent's
    definition. The start consumes that captured value and never rereads the
    store.
- **A failed read fails the start.** If the Agent's execution config cannot be
  read, the start fails, exactly as the credential-profile pin read beside it
  does. An unreadable default is not the same as no default.

## 5. Migration of persisted chats

#2449 never merged to `main`, so its fields exist only in development state.
`main`'s persisted shape is an `approvalMode` inside the options bags.
`hydrateActiveChats` migrates both:

- It removes `approvalMode` from `requestedProviderOptions` and
  `providerOptions`.
- It takes the first of: a pending pick, a confirmed pick, or the bag value.
- If that value is `ask` or `auto`, it becomes `queuedApprovalMode`, so the
  decision is recorded on the next send.
- Full access is dropped in every form, including an unsent #2449 pending
  `never`. Stale state never re-escalates, and full access now needs an
  authority the old build never checked.
- `connection-default` is dropped.

## 6. Tests

The acceptance bar is the invariant.

- **The probe table, end to end**
  (`src-server/routes/orchestration/__tests__/approval-posture.lifecycle.test.ts`).
  - It drives the real `/chat`, `/chat/:id/continue` and `/commands` routes,
    the real foreground executor, the real `OrchestrationService` and the real
    event store.
  - The desktop client is modelled with its folded sequence, which it sends
    as the compare-and-set basis.
- **The service**
  (`src-server/services/orchestration/__tests__/approval-posture.test.ts`).
  It covers:
  - the recorded event;
  - M1;
  - a same-posture re-pick;
  - compare-and-set: G-off, a basis of `null`, the duplicate-carry race, and
    the spawn window;
  - dormant respawn;
  - the credential-profile recovery replay (HIGH-2);
  - Codex, and refusal on an engine with no knob;
  - Agent-default precedence;
  - each #2409 Default case.
- **Remote carry** (`src-server/tools/__tests__/station-control-delegation.test.ts`).
  A `/chat` send and a continue to another Station are parsed with the
  pre-#2436 schemas, which strip unknown keys. The pick still arrives on
  `model.options.approvalMode`.
- **Escalation authority**
  (`src-server/routes/orchestration/__tests__/approval-full-access-authority.routes.test.ts`).
  This uses the real pairing, the real auth boundary and the real routes. It
  covers:
  - an operate device refused on `never` and allowed on Ask, Auto and Default;
  - the operator in person;
  - a granted device;
  - a revoked grant;
  - sends refused before running;
  - Agent writes, from a delegation device and from the operator.
- **Client lifecycle** (`approvalPick.lifecycle.test.tsx`). It covers:
  - the pick as a command, and the compare-and-set basis;
  - a superseded note;
  - a result-only settle, including a Station that reports nothing;
  - the refusal;
  - the fold order;
  - the chip;
  - the migration.
- **Agent editor** (`AgentEditorApprovalDefault.test.tsx`): the field, and
  that it round-trips through an unrelated save.

## 7. The probe table under server order

This is the engine posture at the next turn start. "Decision" means a recorded
`setApprovalMode`. A report is not a decision.

| Probe | Sequence | #2449 | Server-ordered |
| --- | --- | --- | --- |
| E | Desktop decides never, then the phone decides Ask | Ask | Ask |
| E2 | E, with a desktop reload in between | Ask | Ask |
| E3 | Never decided, a reload, then the phone decides Ask unseen | Ask | Ask |
| G | Desktop decides never online, then the phone decides Ask | Ask | Ask |
| G-off | Desktop picks never offline, the phone decides Ask, then the desktop reconnects and sends | Ask | Ask: the offline pick never saw Ask, so compare-and-set drops it |
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
server order, made by a caller allowed to grant full access (§4.8). No row
leaves the engine more permissive than that decision.

## 8. Boundaries and non-goals

- **A running turn keeps its posture until the next turn starts,** as on
  `main`. A tightening made mid-turn applies at the next turn start.
- **Remote Environments.** A pick sent to another Station travels both as
  `setApprovalMode` and on `model.options.approvalMode`, so a Station that
  predates the command still applies it (HIGH-1).
  - The pick is settled only when that Station reports a result. Until then
    it stays queued and is resent, as the options channel always was there.
  - The pick command itself (`/commands`) addresses this Station, so for a
    remote conversation the pick always rides the next send.
- **Stale clients (MEDIUM-2, accepted).** While nothing is recorded, a posture
  on `modelOptions.approvalMode` from a stale client applies, exactly as on
  `main`. Once anything is recorded, the recorded decision outranks it. A
  `never` there is subject to §4.8 like any other.
- **Agent files edited on disk are not gated.** That is a same-user channel,
  and it does not go through the Agent write routes.
  - A plugin-contributed Agent's `never` default is not applied (§4.9).
  - Neither is a `never` the operator saves on a plugin-owned Agent: the next
    plugin update would re-copy the Agent anyway.
- **The posture is not added to the session-summary snapshot.** A client that
  reconnects through a snapshot folds the posture from the next event or from
  its own result. The engine is correct either way, because the server applies
  the posture.
