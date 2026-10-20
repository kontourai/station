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
   - The server resolves them, so the Station default no longer depends on
     the client that started the session.
   - **Owner decision (2026-09-23): this applies to every session start.**
     That includes `station chat`, delegations, inbound webhooks, Discord and
     scheduled jobs, not only chats from the UI.
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
  - The operator grants it once per device: when approving a pairing
    request that asked for it (the Station app asks for it; only the operator
    credential or the desktop's local grant may keep it, and **Limit access**
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
mechanism the host would need: Seatbelt on macOS, bubblewrap or Landlock on
Linux. An unrequired start still engages an engine-native mechanism, so the
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
  extra writable root it lists lies inside the resolved workspace or
  Station's own engine temp directory. A root such as `/`, the home directory
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
    not writing inside a checked-in one.
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
  - **Checked-in configuration is still honoured.** A `.codex` the
    repository already contains, at any depth, is repository content with
    the same trust as the top-level one: its `mcp_servers` still run, and its
    keys merge into the profile. A writable root it adds outside the
    workspace still shows in `writableRoots` and is refused above. What the
    profile closes is the agent planting or changing one.
  - **Residual: Linux.** Outside macOS, Codex expands a deny glob from a
    snapshot of existing paths before the sandbox starts. A `.codex` the
    agent creates later is not denied there, so the nested-write path stays
    open on Linux (EXECUTED, codex-cli 0.160.0 with bubblewrap: creating
    `sub/.codex/config.toml` was allowed; writing an existing checked-in
    file was refused). The live probe runs only on macOS and warns
    elsewhere.
  - Every other project key from a checked-in file still applies, including
    network access, which Station does not judge (Seatbelt leaves the
    network open too). The Seatbelt profile denies every `.codex` (below),
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
  the Seatbelt plan, or refuses where it cannot exist. On Linux, Windows, or a
  macOS without a working `/usr/bin/sandbox-exec`, the start is refused
  (`confinement_mechanism_unavailable`), naming the mechanism. Availability
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
    refs, `packed-refs`).
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
  - The profile does not restrict the network; a spec asking for less is
    refused.
- **Enrolment.** The existing credential-profile enrolment runs
  `claude auth login` unconfined, so on macOS it writes the Keychain, which a
  confined session cannot read. Writing an enrolled credential as a file
  needs that login run with the Keychain hidden. That is not built:
  environment credentials are the supported route.

Not in this slice: the foreground chat handle's receipt, ACP, and Linux or
Windows mechanisms.

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
