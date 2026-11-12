# Design: server-ordered approval posture

> **Reading status: accepted design and implementation history.** Section 3's
> surface map, line numbers, comparisons with `main`, and test reports describe
> the recorded revisions below. They are not a fresh authorization audit.
> Current posture resolution is owned by
> [ApprovalPosture](../../src-server/services/orchestration/approval-posture.ts),
> applied by [OrchestrationService](../../src-server/services/orchestration/orchestration-service.ts);
> [coding authority](../../src-server/security/coding-authority.ts) separately
> owns full-access grants. Use the [Session API](../reference/session-api.md)
> for current requests. The historical “full access” descriptions do not replace
> those current authority and engine boundaries.

> The later `steerChildWork` command also checks the parent turn's current
> confinement before dispatch. It is a separate child-targeted command; the
> historical `steerTurn` discussion below does not describe its receipt or
> instruction history. See the [Session API](../reference/session-api.md) and
> [remote access threat model](../security/remote-access-threat-model.md) for
> those boundaries. This is source evidence, not a native or hosted journey.

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
    `allowDangerouslySkipPermissions` for `bypassPermissions`, and also for
    a `host`-confined start (its caller may grant full access) that Station
    gives a concrete mode, so a later recorded `never` applies at a turn with
    no restart. That grant can be made **only at spawn**. It is not taken by
    a `workspace` start below full access, by a start that leaves the mode to
    the engine's own settings, by a raw `plan` start, or as root outside a
    sandbox (Claude refuses to spawn with it there). A tool session grant never forwards an
    engine-suggested switch into `bypassPermissions`.
  - At each turn, `setPermissionMode` is called only when the mode is defined
    and changed (`:1468-1511`). An absent or `connection-default` mode is a
    **no-op**, and that no-op is the #2409 bug.
  - A turn whose resolved mode is `never` on an engine without the spawn
    grant (`turnNeedsEngineRelaunch`) first parks the idle engine, so the turn
    restarts it in place from its resume cursor at the recorded `never`, with
    the grant. Where parking refuses (an open request, running child work, no
    resume cursor), the escalation reaches the live engine, which publishes a
    `runtime.warning` with code `approval-escalation-requires-restart`.
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
  `{ type: 'setApprovalMode'; threadId; approvalMode; basedOnSequence }` is
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
   - Later addition: between the two, a start in a Project applies that
     Project's new-chat approval mode (`defaultApprovalMode`, or with
     `last-used` the mode the person's last chat there started in;
     `resolveProjectChatApprovalDefault`). The start composer's Permissions
     chip picks the new chat's own mode, which outranks all of these. It is start-only: a recorded
     Default (§4.3) and the full-access checks over it still read the Agent
     and Station defaults, and the composer shows a Default pick that way.
     The person's per-engine default comes after it: the composer sends it as
     a `personalApprovalDefault` hint, and the server records it as the
     conversation's decision only when neither the Agent nor the Project
     decides (`recordPersonalApprovalDefault`). A `last-used` full access needs the start's own
     grant (`host` confinement); see the
     [API reference](../reference/api.md#project-new-chat-defaults).
   - The server resolves them, so the Station default no longer depends on
     the client that started the session.
   - **Owner decision (2026-09-23): this applies to every session start.**
     That includes `station chat`, delegations, inbound webhooks, Discord and
     scheduled jobs, not only chats from the UI.

Later addition (#4518): under a machine's managed
[approval-mode ceiling](../decisions/managed-policy.md#approval-mode-ceiling),
a recorded pick above it refuses the start or turn, carried postures and
defaults are lowered to it, and where none of the three applies the start
sends Ask rather than nothing. A recorded personal default is not a pick: its
`session.approval-mode-set` event is marked `source: "personal-default"`, and
it is lowered to the ceiling in force like any other default.
   - Before this change only a UI chat sent the default. Choosing Full access
     as the Station default now gives those unattended starters full access.
     The settings row, `AppConfig.defaultApprovalMode` and the app schema say
     so where the operator makes that choice.
   - A turn on a live session carries no default. A default is the posture a
     session starts in, and re-requesting it would let an edit of the setting
     reconfigure a running chat (#2144 slice 6).
   - **Exception: a confinement change (#2898, owner decision 2026-09-27).**
     While a session's confinement is not the one its engine was started
     under (§4.8: its device grantor lost `approval:full-access`, so its
     `host` stamp applies as `workspace`), a turn with nothing recorded or
     carried re-sends the mode Station last passed that engine, applied under
     the confinement that holds now. Claude takes it as a permission mode
     (`never` becomes `auto`); Codex keeps `never` inside its
     `workspace-write` sandbox. It is the mode the engine already runs, never
     a re-read default, so an edited default still reconfigures nothing, and
     an ordinary turn still sends nothing. It is sent on every such turn
     until the engine restarts, so a turn that fails before reaching the
     engine cannot leave it at its start posture; both adapters treat a
     repeated mode as no change. `ApprovalPosture.reconfinedMode` decides it.

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

#### Preparation currentness (2026-10-31)

Resolving options is not the final permission check. Preparation can await
Agent, credential, workspace or resource admission after reading a decision.
Ordinary sends, fresh starts, dormant recovery, credential restarts and direct
credential replay now capture the decision sequence, effective confinement and
grantor before resolution and check them again before provider entry. The
snapshot belongs to that invocation: fresh start associates it with the exact
prepared input, while recovery and replay carry it with their prepared result.
No home lease is held across those awaits.

A changed snapshot refuses the pending operation instead of invoking the
provider with old options. Start refusal uses `approval-posture-changed`, a
nonretryable permission denial; dormant recovery preserves that code and
refused phase in its durable error event. A known final refusal after invocation
accounting uses definitive-refusal settlement. Storage failures and effects
whose acceptance is uncertain retain their existing uncertainty. A new explicit
request can use the current posture; none of these outcomes authorizes automatic
replay.

Controlled regressions exercise the named asynchronous paths and a synchronous
admission callback between invocation accounting and adapter entry. They verify
refusal, no stale provider effect and a successful new Ask request. This is not
an all-writer, live-provider or cross-process atomicity claim. Prepared-intent
resume retains its separate binding, options and currentness checks; the
historical surface map above is not a complete audit of every caller.

### 4.3 The Default pick (#2409)

A Default pick records `connection-default`. At a start or turn it resolves in
this order:

1. **The Agent's default, then this Station's default.** The Station default
   is read per call through `resolveStationDefaultApprovalMode`, wired like
   `resolveStationDefaultWorkspaceIsolation`.
2. **Else `ask`,** if Station has put a concrete posture on this live thread.
   A posture the engine refused does not count: an OpenCode governance
   refusal leaves the engine on what it ran before (#3290).
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
  session spawned without bypass is refused by the adapter. A `host` start
  given a concrete mode is spawned with the grant, so this refusal is left to
  sessions spawned before that, sessions started on the engine's own
  settings or in plan mode, and Stations running as root outside a sandbox.
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
- **Ollama, Bedrock, Muse and the Station agent** have no approval knob.
  The command refuses, a carried pick is not recorded, and a recorded posture
  is not sent after handoff to such an engine.
- **ACP support depends on the connection.** Station applies posture when
  `acpApprovalControl` is `station`; otherwise the command refuses and posture
  is not applied. ACP session `mode` remains a separate control. OpenCode may
  refuse a requested posture when its resolved governance rules prevent
  Station from applying it; see the [Session API](../reference/session-api.md).

### 4.6 Offline and early picks, and compare-and-set (MEDIUM-1)

- **Online, with a session.** The pick handler sends `setApprovalMode` at once.
  Until the result arrives the pick is held as `queuedApprovalMode`.
- **Offline, a failed command, or no session yet.** The pick stays queued, and
  the queue is persisted. The next composer send, offline replay or drain
  carries it.
- **Compare-and-set.** Every pick names the latest decision sequence the chat
  had folded when the user picked. `null` means it had folded none.
  - **Only a looser pick is held to its basis** (orchestrator decision,
    2026-09-23). Strictness is ask < auto < never. A pick at least as strict
    as the decision that stands is always recorded. It can never leave the
    engine more permissive than the decision it replaces, so a second
    device's Ask on a full-access session is never refused for not having
    seen that session's history.
  - A looser pick is recorded only if no newer decision exists for the
    conversation. Otherwise the server drops it and returns the standing
    decision.
  - **A Default is ranked by nothing, on either side.** What a Default
    resolves to (§4.3) depends on the Agent and Station defaults, which can
    be edited after the pick is recorded, so a ranking made at record time
    can go stale: a stale Default recorded because it resolved to Ask would
    resolve to full access once the Agent default was raised. So a Default
    pick is always held to its basis, and a concrete pick over a standing
    Default is too, except Ask, which is at least as strict as any posture.
    The "stricter needs no basis" rule applies only to concrete Ask and
    Auto (Auto over a concrete `auto` or `never`).
  - The client folds that decision, clears the queue, and adds a one-line
    note: "Your approval pick was not applied: another device had already set
    it to …".
  - **The basis is required** (nullable, never optional) on `/commands` and
    on every carried pick (`setApprovalModeBasedOn` on `/chat`,
    `/chat/delegated`, `/chat/background`, the continue and the handoff). A
    pick without one is refused with 400 rather than recorded
    unconditionally, so a client bug cannot skip compare-and-set silently.
    The SDK's `ApprovalPickCarry` makes the pick and its basis one value, so
    a caller cannot send one without the other. The web client's send path
    (`dispatchForeground`) and the foreground executor also refuse a pick
    with no basis.
  - The check and the append are one synchronous step.
- **What this closes.**
  - **G-off.** An offline full access that never saw the phone's later Ask is
    dropped.
  - **The duplicate-carry race.** The command and a send that carry the same
    queued pick can both be recorded, since the second is as strict as the
    first. The posture does not move. Two looser picks on one stale basis
    record once.
  - **The spawn window.** A carried pick is recorded before its session
    starts.

### 4.7 The client fold and the chip

- **Chat state.** A chat keeps these fields:
  - `approvalPosture` and `approvalPostureSequence`;
  - `queuedApprovalMode`;
  - `lastAppliedApprovalMode`;
  - `approvalEscalationRejected`.
- **The applied report survives a reload (#4433).** `lastAppliedApprovalMode`
  is folded live from `session.configured` and `turn.started` metadata. The
  session summary also carries it as `appliedApprovalMode`, the newest such
  report, and a snapshot fills the chat from it when the chat holds no newer
  report and no failed takeover. A reloaded or resynced chat therefore shows
  the mode the engine reported, not the inherited Default.
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
  Later addition (#4518): under a managed approval ceiling below full access,
  nobody holds it, the operator included. A `never` carried on a request's
  options (`approvalMode`, the default channel) is then lowered to the
  ceiling instead of refused; a known ACP full-access `mode` is still
  refused, because nothing lowers it.
  Since 2026-11-02 the operator in person includes one of the owner's own
  devices holding [owner-device standing](../security/remote-access-threat-model.md#owner-device-standing-2026-11-02);
  its grant still names that device as grantor.
  - The scope is in no preset and never in the default grant, like
    `engine:login` and #2412's `coding:exec`.
  - The operator grants it once per device: when approving a pairing
    request that asked for it (the Station app asks for it; only the operator
    credential, the desktop's local grant, the host browser session, an
    operator passkey session after exact per-action review, or one of the
    owner's own devices with owner-device standing may keep it, and **Limit access**
    leaves it out), in the device access editor (**Paired devices** → the
    device → **Change access** → "Skip approval prompts"), or on the Station
    host with `station environment access scope <device> --add
    approval:full-access` (#1796).
- **One derivation.** The check is `mayGrantFullAccess` in
  `src-server/security/coding-authority.ts`, next to #2412's
  `mayRunCommandsOnHost`. It shares the same `isOperatorInPerson`.
- **Never an agent.** An agent's station-control tools call the REST API
  with the per-boot internal token, which the auth boundary binds as
  Station's own internal principal with home-possession, so it read as the
  operator in person: `update_config` could set the Station default to
  `never`. `mayGrantFullAccess` now refuses any request carrying the tool's
  origin marker or caller credential (`isAgentOriginatedRequest`). Those may
  only restrict: their absence proves nothing, so the rule refuses more and
  never grants more. `update_config` also refuses a `never` default itself.
  - The same rule applies to #2412's `mayRunCommandsOnHost` (the Project
    folder gate and `POST /exec`). No station-control tool reaches either
    today, so it closes no live path; it keeps the derivation's claim (the
    operator in person, or a granted device) true for an agent-marked
    request, so a future tool cannot inherit operator authority by
    construction. An agent already has its own engine shell under its own
    approval posture.
  - `isOperatorInPerson` itself is unchanged. Its one other use is the New
    Project form's read-only folder listing.
- **Where it is enforced.** `routes/orchestration/approval-authority.ts`
  enforces it on every route that can put a session at full access:
  - `/commands` `setApprovalMode`;
  - `/chat`, `/chat/delegated` and `/chat/background` (a carried pick, or
    `target.model.options.approvalMode`);
  - `/chat/:id/continue`;
  - the conversation handoff;
  - `/delegations`, and a delegation continue;
  - Task dispatch and Starter Work's `start-task` launch
    (`runtimeConfig.modelOptions`); see below.
  - `PUT /config/app`, raising `defaultApprovalMode` to `never`. The Station
    default reaches every session start (§4.2), so it needs the same grant.
    Resending a `never` that already stands is not gated, because Settings
    round-trips the whole config.
- **Task dispatch is enforced in the dispatcher, not only at routes.** A
  review found `POST /api/starter-work/launch` passed
  `dispatch.runtimeConfig` to `TaskDispatcher.dispatch` with no gate.
  - Two options were weighed: enforce at the dispatcher, or gate every route
    plus a source-invariant test that fails when a new route calls `dispatch`
    with a `runtimeConfig` and no gate. The dispatcher was chosen because it
    CAN carry the caller's authority, and a rule in the seam covers present
    and future callers by construction. A text scan can only notice a new
    caller written in the shape it expects.
  - `TaskDispatcher.dispatch` refuses a full-access `runtimeConfig` unless the
    intent carries a `FullAccessGrant` (outcome `forbidden`), before anything
    is reserved.
  - The grant is a required field (`FullAccessGrant | null`), so every caller
    states its authority where it calls, and the compiler rejects one that
    forgets. It is an instance of a class private to `coding-authority.ts`,
    minted only by `fullAccessGrantFor` from a request's own authority
    (`mayGrantFullAccess`); the dispatcher checks it with `instanceof`
    (`isFullAccessGrant`), so a cast look-alike is refused. Tests obtain one
    from `fullAccessGrantForTesting`, which throws outside the test runner. Unattended callers (the
    external monitor, the board intent, e2e control) pass `null`.
  - The tasks and starter routes keep an early 403 from the same derivation,
    so a refused Starter launch leaves no Task behind.
- **The refusal.** It is 403 with `approval-full-access-not-granted`, decided
  before the send or the command has any effect. Since #1796 it is
  actionable without being weakened: `details` carries what was requested
  (`never`), the requester derived from the request's own verified
  credential (`device` with short id and display name, `agent`, or `person`),
  the refusing Station's environment id, and the operator's grant path
  (`grant.cli`, the exact host command
  `station environment access scope <short-id> --add approval:full-access`,
  run through the published package for the Station's channel, such as
  `npx @kontourai/station-cli@nightly` for a nightly Station, and `grant.uiSteps`, the desktop app steps through **Paired devices** →
  the device → **Change access**). When the device is tied to a person in
  the Member group (#3557), `grant.groupLimited` is `{ group: 'member' }`,
  `grant.uiSteps` are the People steps (as the operator, Settings → Devices →
  People, set the person to Admin), and there is no top-level `grant.cli`.
  When the device's own grant also lacks the scope, the command travels as
  `grant.groupLimited.cli` and is appended as a last step ("Then, on the
  Station's host, run: …"), so even a client that predates `groupLimited`
  reads it as the step after People, never as an alternative. An Agent's refusal has `grant: null`: no
  scope lets an Agent choose full access. The requester chooses its pairing
  name, so the name is sanitized (control, format and separator characters
  removed, 64 characters at most) and carried only in `details`; the `error`
  prose names the device by its short id alone. Clients render the refusal
  from `details` as plain text (the chat card, the CLI through
  `terminalSafeText`), never the prose as Markdown, and never retry at
  another mode. The wording is in `src-server/security/full-access-refusal.ts`
  and the parser in `@kontourai/station-contracts/orchestration`;
  `mayGrantFullAccess` stays the only derivation. A refused send is not a
  failed chat: the chat returns to idle, the draft to the composer, and the
  only way on is an explicit "Send without full access" at the chat's
  current mode.
- **Granting and revoking.** The grant is a device scope, managed like any
  other on the operator's host channel (`station environment access
  devices|scope|scopes`, over `POST /api/pairing/devices/:id/scope` with
  `expectedScope`). The scope is read per request, so a removal refuses that
  device's next full-access pick or dispatch at once.
- **Revocation resets what the device granted (owner decision, #1796 G3).**
  Removing `approval:full-access`, or revoking the device, runs
  `OrchestrationService.resetFullAccessGrantedBy`. Attribution is exact and
  server-derived. A decision carries its recorder in `clientOrigin.actor`.
  A `host` start stamp carries its grantor in
  `metadata.stationConfinementGrantor`, beside the stamp and carried forward
  on a respawn and an adoption. The grantor comes from the grant itself:
  `fullAccessGrantFor` names the operator in person or the paired device.
  A caller that may grant but is neither gets no grant. So every path that
  carries a grant (chat, delegation, Task dispatch, Starter Work, adoption,
  pane actions) records who granted it. `prepareStart` and adoption refuse a
  grant that names no grantor (`UnattributedFullAccessGrantError`). No
  legitimate actor-less grant exists: every grant is minted from a request.
  The start's command receipt also records `clientOrigin`, and Task dispatch
  and Starter Work carry the request's server-derived origin to it.
  - Behaviour change: a caller that may grant full access but is neither
    the operator in person nor a paired device (for example an account
    session holding the scope) gets no grant at session start. Its new
    sessions start `workspace`, unless a recorded `never` decision makes them
    `host`; that decision's `clientOrigin.actor` is `unknown`, not a device,
    so no device's revocation resets it.
  - A conversation gets a new Ask decision when its standing decision is one
    of that device's: its `never`, its Default that still resolves to
    unconfined `never`, or its Auto on a session its grant unconfined. So
    does a conversation with no standing decision whose `host` session that
    device started, unless that session's `never` comes from the Agent's or
    Station's default.
  - Re-confinement: the applied start stamp reads the grant live
    (`isFullAccessGrantorCurrent`, backed by the pairing registry). A `host`
    stamp whose device grantor no longer holds `approval:full-access` applies
    as `workspace` at every turn start and respawn. The respawn then
    re-stamps it `workspace`. Both adapters take confinement per turn, but
    Claude only changes its permission mode when a mode is sent. A standing
    decision sends one on every turn; with none standing, the confinement
    change itself does (§4.2, #2898). So every session is re-confined from
    its next turn, without restarting its engine, and from its next start
    when its engine is not running. Codex already moved its sandbox per turn
    (`planCodexTurnSandbox`), so it needs no respawn either.
  - Until that next turn a running engine keeps its posture, and a turn
    already running finishes in it. That turn cannot be extended: a
    `steerTurn` into a turn accepted under a confinement that no longer
    holds is refused with `confinement-changed`, and the clients keep the
    message for the next turn (`steerRefusalMessage`). Station records the
    confinement of each engine's last accepted turn
    (`acceptedTurnConfinement`); an engine whose last turn ran under a
    confinement that no longer holds is listed as `stillUnconfined`
    (`next-turn`), one entry per such session, named by that session. A
    conversation with no such engine (none running, or each already
    re-confined by a turn) is listed as `reconfined`. Stations from before
    #2898 answered `engine-restart` for a running engine with no decision
    standing; clients still read it.
  - Version skew (accepted): a connect build from before #2898 drops
    `next-turn` entries, and running sessions with a decision standing are
    no longer in `reconfined`, so such a client under-lists them. A UI from
    before #2898 does not know the `confinement-changed` steer outcome: its
    `steerRefusalMessage` default returns the result object, which may be
    rendered as the message content. From #2898 on, that default returns a
    plain sentence for any unknown outcome.
  - Only a narrowing refuses a steer: a turn accepted under `host` while
    `workspace` applies now. A widening (a recorded `never`, a grant given
    back) leaves the turn steerable.
  - Known residual (accepted): answers to the engine's own questions and
    approval requests still reach the running unconfined turn. They are not
    a steer and are out of scope; Stop now ends the turn when that matters.
  - **Stop now.** The revocation notice in the paired-devices panels offers
    "Stop now" on each `next-turn` entry. It sends the ordinary
    `stopSession` command for that session, with the credential the
    revocation used. The engine stops at once, and the session's next start
    is confined. The CLI prints the entries without a stop action.
  - Re-granting the scope lets the stamp apply again, but the recorded Ask
    still stands. A session re-confined with no decision standing stays at
    its confined mode until its engine restarts; nothing loosens it
    mid-run.
  - The Ask carries `revocation: { reason, deviceId, cause }` and the
    operator's `clientOrigin`. History is kept.
  - A running turn is not touched unless the operator stops it. The next
    turn start or respawn applies the decision, which wins over a start's
    carried mode.
  - Left alone and listed: a standing decision by the operator or another
    device; a default-only `never`; a `never` decision with no recorded
    actor; and live `host` sessions with no recorded grantor (at most 50,
    with the total).
  - The route answer carries the report (`fullAccessRevocation`). Each entry
    names the conversation, its title and a session to open it by. Clients
    pass a title through `sanitizeUntrustedDisplayText` (control, format,
    bidi and zero-width characters removed, 256 at most) before showing it. A failed
    reset is `fullAccessRevocationError`, and the CLI treats it as an error.
    The reset is idempotent and can be re-run.
    `station environment access scope <device> --remove approval:full-access`
    on a device that no longer holds it sends `resetFullAccess: true`, and the
    route runs the reset again. `DELETE` on a revoked device does the same.
- **Who can reach a session at all.** Command authorization
  (`canReadSessionForCommand`) admits only the session owner's own
  principals. There is no multi-user shared session to decide for.
- **Later addition (#2915, owner decision 2026-09-28).** A Claude approval
  answered "Auto-accept file edits for this session" is also a posture
  decision, recorded only for a caller holding `setApprovalMode` authority:
  an answer sent through `POST /api/orchestration/commands`, the route and
  session authorization an Auto pick needs. Once the engine has taken the
  answer, the service records an `auto` `session.approval-mode-set` for the
  conversation, based on the decision that stood before the answer was sent.
  If any decision was recorded after the answer was sent, that decision stands
  and nothing is recorded. The compare-and-set alone would admit Auto over a
  newer `never`, so the service also checks that the standing decision is
  unchanged. It is not recorded over a standing Auto or `never`. On the
  delegated `respond_to_task_request` path for a task on this Station (a
  bound Project approver) and the approval inbox, the answer is sent as a
  one-call `accept` and nothing is recorded, so no engine is left in
  acceptEdits with no decision to undo it. A delegated answer for a task on
  a saved Environment reaches that Station's command route with this
  Station's enrolled credential and is judged there by the same rule.

### 4.9 An Agent's default posture (owner request)

- **Field.** `AgentSpec.execution.approvalMode`. It sits under `execution`
  next to `credentialProfileRef`. Like that field, it is a per-Agent engine
  execution setting, read by the server where the engine session starts, and
  meaningful only on an engine with an approval knob.
- **Precedence at a session start:** the recorded decision, then the Agent's
  default, then the Station's. A Default pick returns to the Agent's default.
  A member can tighten below it at any time.
- **A Default pick needs no grant, even where it resolves to full access
  (owner decision, 2026-09-23, fork 1).** A member without
  `approval:full-access` who picks Default on a chat whose Agent (or Station)
  default is `never` gets full access. That is intended: the owner explicitly
  wants members to get an Agent's full-access default. The authority was
  exercised once, where the default was set (§4.8 on the Agent write, the
  settings route for the Station default), not at each pick.
  - Since #2493, a session a member starts without the grant is confined,
    so that `never` runs inside the workspace (Codex's sandbox, or `auto` on
    Claude).
  - #2377 slice C1 gates the one case where it would not. A decision
    governs every session of its conversation. A Default pick needs the §4.8
    grant when any of those sessions is `host`-stamped and the Default
    resolves to `never` for its Agent (its own default, then the
    Station's). Such a session would run the engine at `never` unconfined.
  - The check covers every path that records a pick: `/commands`, and a
    pick carried on `/chat`, `/chat/:id/continue` or a handoff. On a handoff
    it checks the conversation's existing sessions. The successor has no
    stamp yet when the pick is checked. The decision is
    `ApprovalPosture.pickReachesFullAccess`.
  - A session added to the conversation later, for example by a handoff,
    starts in its starter's own confinement. A recorded Default is not a
    recorded `never`, so the successor gains no `host` from it.
- **Write authority.** Saving `never` needs the same authority as §4.8.
  - Every Agent write from outside the server goes through `POST /agents` or
    `PUT /agents/:slug`: the editor, the SDK and CLI, and the Station-control
    MCP tools, whose schema does not accept `execution` at all.
  - Only raising the Agent's effective default to `never` is gated: its own
    default, else the Station's. Clearing an Agent's own default over a
    Station default of `never` raises it too (#2377 slice C1), and so does
    creating an Agent with no default there. An edit that leaves an
    effective `never` as it is (a client resending the whole `execution`
    block) is not gated.
  - Agents have no per-member edit rights. Any operate caller may edit any
    Agent, global or Project-scoped, so the gate is by device authority, not
    by Project membership.
- **Display.** The chip shows the Agent's default. The Agent editor's Engine
  section has the "Default approval mode" field, and it names what full access
  means.
- **Schema.** `schemas/agent.schema.json` admits `execution.approvalMode`.
  Before this change its closed `execution` object rejected the field, so a
  saved default made the Agent unloadable.
- **Plugin-contributed Agents: provenance (owner decision).** Who set the
  default decides whether full access is honoured.
  - **The plugin's own value** lives in its `agent.json`. A `never` there is
    never applied, because a plugin is installed at the ordinary operate
    tier. Its stricter values (Ask, Auto) apply.
  - **The operator's value** is honoured, `never` included. It is set
    through the Agent editor or API by a caller who passed the full-access
    gate (§4.8), and it is recorded outside the plugin's directory in
    `<home>/agent-approval-overrides.json` as
    `{ "<slug>": { "plugin", "approvalMode" } }`.
  - **Why a separate Station-owned file** rather than a marker beside the
    field: installs and updates copy the plugin's whole Agent directory. A
    marker in that directory could be shipped (forged) by the plugin, and it
    would be erased by the next update. The home root is written by no plugin
    install or update. Only `AgentService.updateAgent` writes it, behind the
    gated route.
  - **Plugin update or reinstall.** The update replaces `agent.json` with the
    new copy. The operator's entry is untouched and keeps winning, whatever
    the new copy declares. It is not silently overwritten.
  - **The entry is tied to the plugin it was set for.** It is honoured only
    while that same plugin still owns the slug. A different plugin later
    contributing the same slug does not inherit it. Uninstalling leaves the
    entry, and reinstalling the same plugin restores it.
  - **Only a change is a choice.** An unrelated save resends the value the
    editor showed and records nothing, so plugin updates can still move the
    default. Choosing "Use this Station's default" over a plugin's declared
    value records an explicit "no default".
  - **Writers never copy the effective value into the plugin's file.**
    Readers see the effective value (`loadAgentConfig`,
    `capturePluginAgentInvocation`, and the save response). Writers merge
    onto the file as stored.
  - **Workspace Pane actions.** Their admission captures the plugin Agent
    with its effective default, and the start consumes that captured value
    without rereading.
- **A failed read fails the start.** If the Agent's execution config cannot be
  read, the start fails, exactly as the credential-profile pin read beside it
  does. An unreadable default is not the same as no default.

### 4.10 Confinement providers (#2494)

The `host | workspace` stamp above records the starter's grant. It names no
mechanism and observes nothing. #2494 adds the provider contract and a
derived record beside it. Domain shapes are in
`@kontourai/station-contracts/execution-confinement`; resolution and the
provider interface are in
[confinement-provider.ts](../../src-server/security/confinement/confinement-provider.ts).

- **Levels:** `host`, `os-profile`, `container`, `microvm`, weakest first.
- **Posture:** `confined`, `no-mechanism` or `configured-but-failed`. A
  posture is what the started engine reported applying, never the
  configuration Station sent. It is the engine's report, not a kernel
  observation.
- **Workspace access:** `mounted` runs against the live checkout. `copied`
  has its own filesystem. Resolution refuses a provider that cannot run the
  start's `WorkspaceIsolationMode`, and a copied provider never pairs with
  `shared`, whatever it declares (`confinement_workspace_incompatible`). The
  mode comes from the server-resolved workspace binding: a canonically
  provisioned or verified owned worktree is `worktree`, everything else
  (including a respawn, an adoption, and any caller-written
  `metadata.workspaceIsolation`) is `shared`. That can refuse a real worktree
  session a worktree-only provider; it never grants one on the caller's say-so.
- **Scope in time:** the record describes the session START. A per-turn
  sandbox re-tightening (#2559) and a revoked full-access grant (#1796) do
  not update it until the session's next start writes a new one.

**Providers.** A provider declares its level, mechanism, workspace access,
supported isolation modes and engines, and reports its availability on this
host with a reason. It is handed a spawn spec (command, args, cwd, env,
writable and readable grants, network policy) and returns a confined spawn
plus a pending posture, which it settles from what the started process
reports. An `engine-native` provider leaves the spawn unchanged because the
engine applies it from protocol settings. A `spawn-wrapper` provider rewrites
the spawn, and resolves only for the engines it names: their adapter is the
start path that applies it. A spawn wrapper naming no engine is refused rather
than resolved and silently left unconfined. Station's Seatbelt profile (below)
is the first production caller of `confine()` and `pending.observe`; the Codex
adapter still calls its own derivation (`observeCodexSandboxPosture`)
directly.

**The required level (owner decisions of 2026-09-24 and 2026-10-18).** A
`workspace` start whose engine actually runs at `never` requires
`os-profile`. "Actually" means the mode after `ApprovalPosture.resolve`.
Codex and Claude keep `never` there; ACP has no mechanism, so its `workspace`
`never` is still applied as `auto` and requires nothing (its file and
terminal requests run inside Station's own process, so wrapping the engine
could not confine them). Every other start requires `host`.
The record's `policyBasis` is `operator-policy` for a `host` start and
`workspace-floor` for every other start. For Codex the requirement also
follows the approval policy Codex reports in its thread response: a
`workspace` session Codex reports at `never` (from its own configuration,
when Station sent no knobs) is required too. So that such a session still runs,
a `workspace` Codex start, resume or adoption fork that Station sends no mode to
asks Codex for `sandbox: workspace-write` at thread level and leaves
`approvalPolicy` unset, so Codex's own configuration keeps governing approvals.
An operator configuration of `approval_policy = "never"` and
`sandbox_mode = "danger-full-access"` therefore runs confined from the start
(on `main` it ran unconfined until each turn pulled it back to workspace-write).
It is refused only when Codex still reports something wider than the
workspace-write Station asked for.

**Resolution and refusal.** `prepareStart` resolves the confinement beside
the stamp. It runs after the reserved-key strip and after the start's final
model options are known. A respawn and a credential-profile restart
(`withApprovalPostureForStart`) and an adoption resolve it the same way. A
required level with no usable mechanism refuses the start before the engine is
touched (`confinement_mechanism_unavailable`), and the refusal names the
mechanism the host would need: Seatbelt on macOS, bubblewrap on Linux. An unrequired start still engages an engine-native mechanism, so the
record says what the engine reported running under. Every confinement refusal
is a `SessionStartRefusedError`: the start boundary settles it, the command
receipt is `rejected`, the closed code reaches the caller (also through a
respawn on `sendTurn`), and the thread's next start is admitted rather than
fenced as indeterminate.

**Recording.** The record goes on `session.started` metadata as
`stationConfinementRecord`. It holds the level, whether it was required, the
posture, the mechanism, workspace access and policy basis. The key is reserved,
so a caller's value is stripped. When no mechanism is engaged, the start path
writes `host` / `no-mechanism`. Otherwise the adapter gets a server-only
`confinementPlan` and writes the record from what its engine reported. A
caller-supplied plan is stripped in `prepareStart` and in
`withApprovalPostureForStart`. A respawn re-resolves it. The previous record is
stripped with the other reserved keys on the stored-metadata read, and is never
carried forward as the new process's.
Recovery replay sends a turn, not a start, so it records nothing new.

**Codex's own sandbox** is the first provider
([codex-confinement.ts](../../src-server/providers/adapters/codex-confinement.ts)).
Its posture comes from the `sandbox` and `activePermissionProfile` of Codex's
`thread/start`, `thread/resume` or `thread/fork` response:

- `readOnly` is `confined`. `workspaceWrite` is `confined` only when every
  extra writable root it lists lies inside the resolved workspace,
  Station's shared engine temp directory, or the session's own temp directory
  when the `chat-host-images` preview gave it one. A root such as `/`, the home directory
  or another checkout makes it `configured-but-failed`. Codex's implicit
  roots (the cwd, `TMPDIR` and `/tmp`, governed by its exclude flags) are part
  of what `workspaceWrite` means and are accepted. Network access is not
  judged. Paths are compared lexically; symlinks are not resolved. A session
  that is not `host` and sent no sandbox mode (it relies on Station's
  permission profile, below) is `confined` only when Codex also reports
  `activePermissionProfile.id` `station-workspace`. Without it (a Codex
  without permission profiles, or one whose configuration replaced it) it is
  `configured-but-failed`, and a required start is refused with a reason that
  names the profile.
  - **Intended fail-closed change:** a required `workspace` `never` session
    on a host whose operator configured extra Codex `writable_roots` outside
    the workspace (for example `~/.cargo`) is refused. The refusal lists
    those roots and says how to fix it: remove them from Codex's
    `sandbox_workspace_write.writable_roots`, or run the session as the
    operator (a `host` session).
- `dangerFullAccess`, an `externalSandbox`, or no report is not confined. It is
  `configured-but-failed` when Station asked for a sandbox, else
  `no-mechanism`, which names no mechanism and no level above `host`: the
  record says what was requested and reported, never a mechanism nothing
  engaged. A `host` session at full access is therefore `host` /
  `no-mechanism`, recorded as policy.
- **Workspace configuration cannot widen it (#3800).** Codex merges every
  `.codex/config.toml` from the project root down to the cwd over the user's
  configuration. Station starts sessions in subdirectories, so a file a
  confined session wrote (`sub/.codex/config.toml`) configured every later
  session started in `sub`: its `writable_roots` widened the sandbox and its
  `mcp_servers` commands ran outside it at thread start. Every session not
  started as `host` therefore spawns `codex app-server`, after the
  connection's own arguments, with:
  - `-c default_permissions="station-workspace"` and a
    `permissions.station-workspace` profile that extends Codex's `:workspace`
    (the workspace roots and temp writable, the `.codex` at a root read-only)
    and denies `**/.codex`, `**/.codex/**`, `**/.claude` and `**/.claude/**`
    under every workspace root. Codex accepts only `deny` for a glob, so the
    agent cannot read these directories either; Codex's own configuration
    loading runs outside the sandbox and is unaffected. The subtree patterns
    are needed: the bare directory pattern refuses creating a `.codex` but
    not writing inside a checked-in one. The profile also restates
    `".git" = "read"` and `".agents" = "read"`: `:workspace` keeps a root's
    `.git` and `.agents` read-only, but a profile with its own
    `:workspace_roots` entries loses that (EXECUTED, codex-cli 0.162.1:
    `.git/hooks`, `refs/remotes` and `packed-refs` became writable).
  - `-c sandbox_workspace_write.writable_roots=[]`, for a thread not under
    the profile (a `read-only` review start, or a Codex that does not apply
    it), whose tightening restores the reported workspace baseline.
  - `-c approvals_reviewer="user"`: with `auto_review` a model, not a person,
    would approve a sandbox escalation.

  A `-c` override outranks every file layer and applies to every
  configuration load of that process (start, resume, fork): a user or
  project `sandbox_mode = "danger-full-access"` or
  `default_permissions = ":danger-full-access"` still reports the profile.
  A thread-level `sandbox` mode or a turn-level `sandboxPolicy` replaces the
  profile for that and every later turn, so Station sends neither for
  `workspace-write` outside `host` (`codexThreadSandboxRequest`,
  `planCodexTurnSandbox`). `read-only` (review isolation) is still sent: it is
  narrower. Marking the project untrusted would ignore the whole project
  layer, but Codex then also drops the workspace's `AGENTS.md` and changes
  its default approval policy, so it is not used. Verified against
  codex-cli 0.162.1 on macOS with live turns: nested and deeper `.codex`
  writes, a rename or symlink into `.codex`, writes inside a checked-in
  nested `.codex`, and a nested `.claude` are refused; project and temp
  writes are allowed; `AGENTS.md` loads; the approval policy is the one sent.
  - **Network.** The profile ignores the legacy
    `sandbox_workspace_write.network_access`; Station does not set network.
    An operator gives a confined session network with
    `[permissions.station-workspace.network] enabled = true` in their own
    Codex configuration (tables merge across layers).
  - **Planted through temp: refused at start.** The deny rules cover the
    workspace roots only; Codex refuses glob rules under `/tmp` and
    `TMPDIR`, which stay writable, and moving an ancestor of a `.codex` is
    not a write to it. An agent can therefore build
    `$TMPDIR/x/pkg/.codex/config.toml` and move `pkg` into its workspace,
    and a later session started in `pkg` would run its `mcp_servers` command
    outside the sandbox (EXECUTED, codex-cli 0.162.1). Before spawning Codex
    for any session not started as `host` (start, resume, fork, adoption and
    respawn all pass through `startReservedSession`), Station checks every
    directory from the trusted repository's root down to the cwd, on the
    lexical and the resolved path
    ([codex-project-config-provenance.ts](../../src-server/providers/adapters/codex-project-config-provenance.ts)).
    A `.codex` there must be a real directory whose every file is a regular
    file whose bytes are the blob at the same path in one remote-tracking
    ref (`refs/remotes/*`) of the trusted repository: content that came
    from upstream.
    - **The anchor is server-authorized.** The orchestration service stamps
      `confinementRoot` into the start metadata (replacing any caller value,
      and carried to respawns with the stored metadata;
      `sessionConfinementRoot`): the named Project's directory when it
      contains the cwd; else the deepest configured Project directory that
      does (a station-control `send_message` to a plain folder inside the
      Project names no Project, and an agent may have planted a repository
      at that folder); else the server-admitted workspace when the cwd is
      exactly it (a provisioned worktree, or an adopted continuation's
      verified folder); else nothing, for a folder outside every Project.
      Only a session that is not `host` is checked, and such a session is
      never the operator's own, so a folder outside every Project trusts no
      `.codex`. Native adoption stamps the same value. Every comparison is
      canonical (`realpathSync.native`: symlinks resolved, on-disk case) and
      the root is stamped canonical: an adopted place is canonical, so a
      Project configured through a symlink or in another case would
      otherwise never match it and leave the place as its own root. The
      check maps the canonical root back onto a cwd reached through a link.
      The trusted repository is the innermost one containing the canonical
      root; a repository that exists only on the lexical path (an
      agent-built one holding a link into the Project) trusts nothing, and
      its `.codex` is refused. Anything found
      from the cwd is no anchor: an agent can build a whole repository,
      commit and remote-tracking ref included, in temp and move it in
      (EXECUTED in review). Below the root, a repository is trusted only as
      a linked worktree the trusted one registered; a root in no repository
      trusts no `.codex`. A start without the stamp (recorded before it, or a
      direct adapter call) supplies no trusted root and trusts no project
      `.codex` configuration. Codex's own subagents
      run in the parent's process and cwd (`thread/started` reports the
      parent cwd in the captured 0.155.1 collab traffic), so the start check
      covers them. Otherwise the start is refused with
    `confinement_workspace_incompatible`, naming the directory and saying to
    commit and push `.codex` to its upstream or run as `host`, whether or
    not the session requires confinement, since the command would run
    unconfined either way.
    - **Why upstream, not `HEAD`.** Local commits are no anchor: a confined
      Claude session holds Seatbelt grants for the object store and its own
      branch ref, so it can commit `sub/pkg/.codex/config.toml` with git
      plumbing while a confined Codex session stages the same bytes through
      temp (EXECUTED in review, in a linked worktree and in a main
      checkout). Neither engine can write the remote-tracking refs: Seatbelt
      denies `refs/remotes` and `packed-refs` where `.git` is inside the
      workspace (a linked worktree never had them), and Station's Codex
      profile keeps a root's `.git` read-only. The objects those refs name
      are writable, so every commit and tree on the path is read with
      `cat-file --batch` (replace objects off) and re-hashed against its id:
      a forged loose object under an upstream id is refused. A repository
      with no remote-tracking refs, using the reftable backend, or no
      repository at all trusts no `.codex`.
    - An uncommitted or local-only `.codex` at the repository root is refused
      too. Push it, or run the session as `host`. The user's `~/.codex` and
      `CODEX_HOME` are user configuration and are skipped.
    - A `.codex` known only to a nested repository (including a submodule)
      below the root is refused: only the trusted repository's refs count.
      The exception is a linked
      worktree the outermost repository registered (for example a
      gitignored `.worktrees/lane`): its gitfile names
      `<common dir>/worktrees/<name>`, whose `gitdir` points back at it, so
      its paths are judged from its own root against the same shared refs.
      A staged repository with its own `.git`, or a gitfile borrowing
      another worktree's entry, is not one.
    - A start without a cwd checks the server's own directory, where Codex
      then runs.
    - A Project inside another repository (a home-directory dotfiles
      repository, say) anchors to its own, innermost repository.
    - Content that reaches the upstream (an agent that can push, then an
      operator fetch) is trusted like any other upstream content.
  - **Checked-in configuration is still honoured.** A committed `.codex`, at
    any depth, is repository content with the same trust as the top-level
    one: its `mcp_servers` still run, and its keys merge into the profile. A
    writable root it adds outside the workspace still shows in
    `writableRoots` and is refused above. A checked-in root `.codex` can also
    grant writes inside the workspace that `:workspace` keeps read-only, such
    as `.git/hooks`; that is accepted as trusted repository content. What
    Station closes is the agent planting or changing one.
  - **Residual: Linux.** Outside macOS, Codex expands a deny glob from a
    snapshot of existing paths before the sandbox starts. A `.codex` the
    agent creates later is not denied there, so the nested-write path stays
    open on Linux (EXECUTED, codex-cli 0.160.0 with bubblewrap: creating
    `sub/.codex/config.toml` was allowed; writing an existing checked-in
    file was refused). The live probe runs only on macOS and warns
    elsewhere.
  - Every other project key from a checked-in file still applies, including
    network access, which Station does not judge and the posture does not
    record (unchanged from before; Seatbelt leaves the network open too,
    unless a [restricted network](#restricted-network-4769) applies, which
    refuses a required Codex start). The Seatbelt profile denies every `.codex` (below),
    so a confined Claude session cannot plant one either.
- A required start that is not reported `confined` is refused
  (`confinement_not_observed`). The refusal runs before `session.started` is
  published (the `SessionStartRefusedError` contract depends on that), and the
  process is stopped.
- Codex labels the response `sandbox` field legacy in favour of
  `activePermissionProfile`. Station reads both: the profile says Station's
  deny rules are in force, the legacy shape says how wide the writable roots
  are.

**The receipt.** `ExecutionResolutionReceipt` is built before the session
exists, so it cannot carry the engine's reported posture. Its `confinement`
field is filled where the delegation handle returns after the start. It is
read back from the started session's latest `session.started` record, the same
way `preparation` is added there. It is absent on the foreground chat handle,
on a delegation whose record was not stored or readable when the handle
returned, and for a start that recorded nothing.

**Station's Seatbelt profile for Claude** (#2494 slice 2,
[seatbelt.ts](../../src-server/security/confinement/seatbelt.ts),
[claude-seatbelt.ts](../../src-server/providers/adapters/claude-seatbelt.ts)).
A `spawn-wrapper` `os-profile` provider for Claude only. Mechanism `seatbelt`.

- **Where it applies.** A `workspace` Claude start at `never` requires it.
  `ApprovalPosture` passes that `never` through at a start; the start resolves
  the Seatbelt plan, or refuses where it cannot exist. On Windows, or a
  macOS without a working `/usr/bin/sandbox-exec`, the start is refused
  (`confinement_mechanism_unavailable`), naming the mechanism. On Linux the
  start resolves Station's bubblewrap sandbox instead (below). Availability
  runs the production profile around `/usr/bin/true` once per process.
  `workspace` Claude starts at other modes and `host` starts are unchanged.
- **The spawn.** The adapter's engine spawn
  ([claude-code-spawn.ts](../../src-server/providers/adapters/claude-code-spawn.ts))
  passes each launch to the provider's `confine`, and spawns exactly what it
  returns: `sandbox-exec -p <profile> <claude> …`. The configuration and temp
  directories are Station-owned, and `CLAUDE_SECURESTORAGE_CONFIG_DIR` is
  dropped. The engine spawns at Auto (`acceptEdits`), with the
  `allowDangerouslySkipPermissions` grant the SDK only takes at spawn.
- **The environment.** An allowlist, not Station's whole environment: paths,
  locale, terminal, TLS trust and proxy variables, and `CLAUDE_*`,
  `ANTHROPIC_*`, `MCP_*` and `DISABLE_*` settings (which carry the confined
  credential). Variables the operator configured for this engine (the
  connection's `env`, the app-home layer) pass as configured. Everything
  else stays out, among them `GH_TOKEN`, `NPM_TOKEN`, cloud keys and
  `SSH_AUTH_SOCK`, so a confined session cannot push with the operator's SSH
  agent. The git author and committer identity and `EDITOR`/`VISUAL` pass.
  Toolchain variables (`NVM_DIR`, `JAVA_HOME`, `GOPATH`, …) are dropped unless
  the connection's `env` sets them.
- **The posture.** It comes from the provider's `pending.observe` after the
  engine answers its `initialize` handshake. It is `confined` only when the
  spawn seam recorded `sandbox-exec` with exactly this profile and command,
  the handshake was answered over that process's stdout (`sandbox-exec` execs
  the engine only after the profile applied), and the grants are in bounds.
  Only then does the adapter call `setPermissionMode('bypassPermissions')`
  and publish `session.started`; a turn sent before then is refused. If the
  lift itself fails after the posture is observed (the engine exited), the
  start is torn down the same way and refused.
  Anything else (no answer within 60 seconds,
  the engine exited, a different spawn, grants out of bounds) is
  `configured-but-failed`: the engine is stopped and the start is refused
  (`confinement_not_observed`). It never falls back to an unconfined spawn.
- **Turns.** `ApprovalPosture` keeps `never` on a Claude turn only when the
  thread's latest `session.started` record is an observed `confined`
  posture. The adapter refuses full access on a turn to an engine spawned
  without the grant, as before. As defence in depth, a `workspace` start
  (an absent confinement is `workspace`) that reaches the adapter at `never`
  without a Seatbelt plan is applied as Auto, never spawned unconfined at
  full access. A respawn, a
  credential-profile restart and a resume each re-resolve the plan, so they
  are confined and observed again, or fall back to Auto.
- **Profile shape.** On macOS 26 a profile that allows reads only from system
  paths aborts even `/usr/bin/true`, so reads are broad and writes narrow:
  `(deny default)`, then process, file-read, Mach, sysctl, IPC and network
  allowed. Signals reach only processes in the same sandbox. Then:
  - Reads are denied for the operator's secret stores: `~/.ssh`, `~/.aws`,
    `~/.gnupg`, `~/.kube`, `~/.azure`, `~/.config/gh`, `~/.config/gcloud`,
    `~/Library/Keychains`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`,
    `~/.pypirc` and `~/.docker/config.json`. Also denied: `~/.claude.json`,
    `~/.claude/.credentials.json`, `~/.codex/auth.json`, and Station's root
    and runtime home. Station's `installs` stay readable.
  - Writes are allowed to the workspace, a per-session Station temp directory
    (`<home>/tmp/confined-sessions/session-<pid>-*`, also the engine's
    `TMPDIR`), and the Station-owned Claude configuration directory. A
    session removes its temp directory when it stops. At boot and on the
    engine temp sweep's schedule, Station removes a temp directory whose
    owner process is gone, after checking it is a real directory directly in
    that root, owned by this user, and named for that process.
  - For a linked worktree, writes are also allowed to its own git directory,
    the shared `objects`, and exactly its branch's
    `refs/heads/<branch>`, `.lock` and `logs/refs/heads/<branch>`. The git
    layout is read from git's own pointer files (`locateGitDirectories`),
    never by running git.
  - Writes are then denied to whatever git later reads as configuration,
    hooks or a redirect, because the operator's unconfined git runs in the
    same checkout. Always: the repository's `hooks`, `config` and `info`, a
    `commondir`, `objects/info/alternates`, and the worktree's
    `config.worktree`. For a linked worktree, also its `.git` pointer file
    and its git directory's `commondir`, `gitdir`, `config` and `hooks`
    (repointing `commondir` at a directory whose `config` sets
    `core.fsmonitor` would run code in the operator's next git). For a
    checkout whose `.git` is inside the workspace, also `worktrees` and
    `modules` (every other worktree's and submodule's pointers and config),
    and the `.git` directory itself, which cannot be removed, renamed or
    replaced by a pointer file (its contents can be emptied, and its
    `config` and `hooks` survive). Commits, a second commit and status still
    work in both layouts; a checkout with `.git` inside the workspace can
    also stash and switch branches. A linked worktree cannot stash, fetch or
    pull, by design: those write shared refs (`refs/stash`, remote-tracking
    refs, `packed-refs`). Since #3800 neither can a checkout whose `.git` is
    inside the workspace fetch or pull, or pack refs: its `refs/remotes` and
    `packed-refs` are denied, because a Codex start trusts a nested `.codex`
    only by remote-tracking refs.
  - Writes are denied to every directory named `.codex` or `.claude`, in
    any case and at any depth, inside every writable grant (#3800): a
    session can start in a subdirectory, and Codex loads each `.codex` from
    the project root down to it. Such a directory cannot be created, written,
    linked, renamed or replaced, including one prepared in the session's
    temp directory. The engine still reads them. Names that only share the
    prefix (`.claude.json`, `.codex-notes`) stay writable.
  - Every path is symlink-resolved before it enters the profile (`/tmp` is
    `/private/tmp`). A path SBPL cannot spell (a quote, a backslash, a
    control character) is refused.
- **Breadth.** The record carries the kinds of the write grants
  (`writeGrants`). A required start whose grants reach past the workspace,
  that git subset, the session's Station temp directory and a directory
  directly under Station's `confined-homes`, or that lacks a deny its git
  layout or the engine configuration needs, is `configured-but-failed`. It is refused before anything is
  spawned.
- **Credentials (owner decision of 2026-10-18).** The confined engine never
  reads the operator's Keychain, and never writes the operator's `~/.claude`.
  It authenticates only with a credential that needs no operator state: a
  non-empty `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in its environment,
  or an OAuth credential file in its Station-owned configuration directory.
  That directory is always under `<home>/confined-homes`, which no
  unconfined spawn uses, so a `settings.json` hook planted there never runs
  in an operator's unconfined session: `confined-homes/claude` by default,
  and a twin named after the app home (`confined-homes/credential-profile-…`)
  for a selected credential profile or the app-home opt-in. It is never the
  operator's `~/.claude`, a connection's `configHome`, or an app home itself.
  A credential for it is an environment credential, or a credential file
  enrolled there for confined use. A credential profile's confined twin
  starts empty, so a login held only in the profile does not reach it, and
  such a session falls back to Auto (`confined-credential-unavailable`). The operator's own login is never copied. Claude rotates its refresh
  token on every refresh, so two holders of one login invalidate each other.
- **Falling back to Auto.** A start whose plan names Seatbelt runs at Auto,
  with nothing engaged, when a check finds one of these, in order:
  - `config-root-pinned`: a source-affinity resume or an adoption, which pin
    the operator's global configuration root (archive#896 decision 2). The
    combination is kept on the downgrade rather than refused.
  - `workspace-too-broad`: the workspace is or contains the home folder or
    Station's data, or sits in a hidden folder or `~/Library`.
  - `confined-credential-unavailable`: no credential, as above.
  - `resume-bound-elsewhere`: a resume recorded under another configuration
    home.

  The record is `host` / `no-mechanism`, not required, with `fallback` naming
  the reason. A `runtime.warning` (`confined_full_access_unavailable`) says
  why and, for a missing credential, names the setup step. Readiness reports
  the same credential check on macOS as the optional
  `claude-confined-credential` prerequisite, without attempting a login. It
  checks `confined-homes/claude`; a selected credential profile's twin is
  not modelled.

  The confinement preflight (#4774,
  [confinement-preflight.ts](../../src-server/security/confinement/confinement-preflight.ts),
  `GET /api/diagnostics/confinement-preflight`, read by `station doctor`)
  answers the two host-level facts before any start: each provider's own
  `availability()` from the list a start resolves from
  (`DEFAULT_CONFINEMENT_PROVIDERS`), and the credential step
  `confinedClaudeDecision` itself calls (`confinedClaudeCredentialCheck`),
  over the inputs a fresh start that names no credential profile of its own
  builds: the inherited spawn environment, the connection's environment and
  the app home of the connection's active credential profile (or its
  app-home opt-in). The answer's `appliesTo` says so: an Agent with its own
  `execution.credentialProfileRef`, or a credential-recovery restart, uses
  that profile's confined home and is decided at start. It creates no
  app-home profile and no spawn TMPDIR: it uses `inheritedSpawnEnv` (no
  PATH augmentation, no TMPDIR creation) and
  `createCredentialProfileAppHomeEnvPeek`, which names a profile home that
  does not exist yet by the directory a start would create, and answers
  `unverified` where it can see, without writing, that the start would be
  refused (that home's path or an ancestor is not a directory, or the
  directory it would be created in is not writable). The connection
  settings come from the ordinary app config load, which, as any config
  read does, may write a default `config/app.json` when none exists and
  may rewrite an existing one when it normalizes it (for example filling
  missing defaults or removing legacy, internal or retired keys).
  `createStationConfinementPreflight` assembles these inputs.
  Known gap: that assembly mirrors the layering in
  `ClaudeAdapter.startSession` and `prepareSeatbeltStart` rather than
  sharing it, so a change to the adapter's layering is not seen by the
  preflight or its tests. The other three fallbacks depend on the workspace
  or the conversation and are reported as decided at start. Codex's
  engine-native sandbox is reported as decided by the engine at start.
- **What a confined session does not load.** Its `CLAUDE_CONFIG_DIR` is
  Station's, so the operator's own `CLAUDE.md`, settings, hooks, plugins and
  MCP configuration do not apply. The workspace's project settings still do.
- **Residuals.**
  - `os-profile` does not hide arbitrary operator files: reads are broad,
    and `container` (#2496) is the level that hides them.
  - Kernel-tested denials: a hidden file read directly, through the
    `/System/Volumes/Data` firmlink, through a symlink and in another case;
    a hard link or clone of it made from inside; a write to a sibling that
    shares a granted path's prefix; a denied git path in another case;
    launching an app from the workspace (`open`, LaunchServices `-54`);
    running a setuid program (`crontab`); reading the login Keychain through
    `security`; `launchctl submit`.
  - A hard link to a hidden file made outside the sandbox beforehand is
    readable from inside: Seatbelt matches the path used, and a hard link is
    another path to the same file. Pinned by a test so a change is noticed.
  - Mach services stay broadly allowed (`(allow mach*)`): Claude Code, Node
    and the tools it runs need them, and no narrower list was proven. Not
    probed: data-protection Keychain items through `secd`, Apple Events to
    unconfined applications (they need the operator's Automation consent),
    and attacks on the operator's other processes through Mach services.
  - The workspace is writable, so confined code can still write files a
    later unconfined session in that folder may load: `.mcp.json` servers,
    a nested repository's `.git`. Accepted: inside the sandbox they do not
    widen it, but an unconfined session that loads them runs them
    unconfined. Every `.codex` and `.claude` is denied (above).
  - The macOS `xcrun` git shim cannot write its cache in the per-user system
    temp folder, and a background `pack-refs` cannot write the shared
    `packed-refs`. Git prints warnings and carries on.
  - The engine's own children (MCP servers, tools) inherit the sandbox. The
    model-catalog probe and Station's in-process MCP servers are not wrapped.
  - The profile leaves the network open unless the Station's policy
    restricts it ([restricted network](#restricted-network-4769)). A spec
    asking for anything else (`none`, `loopback`) is refused.
- **Enrolment.** The existing credential-profile enrolment runs
  `claude auth login` unconfined, so on macOS it writes the Keychain, which a
  confined session cannot read. Writing an enrolled credential as a file
  needs that login run with the Keychain hidden. That is not built:
  environment credentials are the supported route.

**Station's bubblewrap sandbox for Claude on Linux** (#4770,
[bubblewrap.ts](../../src-server/security/confinement/bubblewrap.ts)). A
`spawn-wrapper` `os-profile` provider for Claude only. Mechanism
`bubblewrap`. The default provider list is per platform: Codex's sandbox,
then bubblewrap on Linux or Seatbelt elsewhere (`defaultConfinementProviders`),
so the preflight and a refusal name only the mechanism the host could have.
The Claude adapter prepares the same Station-owned directories, environment
allowlist and credential check as for Seatbelt (`claude-seatbelt.ts`).

- **Why bubblewrap, not Landlock.** Both work without privileges. Landlock
  was rejected for three reasons:
  - It only allows. A ruleset grants access beneath a directory, with no
    deny rule, so granting the workspace grants everything under it. The
    write denials Seatbelt keeps inside the workspace cannot be expressed:
    a main checkout's `.git/config` and `hooks`, or a linked worktree's `.git`
    pointer file. Without them a confined session can plant a hook or
    `core.fsmonitor` that the operator's next unconfined `git` runs. A bind
    mount can make an existing path read-only inside a writable one.
  - It restricts the calling thread before `exec`, and Node runs nothing
    between fork and exec. A runner would need a way to make the system
    calls, and Station ships none on Linux:
    - koffi, the FFI the repository declares, is pruned from the server
      runtime off Windows (`koffi-off-windows` in
      `scripts/lib/desktop-server-runtime.mjs`).
    - Station's own container image has no `python3`.
    - `setpriv --landlock-access` needs util-linux 2.40, newer than Ubuntu
      24.04 and Debian 12 ship.
    - A compiled helper needs a per-architecture build and signing in the
      release pipeline.
    A runner written in Node would also restrict only the thread that makes
    the call.
  - It cannot hide a path from reads without listing every sibling.

  bubblewrap is an executable that sets up its sandbox and then execs the
  command, like `sandbox-exec`, so the spawn, the probe and the posture work
  as they do for Seatbelt. It needs unprivileged user namespaces. Ubuntu
  23.10 and later restrict those through AppArmor
  (`kernel.apparmor_restrict_unprivileged_userns`) unless the executable has
  a profile that allows them. Docker's default seccomp profile refuses them.
  bubblewrap is not installed everywhere. Where it cannot apply, the start
  is refused with bubblewrap's own reason. It never starts unconfined.
- **Where it applies.** A `workspace` Claude start at `never` on Linux.
  Availability needs Linux, an executable `/usr/bin/bwrap` (a fixed path,
  never `PATH`) of version 0.8.0 or later (`--disable-userns`), and a probe
  run once per process. An older bubblewrap is refused with its version
  named. The probe runs the production arguments, with the real hidden
  list, around `/bin/sh` in a throwaway directory under `/var/tmp` (outside
  the sandbox's own `/tmp`; a host without a writable `/var/tmp` is refused
  by name, since inside the private `/tmp` the outside-write check would
  prove nothing), with the session's temp and
  configuration directories inside a hidden Station home as a start mounts
  them. The shell must be able to write the workspace and the temp
  directory, and must be refused the content of a hidden directory's file
  and of a hidden file and a write to the `.git` pointer file. No write it
  makes outside the workspace, or to the hidden home outside its grants,
  may reach the host.
- **Workspaces it refuses.** Besides the Seatbelt rule (home folder,
  Station's data, a hidden folder), a workspace inside a path the sandbox
  hides, or containing one, falls back to Auto as `workspace-too-broad`. A
  secret store linked into the workspace resolves there, and the
  workspace's writable mount would re-open it; the argument builder also
  refuses a hidden path inside any write grant.
- **The sandbox.** It runs in a new user, PID and IPC namespace, may not
  create a nested user namespace, gets a new session, and ends with
  Station's process. Then, in order, later mounts covering earlier ones:
  - The whole filesystem read-only, a private `/dev`, a `/proc` that shows
    only the sandbox's own processes, and a private, writable, in-memory
    `/tmp`. Nothing in the host's `/tmp` is visible: X11 and `ssh-agent`
    sockets there, other processes' files, and anything created there later.
  - The directory holding each hidden path is shadowed, never the path
    itself. A mount over a file follows the directory entry it covered, so
    when the host replaced that entry (a rename over `~/.git-credentials`,
    `~/.netrc` or `~/.claude.json`, or a daemon unlinking and creating its
    socket again) the new one showed through (EXECUTED in review). Each
    nearest existing parent of a hidden path (in practice the home folder,
    `/run` and a `DOCKER_HOST` socket's directory) becomes an empty memory
    file system, and every entry the host has there at the start is mounted
    back read-only (`--ro-bind-try`, so an entry the host removes before
    bubblewrap mounts it is left out rather than failing the start), except
    the hidden ones. Symbolic links are re-created as copies of themselves.
    Each hidden path is listed both resolved and as named, so a hidden path
    that is a link is left out itself, not only what it points to: the host
    replacing `~/.claude/.credentials.json -> ../dots/creds.json` with the
    file itself shows nothing (EXECUTED in review, now a kernel test). A
    directory on the way to a hidden path (`~/.config`, `~/.claude`,
    `/run/user`) is shadowed the same way. A hidden path under `/tmp` needs
    nothing.
  - The home folder is shadowed because hidden files live directly in it
    (`.netrc`, `.git-credentials`, `.npmrc`, `.claude.json`) and only a
    shadowed directory keeps a replaced entry out; every other directory is
    shadowed only on the way to a hidden path. Each entry mounted back costs
    three bubblewrap arguments (it accepts at most 9,000) and setup time
    that grows faster than the count (measured in review: 1,000 entries
    1.5 s, 2,000 entries 6 s, against the probe's 8 s), so more than 1,000
    entries across the shadows is refused by name: "too many entries to
    shadow: N (at most 1000); <directory> holds M". The mechanism is then
    reported unavailable, and a requiring start is refused.
  - Station's installs re-opened read-only, then the write grants bound
    writable. Each shadow is made read-only last.
  - The workspace's `.git` read-only whenever it exists, even when its
    layout cannot be read, and an existing `.codex` or `.claude` directory
    (in any case) at the root of a write grant read-only.

  A grant of a single file, an exact-path deny, a missing write grant, a
  hidden path inside a write grant, a denied path that only its whole grant
  could cover, or a `.git` that is a symbolic link (the link itself could be
  replaced) is refused, never narrowed or widened. A refusal found while the
  arguments are built is named in the start's refusal message.

  So inside the sandbox a hidden entry is absent whatever the host later
  does to it, an entry the host creates later directly in a shadowed
  directory is absent too, and a visible file or link the host replaces
  stays the old one. A directory mounted back keeps showing the host's live
  contents, including sockets and files created there later.
  Anything under the host's `/tmp` other than the grants is absent, which
  includes a workspace's git directory there.
- **Grants.** The write kinds are `workspace`, `station-temp` and
  `station-config`, read back from the arguments bubblewrap is given. No
  git metadata is writable in this change, by choice: the workspace's
  `.git` is read-only, so a confined session can run `git status`, diff and
  log, but cannot stage or commit. Granting git writes needs a design of its
  own. Git replaces a branch ref by renaming `<ref>.lock` over it, so a
  mount can grant the ref only with its whole directory. For a Station
  worktree branch (`station/session/<suffix>`) that is
  `refs/heads/station/session`: commits then work and `refs/heads/main`
  stays refused, but every sibling `station/session/*` branch becomes
  writable (EXECUTED in review). A linked worktree's absent
  `config.worktree` also cannot be covered without creating it. A follow-up
  adds worktree-mode git writes.
- **The posture.** It is `confined` only when three things hold. The spawn
  seam recorded `/usr/bin/bwrap` with exactly these arguments. The engine
  answered its handshake over that process's stdout (bubblewrap execs it
  only after the sandbox is in place). The arguments it was spawned with are
  in bounds: they start with the namespace and read-only-root options, every
  writable mount is one of the three grants, and the workspace's `.git`
  (when it exists) is mounted read-only after the workspace. Anything else
  is `configured-but-failed`, and the start is refused before or after the
  spawn exactly as for Seatbelt.
- **Read denials compared with Seatbelt.**

  | Seatbelt | bubblewrap |
  | --- | --- |
  | Secret stores, `~/.claude.json`, the engines' credential files, Station's root and runtime home: reads refused | Absent inside (no such file), including when the host replaces or creates them during the session, or replaces a link at that path with the secret itself. Not covered: the target of a hidden link that is dangling at the start (it is readable once created), a middle link in a chain of links, and copies under other names such as `~/.claude.json.tmp.*` (both mechanisms hide exact paths only). |
  | `~/Library/Keychains` hidden | Not applicable on Linux. Hidden instead: the login keyring (`~/.local/share/keyrings`); the runtime directory (`/run/user/<uid>`, and one `XDG_RUNTIME_DIR` names elsewhere: session bus, keyring SSH agent, rootless Docker or Podman); `~/.docker/run`; the Docker, Podman and containerd sockets under `/run`, and the socket a `unix://` `DOCKER_HOST` names; the system bus socket; `~/.Xauthority`; the 1Password and Bitwarden SSH agents (`~/.1password`, `~/.bitwarden-ssh-agent.sock`); GNU screen's sessions (`/run/screen`), which accept keystrokes from the same user; and everything in the host's `/tmp` (X11, tmux and `ssh-agent` sockets). A read-only mount does not stop `connect()`, and the process keeps its user's groups (`docker`), so these sockets are absent, not just read-only. |
  | Station's `installs` readable | Matched. |
  | A hidden file through a symlink, another case, a firmlink | Matched through a symlink, `/proc/self/root` and `..`. Linux file systems are case-sensitive. |
  | A hard link to a hidden file made inside | Matched: refused. |
  | A hard link made outside beforehand | Same residual: readable. |
- **Write denials compared with Seatbelt.**

  | Seatbelt | bubblewrap |
  | --- | --- |
  | Workspace, session temp, Station configuration directory writable | Matched. |
  | A linked worktree's git directory, the objects and its own branch ref writable | Not granted in this change: no staging or commits. |
  | git `hooks`, `config`, `info`, `commondir`, alternates, pointer files denied | Stronger: the workspace's whole `.git` is read-only, and the shared repository is outside every grant. |
  | `.codex` and `.claude` denied at any depth, in any case | Partly: only an existing one at a grant root. Creating one anywhere, or writing an existing nested one, is allowed. |
  | Signals only within the sandbox | Matched by the PID namespace: outside processes are not visible. |
  | A setuid program refused | Matched: `no_new_privs`. |
- **Residuals.**
  - **A known gap that weakens #3800.** A confined session can create a
    `.claude` or `.codex` directory wherever none exists, at the workspace
    root (`.claude/settings.json` with hooks) or nested (`sub/.codex`), and
    write an existing nested one. The next unconfined Claude or Codex
    session started there loads it and runs its hooks or MCP servers outside
    the sandbox. A mount covers only a path that exists, so bubblewrap cannot
    deny the name the way Seatbelt does. Closing it needs an owner decision
    (for example refusing such a start, or another mechanism). A kernel test
    pins the current behaviour.
  - **What stays reachable.** The network is open, and a restricted network
    is refused by name ([restricted network](#restricted-network-4769)). The
    network namespace is shared, so abstract Unix sockets stay connectable:
    a session bus or X11 server listening on one is reachable, and
    `/proc/net/unix` lists them. What is unreachable is exactly: the hidden
    paths above, `/run/user/<uid>`, the host's `/tmp`, and any entry created
    after the start directly in a shadowed directory (the home folder,
    `/run`). Every other Unix socket the user can open stays connectable,
    whether it exists at the start or is created later: one directly in the
    home folder or `/run` at the start and not on the list, one inside a
    directory mounted back from a shadow (EXECUTED in review:
    `/run/snapd.socket`, `/run/screen/...` before it was listed, a socket
    created mid-session in `~/.cache/sock/`), and one outside the home
    folder, `/run` and `/tmp`. The list names the known agents and daemons;
    it cannot name every program that listens.
  - **Hard links and names.** A hard link elsewhere in the home folder (or
    any visible directory) to a hidden file is readable, as with Seatbelt:
    the sandbox hides paths, and a hard link is another path. An entry whose
    name is not valid UTF-8 is left out of a shadow inside the sandbox.
  - **A hidden directory replaced as a whole.** A hidden directory is absent
    because its parent is shadowed; a directory mounted back from a shadow
    shows the host's live contents. A hidden directory that has no shadowed
    parent (only one directly under `/`) is covered by an empty mount, which
    the host replacing that directory would detach.
  - `/dev` is a private writable memory file system, which reaches nothing
    outside the sandbox.
  - The optional `claude-confined-credential` readiness entry is still
    macOS-only; `station doctor` reports the confined credential on Linux.
- **Tests.**
  [bubblewrap.process.test.ts](../../src-server/security/confinement/__tests__/bubblewrap.process.test.ts)
  runs the production arguments under the real kernel, including a live
  Claude Code handshake observed `confined`, a socket listening at a hidden
  path that refuses a connection from inside, the host's Docker socket
  (where this user can reach one outside), a hidden home file the host
  replaces by rename mid-session, a hidden socket the host unlinks and
  creates again mid-session, a hidden path that is a link replaced by the
  secret mid-session, an entry removed between building the arguments and
  the start, a socket under the host's `/tmp` at the start and created
  mid-session, and DNS resolution inside. It skips loudly where the
  sandbox cannot apply. Its ids are pinned as the `linux-bubblewrap-kernel`
  profile, and the dispatch-only
  [`Tool: bubblewrap kernel legs`](../../.github/workflows/bubblewrap-kernel.yml)
  workflow runs it on a hosted Ubuntu runner. EXECUTED: Linux 7.2.12
  (OrbStack, aarch64, Landlock ABI 10 present and unused), bubblewrap 0.8.0,
  git 2.39.5, with a root-owned Docker socket for the `docker` group: 55 of
  55 passed.

#### Restricted network (#4769)

A confined process can read the workspace, so with an open network it can
send it anywhere. A restricted network limits a confined start's own
connections to Station's egress broker. Domain shapes are in
`execution-confinement`; the broker is
[egress-broker.ts](../../src-server/security/confinement/egress-broker.ts).

- **Opt-in, at Station scope.** The `confinedNetwork` Station setting
  ([config](../reference/config.md#optional-fields)) is absent or `full` by
  default, which changes nothing: the unrestricted Seatbelt profile and
  bubblewrap arguments are byte-identical to before. `restricted`, with an
  `allowedHosts` list, applies to every start whose required level is
  `os-profile` or stronger. No Project-level confinement policy exists to
  carry it, so it is a Station setting, and a [managed
  policy](../guides/managed-policy.md#settings) can lock it, which no
  Station value then lowers. A Project that raises it for itself is not
  built. `PUT /config/app`, the settings file load and a managed policy all
  refuse a value whose shape or any allowed host the broker cannot read
  (`appConfigSemanticError`, which parses each entry with the broker's own
  `parseEgressHostRule`).
- **Which starts it covers.** Only starts that require confinement. The
  operator's own `host` starts and every start at Auto or Ask are not
  confined, so their network is not restricted at all; the policy is never
  read for them. A start that requires confinement either runs restricted or
  is refused: it never falls back open. The Claude fallbacks to Auto
  (`confined-credential-unavailable`, `workspace-too-broad`,
  `resume-bound-elsewhere`, `config-root-pinned`) are refused under a
  restricted policy, naming the reason ("This claude session requires a
  restricted network, which cannot be applied to this start: <reason>
  (<code>). Nothing started."), instead of running at Auto with nothing
  engaged.
- **Resolution.** `withConfinement` reads the policy only for a start whose
  required level is above `host`: a fresh start, a respawn or
  credential-profile restart, and an adoption all pass through it. An
  adoption carries no approval mode, so it requires no confinement and does
  not read the policy; if an adoption did reach the Claude adapter with a
  restricted plan, the adapter refuses it (adoption pins the global
  configuration root, so it cannot be confined). Restricted,
  `resolveConfinement` resolves only a provider that declares it can restrict
  the network (`restrictsNetwork`), and the plan carries the policy. Station's
  Seatbelt provider can. Bubblewrap and Codex's own sandbox cannot, so such a
  start is refused (`confinement_mechanism_unavailable`) with each reason
  named, for example "bubblewrap: restricted network is not available with
  the bubblewrap sandbox yet". A stored policy that is not valid, or a
  configuration that cannot be read, also refuses the start, as a
  confinement refusal.
- **The broker.** One per confined session, on `127.0.0.1` and a port the
  system picks, closed after the session's engine is stopped. It is an HTTP
  `CONNECT` proxy: `CONNECT` names the host before any DNS lookup and
  without TLS interception. In a pinned order it admits the engine's model
  endpoint, then any allowed-host entry, and denies the rest with 403. An
  entry is `host`, `host:port`, `*.domain` (subdomains, not the domain) or an
  IP literal, on port 443 unless named; hosts compare in lowercase with one
  trailing dot removed. For an admitted name the broker resolves it itself
  and dials the address it checked. A listed name that resolves to a
  loopback, private, site-local, link-local or other non-public address is
  refused, and so is an IPv6 form that embeds or relays to one
  (IPv4-compatible, -mapped and -translated forms and the NAT64 well-known
  prefix are judged by the IPv4 address they carry; 6to4, Teredo and
  local-use NAT64 are never public), so DNS rebinding cannot reach Station's
  own port. A listed IP literal may be private but never loopback. A request
  that is not `CONNECT` gets 405, a malformed one 400 (a line ended by a bare
  LF at once), a header over 8 KiB 431, and a header not finished in 10
  seconds 408. At most 256 connections are open at once.
- **The model endpoint** is derived from the environment the engine is
  actually spawned with (`claudeModelEndpoint`): an `https:`
  `ANTHROPIC_BASE_URL` (a gateway, or Station's model-proxy route), else
  `api.anthropic.com:443`, the engine's own default. A connection that uses
  Bedrock, Vertex or Foundry, or a plain-HTTP base URL, cannot be derived or
  tunnelled, so a restricted start with one is refused before anything is
  spawned. The endpoint is allowed whatever address it resolves to: it is
  what the engine reaches unconfined.
- **Engine reach.** Claude Code honours `HTTPS_PROXY`. The spawn wrapper sets
  `HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` (and lower case) to the broker,
  removes `NO_PROXY` (an excluded host would be dialled directly and
  refused), and sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, since the
  telemetry and update hosts are not allowed. EXECUTED (Claude Code 2.1.321,
  macOS 26.7.2): the installed engine answered its handshake inside the
  restricted profile and its first model request arrived at a stand-in
  endpoint as a TLS ClientHello through the broker's tunnel; against
  Anthropic's API through the broker, with a fake key, the request completed
  TLS and was answered "Invalid API key", so certificate checks need none of
  the Mach services denied below. Its children (a shell, MCP servers)
  inherit the same variables and the same kernel rules.
- **Seatbelt.** Two changes, both only in restricted mode:
  - The open-network rule `(allow network*)` is replaced, in place, by
    `(allow network-outbound (remote tcp4 "localhost:<port>"))`. SBPL accepts
    only `localhost` or `*` as a host there: an explicit `127.0.0.1` is
    refused when the profile is compiled ("host must be * or localhost").
    `localhost` matches every address of this host at that port, its LAN
    address included, not only loopback (EXECUTED: a `0.0.0.0:<port>`
    listener was reached through the LAN address). `tcp` would also admit
    `[::1]:<port>`, which the broker does not hold (EXECUTED: an unrelated
    listener there was reachable with `tcp` and is refused with `tcp4`).
    Under `(deny default)` the kernel refuses every other connect with
    `EPERM`: another port (Station's own), any other host, IPv6 loopback, a
    Unix socket at a known path (an SSH agent's), and UDP.
  - Mach lookups become an allow-list: `(deny mach-lookup)` after
    `(allow mach*)`, then only `com.apple.bsd.dirhelper`,
    `com.apple.diagnosticd`, `com.apple.logd`,
    `com.apple.system.notification_center` and
    `com.apple.system.opendirectoryd.libinfo` and `.membership`. With
    `(allow mach*)` a background `URLSession` upload, which
    `nsurlsessiond` performs outside the sandbox, carried workspace content
    to the LAN, to `https://example.com` and to any loopback port (EXECUTED
    in review, with a program `swiftc` compiled inside the sandbox). The list
    was found by running Node, Claude Code (handshake and a model turn
    through the broker), a shell and git under a profile that denied every
    lookup, and reading the sandbox's denials in the unified log (`log
    stream --predicate 'sender == "Sandbox"'`); the services kept are local
    (user and group lookups, per-user temp paths, `notify(3)`, the unified
    log). Denied among others: `com.apple.nsurlsessiond`, LaunchServices
    (`com.apple.lsd.*`, which opens a URL in another application),
    CoreServices and Apple Events, `trustd`, `cloudd`, `configd`, and
    `com.apple.dnssd.service`. Inside, `swiftc` itself no longer runs.
  The filter syntax follows macOS's own profiles in
  `/System/Library/Sandbox/Profiles`. The engine needed no other local IPC:
  the SDK speaks to it over its stdio pipes, which are not network
  operations.
- **Linux.** Not shipped: bubblewrap refuses a restricted start by name. The
  sandbox shares the host's network namespace, so its only restriction would
  be `--unshare-net`, which leaves a private loopback that the broker on the
  host's loopback is not on (EXECUTED in the bubblewrap container: a host
  listener connected without it and refused with `ECONNREFUSED` with it).
  Bridging the two needs a forwarder inside the sandbox (a Node process
  between `bwrap` and the engine, relaying a TCP port on the private
  loopback to a Unix socket bound in from the host), which changes the
  spawned process tree the posture is derived from; it is a follow-up.
  `--unshare-net` would also close the abstract Unix sockets the residual
  above names.
- **The record** gains `network: 'restricted'`, written only when the start
  was observed `confined` and the profile it was spawned with is the
  restricted one, broker rule and Mach allow-list both (`pending.network`,
  read from the built arguments, which the posture already requires to
  equal the spawned ones). A plan that asks for a restricted network whose
  spawn lacks either is `configured-but-failed` and refused. Absent means
  the network was open.
- **Decision records.** Every request to the broker produces one record:
  time, verdict, reason and, when it named one, host and port. Never a
  payload, a URL path or a header (a plain-HTTP request's path is dropped).
  The broker keeps none itself. The session writes each distinct decision
  (allowed or denied) once to the Station log, at most 80 per session, and
  reports each refusal to the person (below).
- **What the person sees.** #2495 (sandbox denials as approval cards) is not
  built, so a refused connection is published as a `runtime.warning` with
  code `confined_network_denied`, naming the host, port and reason. The app
  shows it as a five-second warning toast while the session is open; the
  event is stored with the session's events and is listed in the session's
  diagnostics log. Each distinct refusal is reported once, and at most 20 per
  session, followed by one notice that further refusals are not reported one
  by one. A denied host name is kept as long as the conversation's events
  are; allowed connections are kept only in the Station log.
- **Doctor.** The confinement preflight reports, per engine,
  `restrictedNetwork`: `available` when its mechanism can restrict the
  network and is available on the host, otherwise `unavailable` with the
  reason; `station doctor` shows it as a `Restricted network` row.
- **Residuals.**
  - Station's own tools run in Station's process, outside the sandbox. A
    restricted session's station-control server is given only the tools on
    `RESTRICTED_NETWORK_STATION_CONTROL_TOOLS` (reads, changes to Station's
    own records, actions a person completes or approves, and notices to the
    person), and the station-control guard refuses (`403
    station_control_network_restricted`) any route whose tools are all
    withheld when the calling session's latest start record says `network:
    'restricted'`. Withheld:
    - Station's browser (`station-browser`, Station's Chromium), which
      navigates wherever it is told; the session is not given that server
      either.
    - The device tools, which drive a simulator, emulator or phone with its
      own network; the device route also refuses such a caller
      (`device-network-restricted`).
    - `html_render` and `html_preview` (Station's Chromium).
    - Starting, steering or reading other sessions (`send_message`,
      `delegate_task`, `fork_conversation`, `run_independent_review` and the
      Task tools): a child at Auto or Ask would not be network-restricted.
    - Operator-scope changes a session acting for the operator could
      otherwise make: `update_config` (and `PUT /config/app` refuses any
      agent's change to `confinedNetwork`; an agent on the host with a shell
      of its own could still edit the configuration file, as for
      `terminalShell`), Agents, skills, jobs,
      integrations, providers, plugins, SSH environments, knowledge
      reindexing and migration, pull-request guides.

    The guard refuses only a route owned solely by withheld tools; a route a
    kept tool shares stays open. Both readers fail closed: if the store read
    throws, the call is refused, also for a session that started
    unrestricted (the caller resolver reads the same store first, so a
    broken store normally fails before this). The in-process
    station-knowledge server is held to the same allow-list.

    Kept and gated otherwise: `terminal_run` runs a command outside the
    sandbox only once a person approves that run; `propose_job` and
    `propose_plugin_install` are completed by a person; `notify_user` reaches
    the person's own devices. Reads that make Station fetch on its own
    behalf (`list_models`, `list_registry_skills`, `check_plugin_updates`,
    the Project S3 reads of configured buckets) send nothing the session
    chooses beyond an object key in the operator's own bucket. The
    model-catalog probe is Station's own request to the connection's
    endpoint. Three kept tools send to hosts the broker does not cover:
    - `search_knowledge` sends the agent's query text to the configured
      embedding provider, a host the operator chose.
    - `declare_pull_request` and `read_pull_request_guide` read the forge for
      the Project's own repository.
    - An approved `terminal_run` executes on the host with an open network,
      and its approval card does not say the session is restricted
      (carrying that to the card needs the run record to name the
      session's network; not built).
  - The broker rule admits this host's own addresses at the broker's port,
    so another local program listening there on a non-loopback address (the
    broker holds only `127.0.0.1`) would be reachable. Local only: another
    host at that port is refused.
  - The Mach allow-list keeps user and group lookups, which on a Mac bound to
    a directory service can query that server; no request content is the
    caller's beyond a user or group name.
  - A process the session started that outlives it (a background job the
    agent left running; the engine is stopped without its process group)
    keeps the kernel rule to the broker's port after the broker closes. If
    another program later listens on that port, such a process could
    connect to it.
  - DNS: a name lookup inside the restricted profile fails; the broker
    resolves names itself.
  - Station's own port is unreachable, so a remote MCP server Station proxies
    through its engine OAuth route does not work in a restricted session;
    reaching Station with an attenuated credential (#2494) is not built.
  - Anything that is not HTTPS through a proxy (`ssh`, `git://`, plain HTTP,
    a tool that ignores the proxy variables) is refused. `git fetch` and
    `npm install` work only for hosts on the list.
  - A Claude credential file enrolled in the Station-owned configuration
    refreshes against Anthropic's sign-in host, which is not derived; list
    it, or use an environment credential.
- **Tests.** Broker policy and CONNECT handling over real loopback sockets
  ([egress-broker.test.ts](../../src-server/security/confinement/__tests__/egress-broker.test.ts));
  the profile builder and posture
  ([seatbelt.test.ts](../../src-server/security/confinement/__tests__/seatbelt.test.ts));
  resolution, the setting and the record
  ([confinement-provider.test.ts](../../src-server/security/confinement/__tests__/confinement-provider.test.ts),
  [confinement-start.test.ts](../../src-server/services/orchestration/__tests__/confinement-start.test.ts));
  the write path
  ([config.routes.test.ts](../../src-server/routes/system/__tests__/config.routes.test.ts));
  the adapter wiring, fallback and adoption refusals and the withheld browser
  ([claude-adapter-seatbelt.test.ts](../../src-server/providers/__tests__/claude-adapter-seatbelt.test.ts));
  the guard's and device route's refusals and the pinned tool classification
  ([station-control-authority-guard.routes.test.ts](../../src-server/security/__tests__/station-control-authority-guard.routes.test.ts),
  [device-agent.routes.test.ts](../../src-server/routes/__tests__/device-agent.routes.test.ts),
  [station-control-policy.test.ts](../../src-server/tools/__tests__/station-control-policy.test.ts));
  and twelve kernel legs nested in
  [seatbelt.process.test.ts](../../src-server/security/confinement/__tests__/seatbelt.process.test.ts)
  (`with a restricted network (#4769)`), among them the background
  `URLSession` upload, a toolchain-free Mach leg (`scutil --dns` answered
  by `configd` outside the profile and refused inside it) and the IPv6
  loopback leg, pinned in the
  `seatbelt-kernel` profile.

Not in this slice: the foreground chat handle's receipt, ACP, and Windows
mechanisms.

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
  - compare-and-set: G-off, a basis of `null`, the duplicate-carry race, the
    spawn window, a fresh device's stricter pick recorded, a stale Default
    refused though it resolved stricter when picked (the reviewer's
    sequence), and Ask, but not Auto, recorded over a standing Default;
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
- **Task dispatch authority**
  (`src-server/routes/orchestration/__tests__/task-dispatch-full-access.routes.test.ts`).
  Real pairing, auth boundary, tasks and starter routes, a real
  `StarterRegistry` and a real `TaskDispatcher`. It covers a device refused on
  both routes (with no Task left behind), a stricter posture allowed, and a
  granted device and the operator reaching the engine at `never`. The
  dispatcher's own refusal, for any caller, is in `task-dispatcher.test.ts`.
- **Station default authority**
  (`src-server/routes/system/__tests__/config-default-approval-full-access.routes.test.ts`):
  a device refused on raising the default to `never` and allowed a stricter
  one; the operator and a granted device allowed; a standing `never`
  resent without a grant.
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
  and it does not go through the Agent write routes. This covers
  `agent-approval-overrides.json` too: whoever can write the Station home can
  already do anything the operator can.
- **The posture is not added to the session-summary snapshot.** A client that
  reconnects through a snapshot folds the posture from the next event or from
  its own result. The engine is correct either way, because the server applies
  the posture.
