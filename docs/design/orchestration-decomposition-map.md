# The Seam Map — `OrchestrationService`

**Status:** accepted direction — the working document for epic #4024; slices
cite and update this map instead of re-deriving it.
**Subject:** `src-server/services/orchestration/orchestration-service.ts`
**Mapped at:** `9ac5185b0` (origin/main, 2026-08-24), for slice 1 (#4116).
**Core re-derivation:** Part II below was derived fresh at `71699b7c1`
(2026-08-25, after slices 1–8, #4186) and SUPERSEDES this Part's §1, §3,
§5–§8 and the eight remaining core cluster sections. Part I's RESOLVED
notes remain the authoritative record of what each slice did; its stale
core data is kept as the historical derivation. Read Part II first when
planning a core slice.

---

## 0. Corrections to the epic's premises

The map must describe the code, so these come first — three of the epic's four
structural numbers were off, and one expected concern does not exist as a
cluster.

| Epic said | Actually |
|---|---|
| file ~8,865 lines | **8,966** lines; `export class OrchestrationService` at **1106**, closing `}` at **8856** |
| ~142 methods | **179 methods + 1 constructor** inside the class body |
| ~31 private Map/Set fields | **53 declared fields**: 29 collections (Map/Set/WeakSet), 5 mutable scalars, 2 constants, 17 injected/constructed collaborators |
| "credential-profile recovery" cluster | exists (5 methods, 1859–2063) but is **not field-owning** — it is a *writer* into six other clusters' maps |
| "message search" cluster | exists and is the most isolated read path in the file (§7 runner-up) |
| "conversation handoff" cluster | exists, 13 methods, but owns **zero** fields |
| "turn-stall handling" cluster | exists, owns **three** fields exclusively — **the slice-1 recommendation** |
| "adapter lifecycle/retirement" cluster | exists, 7 owned fields, but is entangled with shutdown + the ingest loop |

Also: `validateConnectedCliTurnModelSelector:7268–7303` has a multi-line
generic signature and is missed by naive `^  (private|async)` scans. Three
public members are dead outside the file and its tests:
`attachSessionEvidence:5761`, `readSessionWorkflowState:6041`, and
`listSessionConversations:3980` (only route *test* doubles name it).

---

## 1. Field inventory
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.


29 collections + 5 mutable scalars, in declaration order. "Owner" = the
cluster whose methods perform the **writes**.

### 1a. Mutable collections
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| Line | Field | Kind | Purpose (one phrase) | Owner cluster | Writers |
|---|---|---|---|---|---|
| 1114 | `consumedAdapterEventStreams` | WeakSet | adapters whose event stream has been consumed once | C1 | 2 |
| 1116 | `activeEventAdapters` | Map | provider → the adapter currently streaming | C1 | 2 |
| 1120 | `adapterEventControllers` | Map | adapter → its stream `AbortController` | C1 | 4 |
| 1124 | `adapterRetirements` | Set | in-flight deadline-bounded retirement promises | C1 | 1 |
| 1125 | `adapterRetirementByAdapter` | Map | adapter → its single retirement task | C1 | 4 |
| 1129 | `retiredSessionsByAdapter` | Map | adapter → sessions captured at retirement | C1 | 3 |
| 1134 | `sessionAdapters` | Map | thread → the adapter this process holds it on | C7/C1 | **14 readers, 9 writes** |
| 1136 | `cooperativeStops` | Map | one user-stop protocol per thread | C4 | 2 |
| 1147 | `pendingTurnInterrupts` | Map | Stop pressed before the turn existed | C4 | 4 |
| 1158 | `turnStallWindowByThread` | Map | per-thread resolved stall window (set at start) | **C3** | 2 |
| 1164 | `turnProgressByThread` | Map | live progress/silence observation per thread | **C3** | 3 |
| 1168 | `threadProviders` | Map | thread → provider kind | C7 | 8 |
| 1170 | `sessionReadModel` | Map | in-memory live session inventory | C7 | **30 readers, 7 writes** |
| 1176 | `ephemeralSessionThreads` | Set | webhook threads excluded from inventories | C7 | 2 |
| 1182 | `sessionConnectionIds` | Map | thread → quota-routing connection identity | C12/C16 | 8 |
| 1184 | `tenantContexts` | Map | thread → validated tenant execution context | C8 | 10 | *(moved by slice 6 → `session-authorization.ts`; external sites use its accessors)*
| 1185 | `quarantinedThreads` | Set | threads whose events are dropped except `session.exited` | C6/C2 | 3 |
| 1279 | `internalStopTurnIds` | Set | turn ids whose failure notification is suppressed | **C5** | 4 | *(moved by slice 4 → `internal-stop-suppression.ts`)*
| 1280 | `startingSessionThreads` | Set | concurrent-start claim per thread | C12 | 2 (both in one closure) |
| 1290 | `materializingSessions` | Map | in-flight lazy engine materialisations | C16 | 2 (one method) |
| 1294 | `adoptingSourceThreads` | Set | source threads with an adoption in flight | C14 | 1 method |
| 1295 | `adoptionIntents` | Map | idempotency key → adoption promise | C14 | 1 method |
| 1307 | `credentialRecoveryRestartingThreads` | Set | threads mid credential restart | C6 | ctor closure only | *(moved by slice 7 → `credential-profile-recovery.ts`, one-way)*
| 1313 | `policyThreads` | Map | thread → policy workspace cwd / `null` | C15 | 6 |
| 1315 | `pendingPolicyWrites` | Map | `thread:toolCallId` → write target | C15 | 1 method |
| 1321 | `pendingCommandSpools` | Map | `thread:toolCallId` → captured command evidence | C15 | 1 method |
| 1326 | `flowBoundThreads` | Map | thread → is flow-bound (cache) | C15 | 3 |
| 1335 | `sessionOwnerCache` | Map | thread → ownerUserId, bounded LRU | C8 | 10 (5 of them cross-cluster invalidations) | *(moved by slice 6; invalidations via `invalidateSessionOwner`)*
| 1357 | `monitoringUnconfiguredThreads` | Set | threads already warned about missing config | C18 | 1 method |

### 1b. Mutable scalars
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| Line | Field | Purpose | Read/written by |
|---|---|---|---|
| 1111 | `usageTelemetry?` | swappable telemetry observer | ctor:1378, `setUsageTelemetry`:1621, `publishCanonicalEvent`:8407 |
| 1133 | `adapterRegistryUnsubscribe?` | registry `onChange` teardown | `initialize`:1625, `shutdown`:2281 |
| 1299 | `adoptionReconciliation` | boot reconciliation promise, joined by adoption | `initialize`:1625, `performAttachedSessionAdoption`:7489 |
| 1358 | `started` | one-shot init latch | `initialize`:1625 **only** |
| 1376 | `sessionAttachmentSettled` | boot attachment pass has *finished* (not succeeded) | `initialize`:1625, `observeAnswerability`:1717 |

### 1c. Constants & injected/constructed collaborators
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| Line | Field | Note |
|---|---|---|
| 1107/1108 | `sessionCommands` / `sessionCommandImplementation` | `SessionCommandModule`, built by `createSessionCommandImplementation:4102` |
| 1109 | `sessionQueries` | `SessionQueryModule`, 8 closures over `this` (ctor 1441–1519) |
| 1110 | `sessionLifecycles` | `SessionLifecycleModule`, 10 closures over `this` (ctor 1389–1440) |
| 1112 | `adoptionOwnerId` | `crypto.randomUUID()` at construction; registered in a **module-global** `liveAdoptionOwners` |
| 1113 | `sessionExecutionCoordinator` | turn-boundary authority |
| 1156 | `turnStallWatchdog` | `new TurnStallWatchdog()` |
| 1169 | `clientOriginTurns` | `ClientOriginTurnPropagation` |
| 1300/1301/1303 | `readinessBridge?` / `commandEvidenceBridge?` / `commandEvidenceRoutingPolicy` | Flow gate trio |
| 1305/1306 | `recoveryCoordinator?` / `credentialRecovery?` | built in ctor when `eventStore` present |
| 1336 | `sessionOwnerCacheMaxEntries` | validated positive integer | *(moved by slice 6 → `session-authorization.ts`)*
| 1337–1340 | `conversationHistoryReader?`, `turnDeduplicator?`, `adoptionLedger?`, `monitoringBridge` | |
| 1346 | `deltaCoalescer` | **captures `this` in its field initializer** — see Traps T1 |

`this.options.eventStore` is dereferenced **88 times**; it is not a field but
is effectively the file's largest dependency.

---

## 2. Clusters by field ownership

18 clusters. Method list is `name:startLine`. "Owns" = fields written only by
this cluster. "Shares" = fields it touches that another cluster also touches.

### C1 — Adapter lifecycle, retirement, provider inventory
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** `consumedAdapterEventStreams`, `activeEventAdapters`, `adapterEventControllers`, `adapterRetirements`, `adapterRetirementByAdapter`, `retiredSessionsByAdapter`, `adapterRegistryUnsubscribe`
**Shares:** `sessionAdapters`, `sessionReadModel`, `threadProviders`, `tenantContexts`, `sessionConnectionIds`, `policyThreads`, `flowBoundThreads` (all via `finalizeStoppedAdapterSessions:6608`), `turnStallWatchdog`+`deltaCoalescer`+`recoveryCoordinator`+`adoptionOwnerId` (via `shutdown:2281`) *(slice 3: `adoptionOwnerId` is now `AttachedSessionAdoption.ownerId`; shutdown reaches it via `unregisterOwner()`)*

`listProviders:2356`, `getProviderCommands:2383`, `supportsReadOnlyReview:2401`, `getProviderModels:2408`, `consumeCurrentAdapterEvents:2189`, `retireAdapter:2218`, `settleProviderAdapterRetirements:2260`, `shutdown:2281`, `isAdapterCurrent:6565`, `assertAdapterCurrent:6569`, `assertAdapterCurrentAfterCommand:6577`, `captureAdapterSessions:6587`, `stopAndFinalizeRetiredAdapter:6599`, `finalizeStoppedAdapterSessions:6608`, `stopAdapterEventConsumer:6639`, `cleanupObsoleteStartedSession:6646`, `runCleanupWithinDeadline:6670`, `runOperationWithinDeadline:6682`, `adapterStopTimeoutMs:6710`, `readPrerequisites:7143`, `assertAdapterReady:7159`, `requireAdapter:7188`, `getProviderAdapter:7197`

### C2 — Event ingest & canonical publish spine (the hub)
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** nothing.
**Shares:** `quarantinedThreads`, `sessionAdapters`, `adapterEventControllers`, `consumedAdapterEventStreams`, `clientOriginTurns`, `deltaCoalescer`, `sessionExecutionCoordinator`, `threadProviders`, `sessionReadModel`, `cooperativeStops`, `sessionOwnerCache`, `recoveryCoordinator`, `monitoringBridge`, `usageTelemetry` — **14 fields, more than any other cluster.**

`consumeAdapterEvents:6400`, `projectAndPublishEvent:8274`, `publishCanonicalEvent:8407`, `readCurrentLifecycleState:8600`, `recordStateDuration:8612`, `assembleTurnProvenanceFor:8184`, `turnProvenanceSidecar:8225`, `replayTurnProvenanceSidecar:8250`

This cluster is not extractable. It is the only path every canonical event
takes and it touches a field belonging to nine other clusters. Treat it as
the fixed spine everything else is cut *around*.

### C3 — Turn progress & turn-stall observation ★ (slice 1)
**Owns exclusively:** `turnStallWatchdog:1156`, `turnStallWindowByThread:1158`, `turnProgressByThread:1164`
**Shares (read-only, except two calls):** `sessionAdapters` (read, `handleTurnStall:7110`)

`resolveTurnStallWindowMsForAgent:2171`, `handleTurnStall:7109`, `observeTurnProgress:8324`, `publishTurnProgressSilence:8359`, `recordTurnProgress:8380`, `clearTurnProgressObservation:8389`, `publishTurnProgressProjectionChange:8400`

**Every write to all three fields is inside this cluster** (`2098`, `7098`
window; `8368`/`8385`/`8395` progress; `2294`/`7096`/`8325` watchdog). Full
external touch list is in §7.

### C4 — Cooperative stop & deferred interrupt
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** `cooperativeStops:1136`, `pendingTurnInterrupts:1147`
**Shares:** `sessionAdapters` (r, 6841), `sessionReadModel` (rw, 7045/7071/7089), `threadProviders`+`sessionConnectionIds`+`tenantContexts`+`policyThreads`+`turnStallWatchdog`+`turnStallWindowByThread` (all deleted by `forgetLiveUserSession:7089`)

`cooperativeStopBudgetMs:6714`, `applyPendingTurnInterrupt:6749`, `recordPendingTurnInterrupt:6787`, `clearPendingTurnInterrupt:6804`, `dispatchDeferredInterrupt:6811`, `bindPendingTurnInterrupt:6840`, `interruptUserTurnCooperatively:6869`, `runCooperativeStop:6929`, `stopDormantSessionImmediately:7045`, `stopUserSessionImmediately:7054`, `persistResumableStoppedSession:7071`, `forgetLiveUserSession:7089`

`cooperativeStops` is read from C2 (`publishCanonicalEvent:8408` — settles the
stop when `turn.completed` for the stop's turn arrives). That single read is a
genuine event-ordering coupling, not a convenience.

### C5 — Internal-stop notification suppression
**Owns exclusively:** `internalStopTurnIds:1279`
**Shares:** nothing.

`consumeInternalStopSuppression:3792` (public), `armInternalStopSuppression:3825`, `rescindInternalStopSuppression:3866`, `reportInternalStopRedispatchFailed:3894`

Four methods, ~50 lines of code under ~90 lines of docblock. Callers: C6
(`1929`+), C17 (`5533`, `5555`), and one external consumer
(`turn-completion-notifications.ts:413`). The smallest self-contained unit in
the file, but too small to be a "slice".

**RESOLVED by slice 4 (#4144):** extracted to `InternalStopSuppression`
(`internal-stop-suppression.ts`) together with C10, deps
`{listActiveTurnFoldEventPayloads, emitRedispatchFailed}`. The service keeps
the public `consumeInternalStopSuppression` forwarder (the one external
consumer's entry point) and routes its internal call sites through
`this.internalStops.*`; the Set and its full station#3525/#3559 rationale
live on the class.

### C6 — Credential-profile recovery
**Owns:** `credentialRecoveryRestartingThreads` (written only in a ctor closure, 1595–1598)
**Shares (writes into 8 other clusters' maps):** `quarantinedThreads`, `sessionAdapters`, `threadProviders`, `sessionReadModel`, `sessionConnectionIds`, `tenantContexts`, `policyThreads`, `flowBoundThreads`, `deltaCoalescer`, `monitoringBridge`

`createRecoveryDispatchAdapter:1747`, `restartCredentialProfileRecoverySession:1784`, `restoreCredentialProfileRecoverySession:1834`, `quarantineCredentialProfileRecoverySession:1859`, `restartCredentialProfileProviderSession:1929`

`quarantineCredentialProfileRecoverySession` (1903–1909) is one of **six
divergent copies** of the "forget a thread" fan-out (see Traps T2).
Extracting C6 requires that fan-out to become a single seam first.

**RESOLVED by slice 7 (#4174) — PARTIAL, boundary defended:** four methods
move to `CredentialProfileRecovery` (`credential-profile-recovery.ts`) as
`createDispatchAdapter`/`restartRecoverySession`/`restoreSession`/
`quarantineSession`, plus one-way ownership of the restart loop-guard set
(zero test references existed repo-wide; now guarded).
`restartCredentialProfileProviderSession` STAYS on the service as the
`restartProviderSession` dep — of its 147 lines the only credential-specific
content is threading the profile ref into the start input; the rest is
generic session-start machinery, and keeping it preserves the only
`sessionConnectionIds` coverage (codex-adapter quota-routing tests) plus the
undefended `threadProviders.set`. The C6a interrupt closure collapsed to one
`interruptRecoveredTurn` dep whose body stays beside the registry. The
quarantine four-step ordering moved verbatim; the divergent teardown flags
are declared at the CTOR seam so the slice-2 source invariant keeps its
six-site single-file pin (verified by replaying its injection post-move).
Disclosed no-test gaps: the restore-path redispatch report (unobservable by
construction — its own comment says the arm is always undefined on boot),
the shared-dispatch-adapter identity (stateless today), and
`threadProviders.set` in the retained C6e.

### C7 — Session read model / inventory / tracking
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** `sessionReadModel:1170`, `threadProviders:1168`, `ephemeralSessionThreads:1176`; co-owns `sessionAdapters:1134`
**Shares:** `turnProgressByThread` (r), `tenantContexts` (rw via `trackSession:8139`), `quarantinedThreads` (r), `sessionAttachmentSettled` (r)

`observeAnswerability:1717`, `listSessions:2428`, `listSessionReadModel:2459`, `listLoadedSessionReadModel:2514`, `listAgentRuns:2521`, `readAgentRun:2593`, `listProjectSessionBoard:2601`, `readSession:2685`, `resolveSessionProjectSlug:3053`, `seedSessionRecord:5622`, `isReadOnlyAttachedSession:5655`, `runtimeKindFor:6322`, `sessionAttributionFor:6364`, `commandProvider:7201`, `trackSession:8124`, `isEphemeralSession:8154`, `isDormantSessionThread:8784`, `readLatestSessionStartMetadata:8807`

`sessionReadModel` is touched by **30 of 180 methods**. It is the file's true
center of gravity and must be the *last* thing extracted, not the first.

### C8 — Tenancy & owner authorization
**Owns:** `sessionOwnerCache:1335`, `sessionOwnerCacheMaxEntries:1336`, `tenantContexts:1184`
**Shares:** `sessionOwnerCache` invalidated/deleted from C17 (`5598`), C14 (`7975`), C2 (`8543`), C16 (`8648`, `8852`); `tenantContexts` written from C6, C12, C14, C7, C16

`sessionOwnerUserId:3560`, `cacheSessionOwner:3623`, `canReadSession:3644`, `validStoredTenantExecutionContext:3681`, `hydratePersistedTenantContexts:3697`, `canReadSessionForCommand:3716`, `canUserReadSession:3748`, `resolveSessionPresenceSubject:3760`

`canReadSession` is the file's most-called private helper (~18 call sites
across C7, C9, C10, C11, C12) — it is a *predicate dependency* of almost
every read cluster, which is why C8 cannot go first despite owning tidy
fields.

**RESOLVED by slice 6 (#4166):** extracted to `SessionAuthorization`
(`session-authorization.ts`) as the epic's first genuinely ONE-WAY seam —
the cluster calls no service method at all, so both indexes MOVED with it
and no code outside the module can now write either map
(`cacheSessionOwner`'s positive-only invariant is structural). Four narrow
accessors serve the eleven external map sites (`tenantContextFor`,
`bindTenantContext`, `forgetTenantContext`, `invalidateSessionOwner` — the
last returns `Map.delete`'s boolean for C2's telemetry gate); every
already-extracted collaborator's authz dep closure now targets
`sessionAuthz.*`, except `SessionEventReads`' `canUserReadSession` dep,
which deliberately keeps the PUBLIC forwarder (its `initialize()` latch is
part of the contract). Two service forwarders remain
(`canUserReadSession`, `resolveSessionPresenceSubject`) carrying the T9
latches; `sessionOwnerUserId` widened from private for its one
out-of-cluster caller. The slice-2 seam fixture re-points its two moved
maps through `sessionAuthz`; the source-invariant test needed no edit.
Guard fixtures added for the personal ownerless presence fallback and the
cold-hosted hydrate-before-authz ordering (plan I10/I11); the
`canUserReadSession` latch (I12) is behaviorally unobservable and remains
the standing disclosed T9 gap.

### C9 — Event paging & stream replay
**Owns:** nothing.
**Shares:** `sessionReadModel` (r), `turnProgressByThread` (r), `tenantContexts` (w, via `hydratePersistedTenantContexts`)

`readRequestOutcome:3110`, `readSessionEventPage:3136`, `readSessionEventWindow:3186`, `readConversationEventWindow:3254`, `readEventStreamHead:3348`, `readEventGlobalSequence:3359`, `readEventStreamReplay:3376`, `readEventStreamReplayPlan:3392`

**RESOLVED by slice 5 (#4155):** extracted to `SessionEventReads`
(`session-event-reads.ts`) with `eventWindowSessionSummary`. The named trap
held: `readSessionEventPage`'s discarded-looking `await listSessions(...)`
is preserved as a dep closure over the real service method, and is now
pinned by a fixture that seeds a session on the ADAPTER only (deleting the
call reds it — no prior test noticed). `hydratePersistedTenantContexts`
(the cluster's one write, into C8's `tenantContexts`) stays a closure —
over the service's live method at the time; over
`sessionAuthz.hydratePersistedTenantContexts` since slice 6 moved C8. Disclosed gaps on the PR: hosted
hydrate-before-authz ordering and the replay `canUserReadSession` filter
have no service-level test.

`readEventStreamHead/GlobalSequence/Replay/ReplayPlan` (3348–3411) touch
**zero fields** — pure `eventStore` + `canUserReadSession`.
`readSessionEventPage:3143` calls `await this.listSessions(INTERNAL)`, which
side-effects C7's four maps via `trackSession`; that hidden write is why C9 is
not the recommendation.

### C10 — Transcript read, search, usage
**Owns:** nothing. **Shares:** nothing directly (all field access is
transitive through `canReadSession`, `isEphemeralSession`,
`sessionAttributionFor`).

`readSessionMessages:3419`, `searchSessionMessages:3439`, `readSessionUsage:3489`, `listSessionUsage:3516`

**RESOLVED by slice 4 (#4144):** extracted to `SessionTranscriptReads`
(`session-transcript-reads.ts`) — zero owned fields confirmed; all four
service methods are now flat same-named forwarders that keep `initialize()`
(T9) and their exact arities (the test Proxy injects read authority by
method name and position — T3). `messageSearchExcerpt` moved with
`searchSessionMessages` and is re-exported from the service.

### C11 — Conversation lineage, handoff, history
**Owns:** nothing. **Shares:** `turnDeduplicator` (r, 2985 — shared with C12), `conversationHistoryReader` (private to C11)

`resolveConversationContinuation:2741`, `currentConversationSessionId:2819`, `readCurrentConversationSession:2830`, `reservedConversationHandoff:2840`, `prepareConversationHandoff:2851`, `readConversationHandoffStatus:2950`, `readConversationTranscriptMessages:3032`, `readSessionConversation:3913`, `appendConversationFork:3964`, `readConversationForkProvenance:3969`, `listSessionConversations:3980`, `listAllSessionConversations:4022`, `listConversationHistoryPage:4087`

**RESOLVED by slice 5 (#4155):** extracted to `ConversationLineage`
(`conversation-lineage.ts`) with its module helpers
(`continuationLaunchContext`, `continuationTranscriptSeed`,
`observeConversationContinuation`) and both constants. Own-nothing claim
verified with two qualifications recorded in the module docblock: durable
event-store writes move with the code, and transitive map writes flow
through the deps closures over the real service methods.
`conversationHistoryReader` and `turnDeduplicator` STAY service fields,
passed by value after their ctor assignments (constructing the collaborator
earlier would silently capture `undefined` — noted at the ctor).
`readConversationTranscriptMessages` stays module-private with no service
forwarder. Follow-up on the epic: moving the `ConversationHistoryReadService`
construction into the collaborator was deliberately deferred.

### C12 — Command dispatch spine
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** `startingSessionThreads:1280` (claim/release closures at 4147–4151)
**Shares:** `sessionCommands`, `sessionCommandImplementation`, `sessionExecutionCoordinator`, `clientOriginTurns`, `monitoringBridge`, `turnDeduplicator`, `quarantinedThreads`, `sessionReadModel`, `tenantContexts`, `threadProviders`, `ephemeralSessionThreads`, `sessionConnectionIds`, `sessionAdapters`

`createSessionCommandImplementation:4102` (287 lines of closures over `this`), `startSessionInternal:4406`, `dispatch:4418`, `dispatchWithReceipt:4454` (**857 lines**; switch arms at `adoptSession:4591`, `sendTurn:4599`, `interruptTurn:5045`, `steerTurn:5105`, `respondToRequest:5235`, `stopSession:5252`), `readCommandReceipt:5602`, `listCommandReceipts:5613`, `sessionLogger:5797`, `warnBestEffort:7404`, `commandThreadId:7433`, `persistReceipt:8120`

### C13 — Model launch plan & selector validation
**Owns:** nothing. **Shares:** `sessionReadModel` (r, 7310 only).

`validateConnectedCliModelSelector:7221`, `validateConnectedCliTurnModelSelector:7268`, `withAcceptedModelLaunchPlan:7310`, `assertAcceptedModelLaunchPlan:7354`, `recordAcceptedModelLaunchPlan:7382`, `modelLaunchPlanFromInput:7415`, `modelLaunchRequestedOverrideFromInput:7425`

**RESOLVED by slice 8 (#4179):** extracted to `ModelLaunchPlanning`
(`model-launch-planning.ts`) — the epic's strictest one-way seam: the
cluster calls NO service method and reads exactly one read-model cell
through its single dep (`loadedSessionModel`, now guard-pinned). Six
module-level free functions/constants moved with it
(`listLaunchableAdapterModels`, `knownModelsCatalog`,
`normalizeOmittedModelId`, `boundedAdapterModels`, both timeout constants)
plus `ModelLaunchPlanUnavailableError` (re-exported from the service). One
private forwarder retained for the T6 reach-in cast, kept alive by C16's
`prepareModelLaunch` closure routing through it (slice-7 asymmetry
precedent). The metrics counter must import from the exact
`'../../telemetry/metrics.js'` specifier the suite mocks — recorded in the
module. C12's inline sendTurn metadata stamp deliberately NOT unified
(different `requestedOverride` derivation).

### C14 — Attached-session adoption
**Owns:** `adoptingSourceThreads:1294`, `adoptionIntents:1295`, `adoptionReconciliation:1299`, `adoptionOwnerId:1112`, `adoptionLedger:1339`
**Shares:** `sessionReadModel` (r), `tenantContexts` (r), and the full 6-map teardown at `clearAbandonedAdoptionMemory:7969`

`adoptAttachedSession:7441`, `performAttachedSessionAdoption:7489`, `findExistingAdoptedChild:7635`, `joinCommittedAdoption:7656`, `isAdoptionIdempotencyConstraint:7683`, `resolveAdoptionContext:7706`, `findAttachedAdoptionSource:7725`, `resolveAdoptionProject:7745`, `requireAdoptionAdapter:7771`, `buildAdoptionContext:7781`, `executeAdoption:7811`, `forkReservedProviderChild:7829`, `commitAdoptedSession:7891`, `validateAdoptedProviderChild:7902`, `buildAdoptedChild:7916`, `rollbackAdoption:7941`, `requireOwnedAdoption:7954`, `requireAdoptionTransition:7961`, `clearAbandonedAdoptionMemory:7969`, `persistAdoptionRollbackState:7983`, `adoptionReservationWasDeleted:8003`, `reconcilePendingAdoptions:8016`, `cleanupAdoptionReservation:8049`, `cleanupReservedFlowRun:8058`, `cleanupReservedProviderChild:8076`, `logAdoptionCleanupFailure:8095`, `publicAdoptedSession:8108`

27 methods, ~700 lines, 5 owned fields — the **largest coherent island** in
the file and the obvious slice 2 or 3, but not slice 1 (see §7).

**RESOLVED by slice 3 (#4143):** extracted to `AttachedSessionAdoption`
(`attached-session-adoption.ts`) — 25 of the 27 methods, `AdoptionContext`,
and the module-global `liveAdoptionOwners` registry (T7) move; the class
owns `ownerId`, `adoptingSourceThreads`, `adoptionIntents`, and
`reconciliation`. Option A holds: `clearAbandonedAdoptionMemory` and
`logAdoptionCleanupFailure` STAY on the service (the teardown source
invariant keeps its 6-sites/1-file shape) reached via
`forgetAbandonedAdoptionMemory`/`logCleanupFailure` dep closures, and the
`adoptionLedger` instance stays on the service (C16's
`evictCollidingAttachedAliases` reads it). `registerOwner()`/
`unregisterOwner()` are wired from `initialize()`/`shutdown()`, never the
constructor — pinned by a source invariant in
`attached-session-adoption.test.ts` after the ctor-registration fault
injection ran green (no runtime probe can distinguish the wirings).
`AdoptionContinuationInProgressError` moved and is re-exported from the
service for its three external importers.

### C15 — Flow run / policy hooks / workflow sidecar
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** `policyThreads:1313`, `pendingPolicyWrites:1315`, `pendingCommandSpools:1321`, `flowBoundThreads:1326`, `readinessBridge:1300`, `commandEvidenceBridge:1301`, `commandEvidenceRoutingPolicy:1303`
**Shares:** `policyThreads`/`flowBoundThreads` deleted by C1 (`6634`), C4 (`7095`), C6 (`1908`), C16 (`8647`)

`readSessionFlowRun:5675`, `readSessionBuilderRun:5707`, `attachSessionEvidence:5761`, `bindExplicitFlowRunToSession:5820`, `enforceFlowCompletionGate:5884`, `bindWorkflowSidecarToSession:5942`, `applyWorkflowSidecarTransition:5982`, `readSessionWorkflowState:6041`, `bindPolicyHooksToSession:6070`, `enforcePolicyStopGate:6109`, `applyPostHocToolPolicies:6160`, `spoolCommandEvidence:6244`, `isFlowBoundThread:6293`, `resolvePolicyCwd:6307`

### C16 — Boot, recovery, materialization
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** `started:1358`, `sessionAttachmentSettled:1376`, `materializingSessions:1290`, `recoveryCoordinator:1305`
**Shares:** every per-thread map, via `recoverSessions:8641–8648` and `evictCollidingAttachedAliases:8847–8852`

`initialize:1625`, `resolveSessionAgentForStart:2075`, `applyAgentCredentialProfileRef:2128`, `recoverSessions:8629`, `recoveredSessionStartOptions:8676`, `materializeRecoveredSession:8740`, `materializeRecoveredSessionOnce:8754`, `evictCollidingAttachedAliases:8819`

### C17 — Connection smoke
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.

**Owns:** nothing. **Shares:** `threadProviders` (r, 5529), `sessionOwnerCache` (w-delete, 5598), plus C5 and C12.
`runConnectionSmoke:5317` — one 284-line public method.

### C18 — Monitoring / usage telemetry
**Owns:** `monitoringUnconfiguredThreads:1357`, `monitoringBridge:1340`, `usageTelemetry:1111`
`setUsageTelemetry:1621`, `monitoringContextFor:6329`

**RESOLVED by inspection (slice 8, #4179) — NO EXTRACTION.** C18's
behavior was already extracted before the epic began:
`OrchestrationMonitoringBridge` (`orchestration-monitoring-bridge.ts`, own
test file, own `turns` map) IS the cluster, and it is already a shared dep
target of C6 (`onTurnDispatched`), C12, and C2. What remains on the
service is ~30 lines of glue in four disjoint regions — the three fields,
the ctor bridge wiring, the public late-bound `setUsageTelemetry` setter
(one runtime caller), and
`monitoringContextFor`, the bridge's own dep closure (T4: its single
PRODUCTION reference is the bridge ctor argument; slice 8's G4 fixture
also reaches it and the log-once Set by test cast). `usageTelemetry`'s two reads
belong to C16 and C2; a holder object would add indirection and make
nothing unreachable. Folding `monitoringContextFor` + its log-once Set
INTO the bridge is a legitimate ~25-line follow-up but changes the
bridge's public ctor signature (nine construction sites plus an arity
assertion, all in `orchestration-monitoring-bridge.test.ts`, plus the one
production site — and, since slice 8's G4 fixture, the fold would also
re-point G4's reach-ins) for no seam-count reduction — deferred,
explicitly not a slice.
Gap closed in passing: the log-once dedupe had zero coverage repo-wide;
slice 8 adds a fixture pinning log-once + the re-arm delete.

---

## 3. Shared-field matrix (the danger surface)
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.


Fields touched by ≥2 clusters, ordered by blast radius. This table is the
reason a mechanical cut is unsafe.

| Field | Clusters touching | Readers | Writes | Write sites |
|---|---|---|---|---|
| `sessionReadModel` | C1 C2 C4 C6 C7 C9 C12 C13 C14 C16 | 30 | 7 | 1905, 6631, 7085, 7092, 7971, 8644, 8847 | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)* *(slice 8: C13's read routes through `ModelLaunchPlanning`'s `loadedSessionModel` dep)*
| `tenantContexts` | C1 C4 C6 C7 C8 C9 C12 C14 C16 | 14 | 10 | 1907, 3702, 3707, 4180, 6633, 7094, 7974, 8139, 8646, 8851 | *(RESOLVED slice 6: the map moved into `SessionAuthorization`; no cluster outside `session-authorization.ts` can write it — the historic write sites route through `bindTenantContext`/`forgetTenantContext`)*
| `sessionAdapters` | C1 C2 C4 C6 C7 C12 C14 C16 | 14 | 9 | 1903, 6447, 6452, 6629, 7090, 7970, 8132, 8642, 8848 | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)*
| `threadProviders` | C1 C2 C4 C6 C7 C12 C14 C16 C17 | 13 | 8 | 1904, 1951, 6630, 7091, 7973, 8431, 8643, 8849 | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)*
| `sessionOwnerCache` | C2 C8 C14 C16 C17 | 7 | 10 | 3566/3567, 3624/3625/3629, 5598, 7975, 8543, 8648, 8852 | *(RESOLVED slice 6: moved; cross-cluster invalidations route through `invalidateSessionOwner`)*
| `quarantinedThreads` | C2 C6 C7 C12 C16 | 9 | 3 | 1875 (add), 8418 (delete), 8641 (add) | *(slice 7: the `add` moved into `CredentialProfileRecovery.quarantineSession` via the `markThreadQuarantined` dep — the ONE raw foreign write that stayed raw by design)*
| `sessionConnectionIds` | C1 C4 C6 C12 C14 C16 | 8 | 8 | 1906, 4177, 6632, 7093, 7972, 8645, 8659, 8850 | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)*
| `policyThreads` | C1 C4 C6 C15 C16 | 6 | 6 | 1908, 6082, 6318, 6634, 7095, 8647 | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)*
| **`turnProgressByThread`** | **C3 (writes) + C7/C9 (reads only)** | 9 | **3, all in C3** | 8368, 8385, 8395 |
| **`turnStallWindowByThread`** | **C3 (owner) + C16 set + C4 delete** | 4 | 2 | 2098, 7098 |
| **`turnStallWatchdog`** | **C3 (owner) + C1 clearAll + C4 clear** | 3 | — | 2294, 7096, 8325 |
| `flowBoundThreads` | C1 C6 C15 | 3 | 3 | 1909, 6303, 6635 | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)*
| `deltaCoalescer` | C1 C2 C6 C16 | 4 | — | — | *(slice 7: C6's writes to this field now route through the slice-2 seam or stay in the retained `restartProviderSession`; the moved module touches it only via named deps — see the C6 RESOLVED note)*
| `clientOriginTurns` | C2 C12 | 3 | — | — |
| `turnDeduplicator` | C11 C12 | 3 | — | — |
| `ephemeralSessionThreads` | C7 C12 | 3 | 2 | 4160, 4163 |
| `sessionExecutionCoordinator` | C2 C12 | 4 | — | — |

Read the bolded group carefully: `turnProgressByThread`,
`turnStallWindowByThread` and `turnStallWatchdog` are the **only** shared
fields in the file with a clean **single-writer / many-reader** split. That
property is what makes C3 mechanically safe to move; nothing else in the
table has it.

---

## 4. Collaborator boundaries already present

Eleven sibling modules are already composed in. The class delegates to them
through closures built in the constructor (1378–1619) or in
`createSessionCommandImplementation` (4102–4389).

| Collaborator | Constructed | Delegating clusters | Seam shape |
|---|---|---|---|
| `SessionExecutionCoordinator` (1113) | ctor 1379, from `eventStore.sessionTurnBoundaryAuthority()` or in-memory fallback | C2 (`.observe` 8294 & 8481), C12 (`dispatchWithReceipt`) | already an object seam; **the only field with a real fallback constructor** |
| `TurnStallWatchdog` (1156) | field initializer, no args | C3 (`.observe` 8325), C1 (`.clearAll` 2294), C4 (`.clear` 7096) | callback-based: `onStall`/`onProgress`/`onClear` passed per-`observe` call at 8346–8354 |
| `ClientOriginTurnPropagation` (1169) | field initializer | C2 (`.apply` 8275, `.clearThread` 8433, `.retire` 8442), C12 | pure, no service back-reference |
| `EventStore` (option) | injected | **all clusters**, 88 dereferences | the single unavoidable shared dependency; `?.`-guarded everywhere |
| `DeltaCoalescer` (1346) | field initializer with `(event) => this.publishCanonicalEvent(event)` | C2 offer/flush, C1 `flushAll` at shutdown 2287, C6 `forgetThread` 1873, C16 `forgetThread` 8640 | **closes over `this` before `options` is assigned** — see T1 |
| `SessionCommandModule` (1107) | `createSessionCommandImplementation:4102` | C12 | 24 named hooks; 7 fields reached via closure |
| `SessionQueryModule` (1109) | ctor 1441–1519 | C11, C7 | 8 hooks; reads `sessionReadModel`, `turnProgressByThread`, `tenantContexts` |
| `SessionLifecycleModule` (1110) | ctor 1389–1440 | C15 (`prepareCompletion` → `enforceFlowCompletionGate` + `enforcePolicyStopGate` + `applyWorkflowSidecarTransition`), C2 (`publish` → `projectAndPublishEvent`) | 10 hooks |
| `SessionRecoveryCoordinator` (1305) | ctor 1583–1605 | C16 (`reconcile`), C1 (`dispose`), C2 (`observe` 8511), C7 (`readSession` 2685) | receives `adapterForProvider`, `isCredentialRestarting`, `onOutcome` closures |
| `CredentialRecoveryModule` (1306) | ctor 1568–1581 | C6 | receives `restoreSession`, `quarantineSession`, `setRestarting` closures |
| `OrchestrationMonitoringBridge` (1340) | ctor 1520 | C18, C2 (`onRuntimeEvent` 8479), C6, C12 | receives `monitoringContextFor` closure |
| `ConversationHistoryReadService` (1337) | ctor 1533–1549 | C11 only | receives `canReadSession`, `loadedSessionForThread`, `observeAnswerability` |
| `AdoptionLedger` (1339) | ctor 1385 | C14, C16 (`evictCollidingAttachedAliases:8829`) | |
| `TurnDeduplicator` (1338) | ctor 1383 | C11, C12 | |
| `FlowReadinessBridge` / `FlowCommandEvidenceBridge` (1300/1301) | ctor 1555–1566 | C15 | |

The established idiom is unambiguous: **collaborator constructed in the ctor,
fed named arrow-function closures back into the service.** Any new extraction
should follow it rather than inventing a different injection style.

---

## 5. External call surface
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.


### 5a. By caller file (non-test), grouped per cluster
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| Caller | Layer | Clusters reached | Methods |
|---|---|---|---|
| `src-server/routes/orchestration/orchestration.ts` | routes | C1 C2 C7 C9 C11 C12 C15 | `listProviders:651`, `getProviderCommands:659`, `getProviderModels:665`, `listSessions:677`, `listSessionReadModel:684,1930,1968`, `listLoadedSessionReadModel:691`, `readConversationHandoffStatus:880`, `listProjectSessionBoard:1192`, `sessionLifecycles:1208`, `listAgentRuns:1224`, `readAgentRun:1231`, `listCommandReceipts:1243`, `sessionQueries:1245,1484,1502`, `readCommandReceipt:1251`, `readSessionFlowRun:1268`, `readSessionBuilderRun:1398`, `readSession:1415,1526`, `readSessionEventPage:1436`, `readSessionEventWindow:1456`, `readConversationEventWindow:1472`, `dispatchWithReceipt:1648`, `readEventGlobalSequence:1862`, `readEventStreamHead:1873,1931,1976`, `readEventStreamReplayPlan:1887,1918`, `readEventStreamReplay:1938`, `replayTurnProvenanceSidecar:1949` |
| `src-server/runtime/routes/runtime-routes.ts` | routes (runtime) | C1 C7 C8 C12 C15 | `supportsReadOnlyReview:2085`, `settleProviderAdapterRetirements:1051,1108`, `sessionQueries:642,1245`, `canUserReadSession:783`, `readSessionFlowRun:1198`, `readSession:1325,1461`, `dispatchWithReceipt:1339`, `listSessions:1891` |
| `src-server/tools/station-control-delegation.ts` | tools | C1 C7 C9 C11 C12 | `startSessionInternal:3103`, `sessionCommands:2810`, `readSession:1540,2803,2962,2969,3259,3267`, `readCurrentConversationSession:1687,1689`, `readSessionEventPage:2174,2361`, `listSessionReadModel:2265`, `dispatchWithReceipt:2605,2675,2861,3130`, `getProviderAdapter:2763,2957`, `currentConversationSessionId:2968,3264`, `reservedConversationHandoff:2979,3277`, `resolveConversationContinuation:3038,3043`, `prepareConversationHandoff:3055`, `readConversationHandoffStatus:3078` |
| `src-server/runtime/bootstrap/runtime-initialize.ts` | bootstrap | C16 | `new OrchestrationService(...)`, `initialize:474,549` |
| `src-server/runtime/bootstrap/runtime-shutdown.ts` | bootstrap | C1 | `shutdown:105,106` |
| `src-server/runtime/bootstrap/station-runtime.ts` | bootstrap | C7 C10 C17 C18 | `setUsageTelemetry:2953`, `runConnectionSmoke:2885`, `listSessionUsage:2780`, `listSessionReadModel:2900`, `sessionQueries:2901`, `readSessionMessages:965` |
| `src-server/routes/chat/conversations.ts` | routes | **C10 C11** | structural interface (`sessionMessageReader` / `sessionConversationReader`) declaring `readSessionMessages:179`, `readSessionUsage:190`, `listConversationHistoryPage:194`, `readSessionConversation:202`, `searchSessionMessages:216`, `readConversationForkProvenance:345`, `appendConversationFork:342` |
| `src-server/services/share/answer-share-service.ts` | service | C10 | `readSessionMessages:64,499` |
| `src-server/analytics/usage-aggregator.ts` | service | C10 | `listSessionUsage:35,281` |
| `src-server/services/orchestration/run-service.ts` | service | C7 | `listAgentRuns:64,105`, `readAgentRun:124` |
| `src-server/services/approvals/approval-inbox.ts` | service | C7 C9 C12 | `dispatch:161,162,204,205`, `resolveSessionProjectSlug:248`, `readRequestOutcome:265` |
| `src-server/services/projects/attention-projection.ts` | service | C7 C15 | `listSessionReadModel:145`, `readSessionFlowRun:358`, `readSession:399` |
| `src-server/services/projects/task-graph-service.ts` | service | C7 C12 | `dispatch:1974`, `seedSessionRecord:2917` (via `Pick<OrchestrationService, 'dispatch'\|'seedSessionRecord'>`) |
| `src-server/services/orchestration/turn-completion-notifications.ts` | service | **C5 C8** | `resolveSessionPresenceSubject:102`, `consumeInternalStopSuppression:413` |
| `src-server/services/checkpoints/turn-checkpoint-capture.ts` | service | C7 | `resolveSessionProjectSlug:407` |
| `src-server/capabilities/station-intent-bindings.ts` | capabilities | C7 C12 | `readSession:181,199`, `dispatch:205` |
| `src-server/services/evidence/orchestration-review-executor.ts` | service | C9 | `OrchestrationService['readSessionEventPage']` type only |
| `src-server/routes/plugins/plugin-lifecycle-routes.ts` | routes | C1 | `settleProviderAdapterRetirements` (structural, `:55`) |

### 5b. External blast radius per cluster
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| Cluster | External caller files | Verdict |
|---|---|---|
| **C3 turn-stall/progress** | **0** | fully private |
| **C5 internal-stop suppression** | 1 (`turn-completion-notifications.ts`) | near-private |
| C13 model launch plan | 0 | private, but structurally inside C12's start path |
| C14 adoption | 0 (reached only via `dispatch{type:'adoptSession'}`) | private behind the command switch |
| C17 smoke | 1 (`station-runtime.ts`) | narrow |
| C10 transcript/search/usage | 4 (`conversations.ts`, `answer-share-service.ts`, `usage-aggregator.ts`, `station-runtime.ts`) — **all already structurally typed** | narrow, pre-interfaced |
| C9 paging/replay | 3 | moderate |
| C11 conversation/handoff | 3 | moderate |
| C15 flow/policy | 3 | moderate |
| C8 tenancy | 2 public entry points, but ~18 in-file callers of `canReadSession` | wide *internally* |
| C1 adapter lifecycle | 4 | moderate |
| C7 read model | 8 | wide |
| C12 dispatch | 7 | wide |

**Layer reach summary:** routes reach C1/C7/C8/C9/C10/C11/C12/C15; runtime
bootstrap reaches C1/C7/C10/C16/C17/C18; tools reach C1/C7/C9/C11/C12.
**Nothing outside the file reaches C3, C13, C14, or C16's internals.**

---

## 6. Test topology
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.


### 6a. `__tests__/orchestration-service.test.ts` — 17,219 lines, 317 static `test(`/`it(` call sites (vitest reports 349 cases — `test.each` expands), 16 describe blocks
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| describe | Range | Cluster(s) | Self-contained? |
|---|---|---|---|
| `'OrchestrationService'` | 701–16925 | **everything** — 210 bare top-level `test()` calls | no |
| `'content delta coalescing at the publish seam (station#3350)'` | 2886–3231 | C2 (+2 C3 crossovers at 2967, 3145) | mostly |
| **`'turn-stall detection (station#2959)'`** | **3233–3702** | **C3** | **yes — 6 tests, no other cluster's asserts** |
| `'station#1885 — station-agent image attachments'` | 7293–7429 | C12 | yes |
| `'sendTurn client-turn idempotency (station#1224 offline slice 2)'` | 7431–7957 | C12 + `turnDeduplicator` | yes |
| `'resolveStartSessionCwd migration shadow (station#1501 slice 3a)'` | 8281–8651 | C12 start path (free function) | yes |
| `'a restored session with no engine still answers the engine-free commands'` | 12510–12688 | C16 + C4 | yes |
| **`'session-owner cache (station#1120)'`** | **14310–14583** | **C8** | **yes — 5 tests** |
| `'Flow-gated sessions'` | 14827–15768 | C15 | yes |
| `'Flow Agents policy enforcement (S3)'` | 15770–16052 | C15 | yes |
| `'Durable workflow sidecars (S3 item 2)'` | 16054–16924 | C15 | yes |
| `'OrchestrationService — session lifecycle logger correlation'` | 16929–17028 | C12/C15 | yes |
| `'OrchestrationService — agent-pinned credential profile'` | 17035–17219 | C6/C16 | yes |

The remaining ~210 tests sit **flat** under the top-level describe.
Approximate contiguous topical bands (titles only, for planning):

| Band | Cluster | Notes |
|---|---|---|
| 764–1450 | C12 start/receipt | |
| 1528–1809 | C2 telemetry | reached by cast |
| 1840–2180 | C8 tenancy | |
| 2190–2828 | C4 stop/interrupt | 11 tests, contiguous |
| 3704–4810 | C6 credential recovery | ~15 tests |
| 4825–5905 | C13 model launch plan | ~12 tests |
| **5943–6494** | **C10 messages/search/usage** | **10 tests, fully contiguous** |
| 6595–6925 | C11 conversation identity | |
| 7020–7290 | C12 relay/attachments | |
| 7959–9255 | C12 cwd + agent resolution | |
| 9331–10240 | C14 adoption | ~12 tests |
| 10271–10620 | C1 adapter replacement/shutdown | ~8 tests |
| 10625–11620 | C17 smoke | ~15 tests |
| 11716–12400 | C1 provider/model inventory | |
| 12690–13000 | C16 recovery | |
| 13070–13580 | C4 stop-through-error, C12 steer | |
| 13736–14290 | C7 read model + C9 paging | |
| 14585–14800 | C7 board/agent runs | |

### 6b. Other test files exercising the service
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| File | Lines | Constructions | Clusters exercised |
|---|---|---|---|
| `__tests__/orphan-request-reconciliation.test.ts` | 1,864 | 17 | C7 C9 C11 C15 (own facade list at 113–117) |
| `__tests__/session-answerability-decoration.test.ts` | 567 | 1 | C7 + C16 |
| `__tests__/turn-completion-notifications.test.ts` | 952 | 0 (doubles) | **C5**, C8 |
| `__tests__/adapter-delta-coalescing.test.ts` | 270 | 0 | C2 |
| `__tests__/orchestration-monitoring-bridge.test.ts` | — | 0 | C18 |
| `__tests__/orchestration-source-invariants.test.ts` | — | 0 | **repo-wide source scan; pins `orchestration-service.ts` by name** |
| `routes/orchestration/__tests__/orchestration.routes.test.ts` | 4,631 | 2 | C7 C9 C11 C12 |
| `routes/orchestration/__tests__/events.routes.test.ts` | 1,004 | 1 | C2 C8 C9 |
| `routes/orchestration/__tests__/conversation-handoff.qualification.test.ts` | 581 | 2 | **C11** |
| `routes/orchestration/__tests__/conversation-agreement.qualification.test.ts` | 654 | 4 | C11 |
| `services/projects/__tests__/task-graph-service.test.ts` | — | 1 | C12 |
| `routes/plugins/__tests__/plugin-loader.test.ts` | — | 1 | C1 |
| `providers/__tests__/codex-adapter.test.ts` | — | 2 | C2 C4 |
| `services/approvals/__tests__/approval-inbox.test.ts` | — | 0 (doubles) | C7 C9 C12 |
| `__test-utils__/orchestration-gate-test-harness.ts` | 91 | — | shared harness naming the service |

**Most self-contained cluster tests:** C3 (one 470-line describe, 6 tests, no
external caller to re-point) > C8 owner cache > C10 > C15.

---

## 7. First-extraction recommendation
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.


### ★ Recommended: **C3 — turn progress & turn-stall observation** → `TurnProgressTracker`
> *Superseded — see Part II (re-derived at `71699b7c1`).*

| Criterion | C3 |
|---|---|
| (a) shared fields | 3 owned fields, **all writes internal**; only 1 shared field read (`sessionAdapters`, read-only, one call site) |
| (b) external callers | **zero** — no file outside `orchestration-service.ts` names any C3 method or field |
| (c) test containment | one contiguous `describe` at **3233–3702** (470 lines, 6 tests) that moves wholesale |

**Fields that move:** `turnStallWatchdog:1156`,
`turnStallWindowByThread:1158`, `turnProgressByThread:1164` (+ docblocks
1150–1167).

**Methods that move:**

| Method | Lines | Size |
|---|---|---|
| `resolveTurnStallWindowMsForAgent` | 2171–2187 | 17 |
| `handleTurnStall` | 7109–7141 | 33 |
| `observeTurnProgress` | 8324–8356 | 33 |
| `publishTurnProgressSilence` | 8359–8378 | 20 |
| `recordTurnProgress` | 8380–8386 | 7 |
| `clearTurnProgressObservation` | 8389–8398 | 10 |
| `publishTurnProgressProjectionChange` | 8400–8405 | 6 |

**Interface** (matching the file's collaborator idiom — construct in the
ctor, feed closures back):

```ts
class TurnProgressTracker {
  constructor(deps: {
    providerForThread: (threadId: string) => ProviderKind | undefined;
    resolveWindowMsForAgent: (agentSlug?: string) => Promise<number>;
    publishProjectionChange: (threadId: string) => void;
    logger: { warn(msg, meta?): void };
  });
  observe(event: CanonicalRuntimeEvent): void;       // <- observeTurnProgress
  read(threadId: string): TurnProgressObservation | undefined;
  setWindow(threadId: string, agentSlug?: string): Promise<void>;
  forgetThread(threadId: string): void;              // watchdog.clear + progress clear + window delete
  dispose(): void;                                   // watchdog.clearAll
}
```

**Cross-cluster call sites needing a seam — exactly 11:**

| # | Line | Current | Becomes | Cluster |
|---|---|---|---|---|
| 1 | 1459 | `this.turnProgressByThread.get(...)` (sessionQueries closure) | `this.turnProgress.read(...)` | ctor/C11 |
| 2 | 2098 | `this.turnStallWindowByThread.set(...)` | `await this.turnProgress.setWindow(...)` | C16 |
| 3 | 2294 | `this.turnStallWatchdog.clearAll()` | `this.turnProgress.dispose()` | C1 `shutdown` |
| 4 | 2503 | `.get(threadId)` | `.read(threadId)` | C7 `listSessionReadModel` |
| 5 | 2718 | `.get(threadId)` | `.read(threadId)` | C7 `readSession` |
| 6 | 3170 | `.get(threadId)` | `.read(threadId)` | C9 `readSessionEventPage` |
| 7 | 3222 | `.get(threadId)` | `.read(threadId)` | C9 `readSessionEventWindow` |
| 8–10 | 7096–7098 | `watchdog.clear` + progress clear + window delete | `this.turnProgress.forgetThread(threadId)` | C4 `forgetLiveUserSession` |
| 11 | 8294 & 8430 | `this.observeTurnProgress(event)` | `this.turnProgress.observe(event)` | C2 (two sites, one semantic seam) |

**Test disposition (revised at implementation, slice-1 PR):** the
`describe('turn-stall detection (station#2959)')` block (3233–3702; tests at
3234, 3377, 3468, 3542, 3618, 3655) STAYS in the service suite — it
exercises the seam through the service, which is exactly what a strangler
slice must keep proving, and moving it would have dragged the shared
harness. The module's own obligations the service suite cannot see
(`forgetThread` clearing the pinned window; `dispose` cancelling armed
watches) are pinned by the new `__tests__/turn-progress-tracker.test.ts`
instead, restoring the one-unit-test-per-collaborator convention.
**Test blocks edited in place:** 2967 and 3145–3175 inside the delta-coalescing
describe reach `turnStallWatchdog` via cast to spy on `observe`; they become
`service.turnProgress` reach-ins. **This is the one required test edit and it
is planned, not discovered.**

**Bonus finding the extraction must carry, not "fix":** `handleTurnStall:7109`
is **observe-only**. Its docblock (7102–7107) and
`interruptUserTurnCooperatively`'s (6728–6733) both assert stall detection
calls the interrupt with `'stall'`. It does not — the only two callers of
`interruptUserTurnCooperatively` are `dispatchWithReceipt:5097` and
`dispatchDeferredInterrupt:6816`, both `initiatedBy: 'user'`. The literal `'stall'`
arms (6873, 6934, 7027; 7000/7017 are `initiatedBy` pass-throughs) are
**unreachable dead code held for a follow-up**. C3 → C4 is a *documentation* dependency, not a code one.

### Second-best: **C10 — transcript read / search / usage**
> *Superseded — see Part II (re-derived at `71699b7c1`).*

Owns zero fields; four external callers already structurally typed; tests
contiguous at 5943–6494. Loses because: (1) it moves no state, so it proves
nothing about cutting shared mutable maps — the epic's actual risk; (2) its
dependencies point the wrong way (all four methods need `canReadSession` (C8),
`isEphemeralSession`/`sessionAttributionFor` (C7)), making C8 the real slice;
(3) its 10 tests are contiguous but ungrouped; (4) four external caller files
vs. zero.

### Honourable mentions (not slice 1)
> *Superseded — see Part II (re-derived at `71699b7c1`).*

- **C14 adoption** (27 methods, 5 owned fields, ~700 lines, zero direct
  external callers) — the biggest single win available, but
  `clearAbandonedAdoptionMemory:7969` writes six other clusters' maps and
  `performAttachedSessionAdoption:7489` shares `adoptionReconciliation` with
  `initialize:1625`. Sequence **after** the teardown fan-out (T2) is unified.
  *(Done as slice 3, after T2 resolved in slice 2 — both couplings became
  dep closures: the teardown stay via `forgetAbandonedAdoptionMemory`, the
  reconciliation handshake via `startReconciliation()`.)*
- **C5 internal-stop suppression** — cleanest island by ownership but ~50
  lines; too small to validate the approach.

---

## 8. Traps — what would make a mechanical extraction lie
> **SUPERSEDED for the core arc** — re-derived at `71699b7c1` in Part II below (#4186). The RESOLVED notes in this Part remain authoritative; the owns/shares/method data here is anchored at `9ac5185b0` and is historical.


**T1 — `deltaCoalescer`'s field initializer captures `this` before `options`
> *Superseded — see Part II (re-derived at `71699b7c1`).*
exists.** Lines 1346–1356: the initializer passes
`(event) => this.publishCanonicalEvent(event)` and reads `this.options.logger`
*lazily*, with an in-source comment explaining why (field initializers run
before constructor parameter properties are assigned). Converting a field
initializer into ctor-body construction, or reordering initialization, can
reintroduce the failure. `turnStallWatchdog:1156` and
`clientOriginTurns:1169` are also field initializers (argument-free, currently
safe).

**T2 — Six divergent copies of the per-thread teardown fan-out.** There is no
> *Superseded — see Part II (re-derived at `71699b7c1`).*
single "forget this thread"; there are six, each clearing a different subset:

| Site | Method | Maps cleared |
|---|---|---|
| 1903–1909 | `quarantineCredentialProfileRecoverySession` | adapters, providers, readModel, connIds, tenants, policy, flowBound (+ coalescer forget 1871, quarantine add 1875) |
| 6629–6635 | `finalizeStoppedAdapterSessions` | adapters, providers, readModel, connIds, tenants, policy, flowBound |
| 7090–7098 | `forgetLiveUserSession` | adapters, providers, readModel, connIds, tenants, policy, **watchdog, progress, window** |
| 7970–7975 | `clearAbandonedAdoptionMemory` | adapters, providers, readModel, connIds, tenants, **ownerCache** |
| 8640–8648 | `recoverSessions.quarantineSession` | coalescer, quarantined, adapters, providers, readModel, connIds, tenants, policy, **ownerCache** |
| 8847–8852 | `evictCollidingAttachedAliases` | readModel, adapters, providers, connIds, tenants, ownerCache (+ `eventStore.deleteThread`) |

No two are identical. Moving any per-thread map into a sub-service without
first unifying these means picking one copy's subset and silently changing
the other five. **This is the single largest correctness hazard in the
decomposition** — and C3 appears in exactly one of the six (7096–7098), where
it can be swapped for one `forgetThread()` call with no subset ambiguity.

(The table above predates slice 1: its line references drifted ~20 lines by
the time slice 2 landed, and row 3's "watchdog, progress, window" became one
`turnProgress.forgetThread` call when C3 was extracted. Kept as the
historical record of the divergence; the live truth is the seam docblock.)

**RESOLVED by slice 2 (#4131):** all six sites now route through one
`forgetThreadState(threadId, divergent)` seam — the five universal maps
clear unconditionally, the divergent aspects (`policyThreads`,
`flowBoundThreads`, `ownerCache`, `turnProgress`) are named flags each site
declares, with the subset table in the seam's docblock. Three guards hold
it: the suite's existing tenancy test discriminates core-map drops; a
per-flag contract block pins the seam's own wiring both directions; and a
source-invariant test derives every call site's declared subset from the
source and compares it to the table, so a site changing its subset must
change the table in the same diff. Converging a subset is now a reviewed
one-line flag change — C14 and the other per-thread-map clusters are
unblocked.

**T3 — The test suite wraps the service in a `Proxy` that rebinds every
> *Superseded — see Part II (re-derived at `71699b7c1`).*
method.** `orchestration-service.test.ts:603–694` (`internalObserver()`)
returns non-function properties raw, binds every function, and **injects
`INTERNAL_SESSION_READ_SCOPE` as argument 0 or 1 for 20 named methods**
(`firstScope`/`secondScope` sets at 607–630). Consequences: (1) an extracted
cluster exposed as a sub-object bypasses the authority injection — the facade
must keep flat same-named methods for anything in those sets; (2) the
`Omit<RawOrchestrationService, …>` list at 478–503 and the two scope sets are
hand-maintained method-name lists (only the `Omit` is type-checked); (3)
`orphan-request-reconciliation.test.ts:113–117` maintains an independent
second copy.

**T4 — Methods reachable only as callbacks (no textual call site to grep):**
> *Superseded — see Part II (re-derived at `71699b7c1`).*
`handleTurnStall` (only `onStall` at 8347), `recordTurnProgress` /
`clearTurnProgressObservation` (only `onProgress`/`onClear` at 8349/8352),
`restoreCredentialProfileRecoverySession` /
`quarantineCredentialProfileRecoverySession` (only via
`createCredentialRecoveryModule` closures 1572/1574), `monitoringContextFor`
(bridge ctor 1521), `enforceFlowCompletionGate` / `enforcePolicyStopGate` /
`applyWorkflowSidecarTransition` (only via `sessionLifecycles.prepareCompletion`
1398–1409), `projectAndPublishEvent` (also `sessionLifecycles.publish` 1412),
`publishCanonicalEvent` (also the coalescer flush callback 1347 — its docblock
1341–1345 explains the re-entrancy reason). There is **no `.bind(this)`
anywhere** — all delegation is arrow closures, which survive relocation.

**T5 — Load-bearing event orderings across cluster boundaries** (each
> *Superseded — see Part II (re-derived at `71699b7c1`).*
documented in-source):
- 8408–8415: the C4 cooperative-stop settle runs **before** the quarantine
  gate at 8416, or a stop on a quarantined thread never settles.
- 8430 vs 8290–8296: `observeTurnProgress` is called on the **raw** delta in
  `projectAndPublishEvent` and skipped for the **merged** delta in
  `publishCanonicalEvent` (`isCoalescableDelta` guard). Both call sites and
  the guard must survive any C3 extraction, or progress double/under-counts.
- 8291–8293: the delta-path observe is gated on `!quarantinedThreads.has(...)`
  because it runs before the quarantine gate (comment at 8283–8289: ungated
  it re-arms the watchdog for a retired session).
- 8299–8316: `projectAndPublishEvent` returning `true` means "the coalescer
  *took* it", not "published"; `consumeAdapterEvents:6449` gates four
  downstream behaviours on that boolean.
- 8536–8545: `sessionOwnerCache` invalidation precedes `eventBus.emit` 8546 so
  the SSE subscriber never sees a stale owner.
- 6420–6446: `turnIdentityAnchorForEvents`, **not** `activeTurnIdForEvents`
  (station#3581) — two similar folds, one historically wrong.
- `InternalStopSuppression.arm` (slice 4 moved it out of the service; the
  narrowed read is now the `listActiveTurnFoldEventPayloads` dep closure)
  uses `listEventsByMethods` — not `listEvents` (perf), not
  `listSessionProjectionEvents` (returns the *closed* turn). Three
  near-identical store reads with different semantics.

**T6 — Test private reach-ins by cast, per cluster** (anything moved must
> *Superseded — see Part II (re-derived at `71699b7c1`).*
keep a same-named forwarding member or have these rewritten): C2
`projectAndPublishEvent` ×9 (1719–7578); C3 `turnStallWatchdog` +
`sessionExecutionCoordinator` spies ×2 (2974, 3151); C4
`pendingTurnInterrupts` (2683); C6 recovery methods ×14 (2292–8834); C7
`sessionAdapters` (3077); C13 `withAcceptedModelLaunchPlan` (test ~6175 post-drift; slice 8 pins the retained forwarder arity); C15
`isFlowBoundThread`/`resolvePolicyCwd` (10121); C16
`recoveryCoordinator.options.onOutcome` (1689); C18 bridge hooks (4727,
4802; slice 8's G4 adds test casts to `monitoringContextFor` and
`monitoringUnconfiguredThreads`). `vi.spyOn` on the service appears exactly once (1423,
`sessionCommands.execute`).

**T7 — Process-global registration:** `liveAdoptionOwners.add(adoptionOwnerId)`
> *Superseded — see Part II (re-derived at `71699b7c1`).*
at 1629 (`initialize`) / `.delete` at 2334 (`shutdown`) is module-global;
the test file constructs the service 126 times in one process. Extraction
must not disturb initialize/shutdown ordering. *(Slice 3 kept the
ordering: the registry now lives in `attached-session-adoption.ts`, and the
initialize/shutdown wiring is pinned by that file's source-invariant
test.)*

**T8 — `orchestration-source-invariants.test.ts` pins this file path** in
> *Superseded — see Part II (re-derived at `71699b7c1`).*
`SCANNED_ROOTS`. New sibling files are fine; renaming/deleting
`orchestration-service.ts` reds the gate, and new files must not reintroduce
the retired identifiers or the `lifecycleState ?? 'running'` fold copy.

**T9 — `initialize()` is a lazy one-shot latch called from ~20 public
> *Superseded — see Part II (re-derived at `71699b7c1`).*
methods** and kicks off recovery **without awaiting**
(`sessionAttachmentSettled` set in a `.finally` even on failure, 1661–1683).
Any facade method that moves out must keep its `this.initialize()` call, or
boot ordering silently changes for whichever consumer reaches the service
first.

---

# Part II — Core re-derivation at `71699b7c1` (#4186)

Derived fresh over the post-slice-8 file, by grep against that checkout —
nothing below is carried from Part I. Conventions: method spans quoted as
`start–end` include the trailing blank separator, so a derived line COUNT
can read one higher than the body-exact count; T13/coupling references cite
the ARGUMENT line where a Map is handed over (the call expression opens 1–2
lines above). **File:** 7,148 lines (the ten
extractions removed ~2,700; slice-independent work added back ~900, most
visibly `consumeInterruptedTurnBoundaries:6752–6897` and the
`inFlightSteers` steer-serialization block at 1068–1092). Class body
`1001–7118`; **133 methods + 1 ctor** (77 private); **51 declared fields**;
`this.options.*` dereferenced 158× (`eventStore` 59, `adapterRegistry` 26).

## II.1 Field inventory (remaining core)

### II.1a Mutable collections — 22 (was 29)

| Line | Field | Kind | Semantics | Owner | Refs | Mediated by an existing seam? |
|---|---|---|---|---|---|---|
| 1008 | `consumedAdapterEventStreams` | WeakSet | adapters whose event stream has been consumed once | C1 | 3 | — |
| 1010 | `activeEventAdapters` | Map | provider → adapter currently streaming | C1 | 4 | — |
| 1014 | `adapterEventControllers` | Map | adapter → its stream `AbortController` | C1 | 7 | — |
| 1018 | `adapterRetirements` | Set | in-flight deadline-bounded retirement promises | C1 | 2 | — |
| 1019 | `adapterRetirementByAdapter` | Map | adapter → its single retirement task | C1 | 9 | — |
| 1023 | `retiredSessionsByAdapter` | Map | adapter → sessions captured at retirement | C1 | 5 | — |
| 1028 | `sessionAdapters` | Map | thread → the adapter this process holds it on | C7/C2 | 13 | teardown via `forgetThreadState:6086`; read by `TurnProgressTracker` (ctor 1228), `CredentialProfileRecovery` (`sessionAdapterFor`, 1594) |
| 1030 | `cooperativeStops` | Map | one user-stop protocol per thread | C4 | 5 | — |
| 1041 | `pendingTurnInterrupts` | Map | Stop pressed before the turn existed | C4 | 7 | — |
| 1066 | `threadProviders` | Map | thread → provider kind | C7/C2 | 15 | teardown via `forgetThreadState:6087`; read by `CredentialProfileRecovery` (`providerForThread`, 1597) |
| 1092 | `inFlightSteers` | Set | NEW since the derivation (station#4075 F2): is a steer command in flight for this thread at all | C12 | 3 | — |
| 1093 | `sessionReadModel` | Map | in-memory live session inventory | C7 | 32 | teardown via `forgetThreadState:6088`; read through SIX ctor dep closures (1224, 1264, 1325, 1429, 1536, 1596) |
| 1099 | `ephemeralSessionThreads` | Set | webhook threads excluded from inventories | C7 | 4 | — |
| 1105 | `sessionConnectionIds` | Map | thread → quota-routing connection identity | C12/C16 | 5 | teardown via `forgetThreadState:6089` |
| 1106 | `quarantinedThreads` | Set | threads whose events are dropped except `session.exited` | C2/C16 | 10 | the C6 `add` routes through the ctor's `markThreadQuarantined` closure (1591–1593) — the ONE raw foreign write kept raw by design |
| 1114 | `startingSessionThreads` | Set | concurrent-start claim per thread | C12 | 3 | — (both writes in one closure, 3013–3018) |
| 1124 | `materializingSessions` | Map | in-flight lazy engine materialisations | C16 | 3 | — |
| 1140 | `policyThreads` | Map | thread → policy workspace cwd / `null` | C15 | 4 | teardown flag on `forgetThreadState:6091` — **C15 has no raw foreign writer at all** |
| 1142 | `pendingPolicyWrites` | Map | `thread:toolCallId` → write target | C15 | 3 | — |
| 1148 | `pendingCommandSpools` | Map | `thread:toolCallId` → captured command evidence | C15 | 3 | — |
| 1153 | `flowBoundThreads` | Map | thread → is flow-bound (cache) | C15 | 3 | teardown flag on `forgetThreadState:6092` |
| 1176 | `monitoringUnconfiguredThreads` | Set | threads already warned about missing config | C18 | 3 | — |

Gone since the derivation (now inside collaborators): `turnStallWindowByThread`,
`turnProgressByThread`, `tenantContexts`, `sessionOwnerCache`,
`internalStopTurnIds`, `adoptingSourceThreads`, `adoptionIntents`,
`credentialRecoveryRestartingThreads`.

### II.1b Mutable scalars — 4 (was 5)

| Line | Field | Semantics | Read/written by |
|---|---|---|---|
| 1006 | `usageTelemetry?` | swappable telemetry observer | `initialize:1652`, `setUsageTelemetry:1663`, `publishCanonicalEvent:6557` |
| 1027 | `adapterRegistryUnsubscribe?` | registry `onChange` teardown | `initialize:1672`, `shutdown:2188/2189` |
| 1177 | `started` | one-shot init latch | `initialize:1667/1668` only |
| 1195 | `sessionAttachmentSettled` | boot attachment pass has *finished* (not succeeded) | `initialize:1724`, `observeAnswerability:1782` |

`adoptionReconciliation` no longer exists — slice 3 moved it; the handshake
is `this.adoption.startReconciliation()` at 1676.

### II.1c Constants & collaborators — 1 constant + 24 collaborators (was 2 + 17)

Epic-built collaborators (ctor construction lines, review-corrected):
`sessionAuthz:1201` (deliberately first; 36 refs — the most-referenced
collaborator), `modelLaunch:1222`, `turnProgress:1226`,
`transcriptReads:1240`, `sessionEventReads:1258`, `internalStops:1275`,
`adoption:1302`, `conversationLineage:1547` (captures `turnDeduplicator`/
`conversationHistoryReader` BY VALUE — ctor comment 1543–1546),
`credentialProfileRecovery:1576` (carries the seam-flag declaration at
1602–1606). Pre-epic collaborators unchanged in kind:
`sessionCommandImplementation:1365` / `sessionCommands:1367`,
`sessionLifecycles:1368`, `sessionQueries:1420`,
`sessionExecutionCoordinator:1289`, `clientOriginTurns:1067` (field
initializer, argument-free), `readinessBridge:1565` /
`commandEvidenceBridge:1571`, `commandEvidenceRoutingPolicy:1131` (the
file's one plain constant), `recoveryCoordinator:1642`,
`credentialRecovery:1629`, `conversationHistoryReader:1525`,
`turnDeduplicator:1293`, `adoptionLedger:1295` (stays for C16's
`evictCollidingAttachedAliases:7097`), `monitoringBridge:1520`,
`deltaCoalescer:1165` (docblock from 1160; field initializer capturing
`this` — T1).

## II.2 Shared-field matrix (the core arc's danger surface)

Two write categories, now load-bearing: a **raw write** is
`this.<map>.set/delete/add` in this file; a **delegated write** hands the Map
itself to a free function in `orchestration-session-state.ts` that writes it
(`trackOrchestrationSession:107/111`,
`resolveOrchestrationAdapterForThread:141/146/153`). See trap T13.

| Field | Remaining clusters | Read sites | Raw writes | Delegated writes | Write-site lines |
|---|---|---|---|---|---|
| `sessionReadModel` | C1 C2 C4 C7 C12 C16 (+C6e, +6 ctor closures) | 28 / 24 methods | **2** | 2 | raw 6039 (C4 `persistResumableStoppedSession`), 6088 (seam); delegated 6272 (C7 `trackSession`), 6533 (C2) |
| `threadProviders` | C2 C7 C12 C16 C17 (+C6e) | 4 | **3** | **8** | raw 1873 (C6e), 6489 (C2), 6087 (seam); delegated 1830, 3493, 3946, 4011, 4189, 4216 + the two track/project sites (6271–6272, 6532–6533 — `trackOrchestrationSession` writes BOTH core maps) |
| `sessionAdapters` | C1 C2 C4 C7 C12 | 9 | **4** | 0 | 5401 (C2 set), 5406 (C2 delete), 6258 (C7), 6086 (seam) |
| `quarantinedThreads` | C2 C7 C12 C16 (+ctor C6 closure) | 7 | **3** | 0 | 1592 (ctor→C6), 6476 (C2 delete), 6910 (C16 add) |
| `sessionConnectionIds` | C12 C16 (+C6e read) | 2 | **3** | 0 | 3041 (C12), 6925 (C16), 6089 (seam) |
| `clientOriginTurns` | C2 C12 | 9 | — | — | C12 3714/3766/3795, 4121/4138/4141; C2 6404/6491/6498 |
| `ephemeralSessionThreads` | C7 C12 | 2 | **2** | 0 | 3024/3027 (C12 command-impl) |
| `cooperativeStops` | C4 C2 | 1 in C2 (6466) | 2 in C4 | 0 | 5873 set, 5878 delete |
| `deltaCoalescer` | C1 C2 C16 (+ctor C6) | 4 | — | — | 1590, 2179, 6443, 6909 |
| `turnProgress` | C1 C2 C4 C7 C16 | 10 | — | — | 2020, 2186, 2395/2612, 6095, 6423/6488 (the T5 raw/merged split) |
| `sessionAuthz` | C1 C2 C7 C12 C16 C17 (+8 ctor deps) | 36 | — | — | writes only via `bindTenantContext` (3044, 6265), `forgetTenantContext` (6090), `invalidateSessionOwner` (4549, 6094, 6601) |
| `recoveryCoordinator` | C1 C2 C7 C16 | 5 | 1 (ctor) | — | 1727, 2187, 2606, 6572 |
| `monitoringBridge` | C2 C12 C18 (+ctor C6) | 4 | — | — | 1588, 3894, 6541 |
| `usageTelemetry` | C2 C16 C18 | 3 | 1 | — | 1663 (setter); reads 1652, 6557 |
| `turnDeduplicator` | C11 C12 | 4 | — | — | 1550/1551, 3613 |
| `adoptionLedger` | C14-stay C16 | 3 | — | — | 1295, 1305, 7097 |

The four maps that were the epic's hazard — `sessionReadModel`,
`sessionAdapters`, `threadProviders`, `sessionConnectionIds` — went from
7/9/8/8 write sites to **2/4/3/3 raw writes**, one of each being the single
seam. What replaced the hazard is the **delegated writes** (T13), absent
from Part I's matrix entirely.

## II.3 Core cluster sections (fresh)

### C1 — Adapter lifecycle, retirement, provider inventory
**PARTIAL-DONE — slice 12 (#4024) extracted the RETIREMENT half into
`AdapterRetirement` (`adapter-retirement.ts`): `retire`,
`settleRetirements`, the shutdown drain, `cleanupObsoleteStartedSession`
and the two bounded-await helpers, plus `adapterRetirementByAdapter` and
`retiredSessionsByAdapter`, whose writes are now wholly internal. Three
deps, no Map handle across the seam, no metrics (so no T12 concern — noted
so nobody "fixes" its absence), and ZERO test cast reach-ins existed to
re-point. `finalizeStoppedAdapterSessions` stays as a named dep because it
is one of the six `forgetThreadState` sites the T10(3) invariant counts in
the service file.

The other two halves are resolved, not deferred by omission:

* **The provider INVENTORY half is CLOSED BY INSPECTION** (C18/C2-style).
  `listProviders`, `getProviderCommands`, `supportsReadOnlyReview`,
  `getProviderModels`, `readPrerequisites`, `assertAdapterReady`,
  `requireAdapter`, `getProviderAdapter` own NOTHING; most are thin
  `adapterRegistry` delegations (two — `getProviderAdapter`,
  `supportsReadOnlyReview` — are literally one line; `assertAdapterReady`
  at ~26 lines and `readPrerequisites` do not touch the registry at all,
  so an earlier draft's "five one-line delegations" overstated it); four are public with external callers and
  `listProviders` additionally carries a T9 latch plus two Proxy
  memberships, so each would need a retained public forwarder that biome
  can never flag. Net ≈ −90 lines for eight new hops, making nothing
  unreachable — the exact criterion §II.5 used to close C2.
* **The STREAM-CONSUMPTION half stays, as a recorded option rather than a
  verdict.** The cut is constructible (deps `listAdapters`,
  `startConsuming`, `releaseController`, `markStreamUnconsumed`) but moves
  the once-only ingest latch and a `queueMicrotask` re-entry out of C2's
  `finally` for ~28 lines, with no observer at any level for the resulting
  ordering. Revisit only after C2's closure section documents the ingest
  orderings.

DELETED in passing: `adapterRetirements`, a `Set<Promise<void>>` with three
references file-wide (declare, one add, one delete) that was never read,
iterated, sized or awaited. Verified NOT to be a shutdown draining the
wrong collection: shutdown drains `adapterRetirementByAdapter` (the raw
operation) and re-wraps it in its own deadline.

The module is NOT named `AdapterLifecycle`: currency, streams, readiness
and inventory all stay by design, so naming it for the cluster would be a
label nothing derives.**
**Owns — the PRE-EXTRACTION derivation** (`adapterRetirements` no longer
exists; `adapterRetirementByAdapter` and `retiredSessionsByAdapter` now live
in `AdapterRetirement`): `consumedAdapterEventStreams:1008`,
`activeEventAdapters:1010`, `adapterEventControllers:1014`,
`adapterRetirements:1018`, `adapterRetirementByAdapter:1019`,
`retiredSessionsByAdapter:1023`, `adapterRegistryUnsubscribe:1027`.
**Shares:** `sessionReadModel` (r 5545/5569), `sessionAdapters` (r 5547/5570),
`deltaCoalescer` (2179), `turnProgress` (2186), `recoveryCoordinator` (2187),
`adoption` (2225), the teardown seam at 5583.

Methods (23): `consumeCurrentAdapterEvents:2081`, `retireAdapter:2110`,
`settleProviderAdapterRetirements:2152`, `shutdown:2173`,
`listProviders:2248`, `getProviderCommands:2275`,
`supportsReadOnlyReview:2293`, `getProviderModels:2300`,
`isAdapterCurrent:5519`, `assertAdapterCurrent:5523`,
`assertAdapterCurrentAfterCommand:5531`, `captureAdapterSessions:5541`,
`stopAndFinalizeRetiredAdapter:5553`, `finalizeStoppedAdapterSessions:5562`,
`stopAdapterEventConsumer:5590`, `cleanupObsoleteStartedSession:5597`,
`runCleanupWithinDeadline:5621`, `runOperationWithinDeadline:5633`,
`adapterStopTimeoutMs:5661`, `readPrerequisites:6105`,
`assertAdapterReady:6121`, `requireAdapter:6150`, `getProviderAdapter:6159`.

Already routed through collaborator deps: `assertAdapterCurrent`/`Ready`/
`requireAdapter` → `AttachedSessionAdoption` (ctor 1329–1331);
`getProviderModels:2312/2317` imports `listLaunchableAdapterModels`/
`knownModelsCatalog` from `model-launch-planning.js` — a C1→slice-8 module
dependency Part I could not have.

External callers: **4 files** (orchestration routes, runtime-routes,
runtime-shutdown, station-control-delegation) + 5 plugin files reaching
`settleProviderAdapterRetirements` structurally through a threaded
`() => Promise<void>` dep, none naming the service.

**Shrinkage:** moderate but real — `shutdown`'s foreign reach is now three
collaborator calls + one seam call; `finalizeStoppedAdapterSessions`'s
seven-map clear is one flagged seam call at 5583. The remaining entanglement
is with C2 (5577 publish; the ingest loop's `finally` writing two C1 fields
at 5509–5515), not with the per-thread maps.

### C2 — Event ingest & canonical publish spine (the hub)

**RESOLVED by inspection (slice 14, #4024) — NO EXTRACTION of the spine.
ONE sub-cut is recorded as a RECOMMENDED slice, not a deferred option: the
turn-provenance sidecar (117 lines, 2 deps, zero raw fields, zero
invariants). Everything else in C2 stays, and this section is the only place
its orderings are written down.** Re-derived at `210b56a0c` — every line
number below is that commit, and Part II's C2 numbers (anchored at
`71699b7c1`) are all stale by ~1,150 lines.

**Shrinkage: NEGATIVE, and worth stating precisely rather than as "essentially
none".** Between `71699b7c1` and `210b56a0c` the file went 7,148 → 5,786
lines (−19.1%) while C2 went 549 → 612 doc-inclusive lines (+11.5%; bodies
480 → 542). C2's share of the file rose 7.7% → 10.6%. Two of its ten members
are NEW since the last anchor and neither came from this epic:
`captureUsagePricingSnapshot` (`6905e5fd1`, #4223 usage rollup) and
`hasActiveTurn` (`f37bdbb6a`, #4269 conversation intent summaries). **C2 is a
live accretion site**: product work lands in the ingest loop because that is
where every canonical event is. Extracting it would not stop that; it would
relocate it, and the next reader of the module would find the same growth
with one more hop in front of it.

**Members (10 — the map's eight, plus two new), region = docblock..close:**
`consumeAdapterEvents:4599–4763` (165, private async),
`captureUsagePricingSnapshot:4765–4793` (29, private async, NEW),
`assembleTurnProvenanceFor:5110–5183` (74, private),
`turnProvenanceSidecar:5185–5203` (19, private),
`replayTurnProvenanceSidecar:5205–5228` (24, **public**),
`hasActiveTurn:5230–5233` (4, **public**, NEW — see the adjacency note),
`projectAndPublishEvent:5235–5290` (56, private),
`publishCanonicalEvent:5292–5490` (199, private),
`readCurrentLifecycleState:5492–5517` (26, private),
`recordStateDuration:5519–5534` (16, private).
Callback entries: `sessionLifecycles.publish` (ctor 1184–1186),
`sessionLifecycles.observeStateDuration` (1203–1212), the coalescer flush
callback (field initializer 953–963, T1).

**Adjacency, not membership:** `hasActiveTurn:5231` is a three-line forwarder
to `sessionExecutionCoordinator.hasActiveTurn` and belongs to C3/the
coordinator, not to the publish spine; it sits inside C2's block only by
where #4269 dropped it. It is recorded here because it is otherwise
invisible: its ONE production caller reaches it through an anonymous
structural cast — `conversations.ts:1850–1858` casts `sessionMessageReader`
(bound to `context.orchestrationService` at `runtime-routes.ts:3060`) to
`{ hasActiveTurn?(conversationId: string): boolean }`. No grep for
`orchestrationService.hasActiveTurn` finds it. This is T13's shape one level
up — a *read* delegated through a structural type instead of a Map handed to
a helper — and it means the method is neither dead nor safely renameable.

---

#### 1. What C2 owns: nothing. Verified field by field, not asserted.

Reference counts are code references in `orchestration-service.ts` at
`210b56a0c` (comments excluded); "C2's" is the subset inside a C2 member.

| field / collaborator | decl | refs | C2's | C2's sites | owner |
|---|---|---|---|---|---|
| `adapterEventControllers` | 833 | 7 | 2 | 4755 get, 4756 delete | **C1** (2069, 2076, 2115, 4858, 4860) |
| `consumedAdapterEventStreams` | 827 | 3 | 1 | 4759 delete | **C1** (2070, 2075) |
| `sessionAdapters` | 850 | 13 | 3 | 4647 set, 4652 delete, 4705 spread | **C1/C7** (1017, 1399, 1490, 1690, 3052, 4823, 4837, 4908, 5073, 5690) |
| `threadProviders` | 876 | 16 | 2 | 5335 set, 5381 handle | **C7** (13 others across C6/C12/C16/seam) |
| `sessionReadModel` | 903 | 33 | 3 | 4774 get, 5382 handle, 5510 get | **C7** (30 others) |
| `quarantinedThreads` | 916 | 10 | 4 | 4646, 5265, 5320 reads; **5322 delete** | split C6 (add 1397) / C16 (add 5548) / C12 (3041, 3505) / C7 (5069) / C16 (5661) |
| `clientOriginTurns` | 877 | 9 | 3 | 5249 apply, 5337 clearThread, 5344 retire | **C12** owns begin/settle/cancel (3781, 3833, 3862, 4189, 4206, 4209) |
| `usageTelemetry` | 825 | 3 | 1 | 5406 | **C18** (setter 1569, C16 read 1558) |
| `deltaCoalescer` | 953 | 4 | 1 | 5288 offer | seam 1395 `forgetThread`, **C1** 2097 `flushAll`, **C16** 5547 `forgetThread` |
| `turnProgress` | 861 | 11 | 2 | 5268, 5334 | **C3** |
| `sessionExecutionCoordinator` | 826 | 7 | 2 | 5267, 5389 | shared C12/C7 |
| `monitoringBridge` | 947 | 4 | 1 | 5390 | **C18** |

C2 is a minority referencer of every field it touches. Its **one exclusive
operation** in the whole cluster is `quarantinedThreads.delete` at 5322 — a
single-shot re-arm on a Set it neither declares for nor ever adds to.

Two entries deserve calling out because a reader would assume otherwise:

* **The delta coalescer is not C2's.** Its field docblock (949–952) talks
  only about `publishCanonicalEvent`, and its flush callback IS
  `publishCanonicalEvent` — but three of its four call sites are outside C2
  (the `forgetThreadState` seam dep at 1395, C1's `shutdown` flush at 2097,
  C16's `recoverSessions` forget at 5547), and `forgetThreadState`'s docblock
  explicitly excludes it from the teardown seam (4893–4895). C2 owns
  `offer`, and nothing else about the coalescer's lifecycle.
* **`clientOriginTurns` is the closest thing to a genuine C2 field and it is
  still C12's.** C12 owns the origin side (begin/settle/cancel, six sites in
  `sendTurn`/`steerTurn`); C2 owns the publish side (apply/clearThread/retire,
  three sites). Six-to-three is not ownership, and splitting the class across
  a module seam would put its two halves in different files.

#### 2. What a module would cost: ~28–30 named deps for 612 lines

Enumerated in the epic's own convention — named function deps, never a Map
handle (T13), lazy getters for anything the service can swap. An
`EventPublishSpine` ctor would take:

*From `consumeAdapterEvents` (12):* `isAdapterCurrent`,
`consumeCurrentAdapterEvents` (the re-entry at 4760), `controllerFor` +
`releaseController` (4755/4756), `forgetConsumedStream` (4759),
`setSessionAdapter` (4647), `forgetSessionAdapter` (4652),
`threadsForAdapter` (4705 — the `[...this.sessionAdapters]` filter; a named
dep, never the Map), `isQuarantined`, `applyPendingTurnInterrupt`,
`applyPostHocToolPolicies`, `spoolCommandEvidence`.
*From `captureUsagePricingSnapshot` (2):* `pricingSnapshotCapture` (lazy,
optional), `loadedSessionModel` (4774).
*From `projectAndPublishEvent` (4):* `clientOriginApply`, `coalescerOffer`,
`observeExecution`, `observeTurnProgress`.
*From `publishCanonicalEvent` (10):* `settleCompletedTurn`,
`clearQuarantine`, `clientOriginClearThread`, `clientOriginRetire`,
`setThreadProvider`, `projectToReadModel` (5379–5384 — see below),
`onRuntimeEvent`, `trackEngineTurn` (lazy: `setUsageTelemetry:1568` swaps it
after construction), `observeRecovery` (optional), `invalidateSessionOwner`.
*Shared (2–3):* `eventStore` as one lazy handle covering eight methods
(`listSessionProjectionEvents`, `listEventsForTurn`,
`conversationContextBoundaryForSuccessor`, `upsertTurnProvenance`,
`readTurnProvenance`, `latestEventForSessionState`, `projectLiveEvent`,
`appendEvent`), `emitOrchestrationEvent`, `logger`.

**≈30 named deps, or ≈22 if the eventStore's eight methods collapse into one
lazy handle and the three quarantine operations into two.** Against the
epic's shipped modules: `AdapterRetirement` 3, `InterruptedTurnRecovery` 4,
`FlowPolicySidecar` 10, `CooperativeStop` 10, `ConnectionSmoke` 11,
`CredentialProfileRecovery` 14 (the current maximum). C2 would be roughly
double the largest module the epic has produced, and it is the exact
criterion §II.5 used to leave `recoverSessions`/`recoveredSessionStartOptions`
in place ("~22 deps for ~176 lines"): here it is ~22–30 deps for 612.

Three of those deps cannot be built cleanly:

1. **`projectToReadModel` is a T13 delegated-write site.** 5379–5384 hands
   BOTH `this.threadProviders` and `this.sessionReadModel` to
   `projectOrchestrationEventToReadModel`, which writes them at
   `orchestration-session-state.ts:107/111`. Either the module takes two Map
   handles — breaking the rule every prior slice held — or the call stays on
   the service and the module gains a dep whose implementation is the write
   it was supposed to encapsulate. This is one of exactly two such sites in
   the file (the other is C7's `trackSession` at 5085–5088).
2. **Two construction cycles that only `this` currently breaks.** C2 calls
   `cooperativeStop.settleCompletedTurn` (5315) and
   `.applyPendingTurnInterrupt` (4650); `CooperativeStop`'s ctor takes
   `publishEvent: (event) => this.projectAndPublishEvent(event)` (1491). C2
   calls `flowPolicy.applyPostHocToolPolicies` (4654) and
   `.spoolCommandEvidence` (4655); `FlowPolicySidecar`'s ctor takes the same
   dep (1368). The service is the shared late-bound holder that makes both
   legal. Extracting C2 does not remove the cycle — it adds an object to it.
3. **The coalescer's flush callback is a field initializer (T1).** It is
   constructed at 953–963, BEFORE the ctor body runs, and its callback is
   `publishCanonicalEvent`. Pointing it at a module means the field
   initializer closes over a `this.eventSpine` that does not exist yet —
   legal only because the arrow is lazy, which is precisely the hazard the
   field's own comment (957–958) warns about for `this.options`.

**Back-edges the move would have to re-point: 8.** `projectAndPublishEvent`
has seven non-C2 in-file callers — four ctor dep closures (1185
`sessionLifecycles.publish`, 1369 `flowPolicy.publishEvent`, 1424
`interruptedTurns.publishEvent`, 1492 `cooperativeStop.publishEvent`) and
three direct calls (3840 C12 `sendTurn` early origin event, 4216 C12
`steerTurn` early origin event, 4841 C1 `finalizeStoppedAdapterSessions`) —
plus `recordStateDuration` at 1203. Note 1424's dep is typed `boolean`, not
`void`, because `InterruptedTurnRecovery`'s M4 refusal branch READS it
(`interrupted-turn-recovery.ts:207, 321`); a module boundary must preserve
that, and `void` would silently convert "declined" into "done".

#### 3. What becomes unreachable: four members, ~148 lines, and none of them
are the reason to do it.

Of ten members, only `captureUsagePricingSnapshot` (29),
`assembleTurnProvenanceFor` (74), `turnProvenanceSidecar` (19) and
`readCurrentLifecycleState` (26) have no caller outside C2 and would leave
the service outright. The other six all keep a service-side name:

* `replayTurnProvenanceSidecar` is public with an external caller
  (`routes/orchestration/orchestration.ts:2507`) and two test stubs
  (`orchestration.routes.test.ts:218, 3521`) → retained forwarder, T11 shape,
  biome can never flag it.
* `hasActiveTurn` is public with a structural external caller
  (`conversations.ts:1858`) → retained forwarder, and one that no grep finds.
* `projectAndPublishEvent` → either a retained forwarder or seven re-points.
* `recordStateDuration` → one re-point.
* `consumeAdapterEvents` is launched from C1 (`2077`) and calls back into C1
  four ways (4610, 4692, 4755–4759) → re-point plus four new deps.
* `publishCanonicalEvent` is the coalescer's flush target (954).

So the honest ledger is: **612 lines out, ~30 deps in, 8 back-edges, 2
retained public forwarders, and one write the module cannot own.** The
line-count reduction is real and is the largest single one left in the file —
that is the strongest case FOR extraction and it is not enough. Every line
removed is replaced by a dep arrow in the same file, and nothing is
encapsulated, because there is nothing to encapsulate: see §1.

#### 4. Why C2 is not shaped like the clusters that DID move

* **vs `ConnectionSmoke` (slice 9, the own-nothing precedent).** C17 also
  owned nothing, and moved anyway — on the strength of ONE raw map read
  (`threadProviders.has`), one method, one external caller, zero Proxy
  membership, zero cast reach-ins, contiguous tests. C2 has 12 raw
  fields/collaborators, 25+ raw operations, 10 members, 8 back-edges, 9 test
  cast reach-in sites, and two source invariants. "Owns nothing" was C17's
  cheapest property; for C2 it is the *only* shared one.
* **vs `AdapterRetirement` (slice 12).** Three deps, two owned maps whose
  writes became wholly internal, no Map handle across the seam, zero cast
  reach-ins. The whole point was that the writes stopped crossing a boundary.
  C2's writes cross a boundary in the other direction and would keep doing so.
* **vs `InterruptedTurnRecovery` (slice 13).** Four deps, zero owned state,
  ONE caller, zero external callers, zero invariants, zero seam rows — an
  own-nothing cluster that still cut cleanly because it was a *leaf*. C2 is
  the root: it is what every other cluster's `publishEvent` dep points at.
* **vs `FlowPolicySidecar` (slice 11).** Seven owned fields, zero foreign raw
  writes, the biggest island in the file. That is the inverse of C2 on both
  axes.

The general rule this cluster establishes: **an own-nothing cluster is
extractable when it is a leaf and unextractable when it is the hub.** C17 and
C16's interrupted-turn unit had one caller each; C2 has eight, four of them
already-extracted modules.

#### 5. Load-bearing orderings — the thing this section exists to hand forward

Part II's T5 list re-anchored at `210b56a0c`, plus five it does not carry.
If C2 is never extracted, this is the only written record.

**T5, re-anchored:**

1. **Stop-settle before the quarantine gate.** `settleCompletedTurn` 5315–5319
   runs BEFORE `quarantinedThreads.has` 5320 and the `return false` at 5321.
   Rationale in source 5311–5314: a stop on a quarantined thread would
   otherwise never settle and would ride its full budget into a forced
   teardown of a completed turn. **Owned by a source invariant** —
   `orchestration-service.test.ts:4169–4187` reads the method body as TEXT
   and asserts `settle < gate`, plus exactly one `.settleCompletedTurn(`
   file-wide. Slice 10 recorded that the perturbation is 100% green under the
   whole behavioural suite.
2. **Raw vs merged delta observation.** The raw observe is at 5267–5268
   (inside `projectAndPublishEvent`, before the coalescer takes the event);
   the merged path deliberately skips re-observing at 5334
   (`turnProgress`) and 5388–5389 (`sessionExecutionCoordinator`). Observing
   the merged event again resets the stall window twice for one stretch of
   text; not observing raw makes a healthy fast turn look stalled.
3. **The raw observe is gated on not-quarantined.** 5263–5269. A provider
   stop is asynchronous, so deltas keep arriving after
   `quarantinedThreads.add`; ungated they re-arm the stall watchdog and the
   execution coordinator for a retired session. This gate exists because the
   observation happens ABOVE the quarantine gate, which is where every other
   event's observation happens.
4. **"The coalescer took it" is a boolean that means TAKEN, not PUBLISHED.**
   `if (this.deltaCoalescer.offer(event)) return true;` at 5288. Its caller
   gate is `if (!this.projectAndPublishEvent(normalized)) continue;` at 4649,
   which short-circuits **five** downstream behaviours, not the four the
   in-source comment enumerates (5277–5286):
   `cooperativeStop.applyPendingTurnInterrupt` (4650, **omitted from the
   comment**), the `session.exited` adapter cleanup (4651–4653),
   `applyPostHocToolPolicies` (4654), `spoolCommandEvidence` (4655), and the
   state-transition telemetry + `recordStateDuration` block (4656–4680).
   The comment's safety argument is nevertheless sound for the missing entry:
   `COALESCABLE` is `{content.text-delta, content.reasoning-delta}`
   (`delta-coalescer.ts:36`) and `applyPendingTurnInterrupt` returns
   immediately for any method that is not `turn.started` or one of
   `session.exited`/`turn.completed`/`turn.aborted`
   (`cooperative-stop.ts:220–232`). **Correct the enumeration, do not weaken
   the constraint:** anything wider than a coalescable delta must not start
   returning `true` at 5288 without re-reading 4649–4680.
5. **Owner invalidation before the SSE emit.** 5447–5453 before 5454. A
   subscriber reacting to this same event (the `/events` route's
   `canUserReadSession` gate) must never observe a stale cached owner. The
   in-source scope note (5429–5446) is careful about what it does NOT cover
   (`AttachedSessionFollowService.appendAndPublish`) and says so as a
   structural gap, not a proof — keep that framing.
6. **`turnIdentityAnchorForEvents`, not `activeTurnIdForEvents`.** 4622–4641.
   The clearing fold answers "is a turn open" and is `undefined` after a
   `runtime.error`/`session.exited` — the permissive default that let a stale
   terminal for an earlier turn get stamped `sessionState: 'completed'` on
   disk. This value is stamped onto a PERSISTED event, so it is a written
   fact, not a display artifact.
7. **`InternalStopSuppression`'s narrowed read** is the ctor dep at
   1083–1089 (`listActiveTurnFoldEventPayloads` over `ACTIVE_TURN_FOLD_METHODS`).

**Five more that T5 does not carry:**

8. **The ingest loop orders gate < post-hoc policy < command spool**, and each
   is dispatched exactly once across the whole services tree. **Owned by a
   second source invariant**, `orchestration-service.test.ts:4202–4241`,
   which also pins the literal declaration string
   `'\n  private async consumeAdapterEvents('` and — since slice 11 made the
   sidecar's methods public — scans every non-test `.ts` under
   `src-server/services/` for a second dispatcher. Prose naming these calls
   must stay name-only (no `this.flowPolicy.` + paren form) or the scan reds
   on its own rationale.
9. **The publish body is a fixed ten-step sequence**, and nothing but reading
   it records the order: sanitize (5308) → settle (5315) → quarantine gate
   (5320–5322) → merged-delta progress observe (5334) → provider/origin
   bookkeeping (5335–5345) → activity telemetry (5347–5373) →
   `projectLiveEvent` (5377) → read-model projection (5379–5384) →
   `appendEvent` (5385) → coordinator (5389) → monitoring (5390) → engine-turn
   telemetry (5400–5417) → recovery (5421) → owner invalidation (5447) → bus
   emit (5454) → receipt bus (5482). Two of these are load-bearing beyond
   convention: **recovery observes only after canonical persistence** (5419–5421,
   so a restart can reconstruct the source turn without copying its content),
   and **the provenance sidecar is folded INSIDE the emit payload at 5468 —
   after `appendEvent`** — so the fold sees the turn's own terminal. This one
   IS observed: moving it above 5385 turns the metric test at
   `orchestration-service.test.ts:7454–7484` from `assembled` to `absent`.
10. **The sanitizer runs above BOTH writers.** `safeSanitizeUIBlockEventProvenance`
    at 5308–5310 precedes `appendEvent` (5385) and the bus emit (5454), which
    is what makes a tool-emitted UI block's provenance identical live and on
    replay. **This is pinned cross-tree, by file path**:
    `runtime/conversation/__tests__/ui-block-provenance-writer-inventory.test.ts:204–208`
    pins `orchestration-service.ts` as one of exactly four `.appendEvent(`
    writers and one of exactly two
    `eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT` publishers, with the
    comment naming `publishCanonicalEvent`. Whatever file holds
    `publishCanonicalEvent` is a pinned provenance-sanitizing writer, and
    moving it edits a ratchet in another tree.
11. **`sessionAdapters.set` is gated on not-quarantined (4646–4648) and runs
    ABOVE the publish gate (4649)**, so a quarantined thread's adapter binding
    is never refreshed even though the event is still offered to the spine.
12. **The `finally` checks controller identity before deleting (4755–4757)**
    — a newer controller for the same adapter must survive an older loop's
    teardown — **and gates the restart on `isAdapterCurrent` (4758)** before
    dropping the once-only ingest latch and re-entering via `queueMicrotask`
    (4759–4760). §II.3 C1 already makes this `finally` the reason the
    stream-consumption half stays a recorded option rather than a verdict;
    that stays true, and this section is the documentation it was waiting on.

**Test-surface facts a future refactor inherits:** two source invariants pin
C2 method declaration strings byte-exact (`'\n  private publishCanonicalEvent('`
at test:4174, `'\n  private async consumeAdapterEvents('` at test:4211), read
through a `readMethodBody` helper (test:4148) whose `MEMBER_DECLARATION` regex
assumes the file's two-space member indent. T6's C2 entry has drifted: the
private-member reach-ins are now **nine sites**, not five — `(service as any)
.projectAndPublishEvent(` at test:2205, 2234, 2261, 2283, and typed
`as unknown as { projectAndPublishEvent(...) }` blocks at 2811–2813,
7339–7341, 7388–7390, 7459–7461, 8927–8929.

**Cross-references into this file rot, demonstrably.**
`session-lifecycle-service.ts:868` cites `orchestration-service.ts:5641-5645`
for `normalizeCanonicalRuntimeEventLifecycle`; at `210b56a0c` that range is
`materializeRecoveredSession`. The real site is 4641–4645. Prefer naming the
method over citing its line.

#### 6. Known-unobserved arms (disclosed, not fixed here)

Recorded so a future reader inherits the list rather than rediscovering it.
All four are branches with zero repo-wide test reference at `210b56a0c`.

1. **The adapter-provided `session.stop-settled` refusal, 4611–4618.** The
   guard that stops an engine labelling a forced stop cooperative — "this is
   an orchestration-owned derivation". The warning string
   `'Ignored adapter-provided cooperative-stop outcome'` appears in exactly
   one file repo-wide: this one. Every `session.stop-settled` in the suite
   (test:2907, 3012, 3430, 3486, 3537, 4369, 4716, 15228) is either an event
   the service itself derived or a fold fixture driven straight at the event
   store; **no fixture ever pushes one onto an adapter's stream**, which is
   the only input this arm reads. The highest-value gap of the four: it is a
   provenance guard, and a provenance guard whose rejection path has never
   executed is unproven.
2. **`captureUsagePricingSnapshot` in its entirety, 4765–4793.** No test
   anywhere constructs an `OrchestrationService` with a
   `pricingSnapshotCapture` option (zero hits outside
   `runtime-initialize.ts` and this file), so the method's guard, the
   `sessionReadModel` model lookup, the successful attach and the
   `'Usage pricing snapshot capture failed'` catch are all unobserved. Note
   the shape while it is unobserved: it is an `await` on an optional external
   capture **inside** the `for await` ingest loop (4619), so it serializes
   every event behind it.
3. **`assembleTurnProvenanceFor`'s context-boundary arm, 5148–5175.** The
   `boundary?.status === 'consumed'` branch that attaches
   `contextBoundary: { state: 'observed', … }` to a live envelope.
   `conversationContextBoundaryForSuccessor` has no test caller through this
   path (its only covered callers are C11's `conversation-lineage.ts` and
   `session-event-reads.ts`); the two `contextBoundary` assertions in the
   suite (test:1201, 1397) exercise the handoff service, not this fold. The
   distinction the arm encodes — "a reservation is not answer provenance,
   only the consumed durable effect is" — is currently unpinned.
4. **`assembleTurnProvenanceFor`'s fail-soft catch, 5176–5182.** The
   `'turn-provenance: failed to assemble the live envelope for a completed
   turn'` warn. The docblock's whole argument is that a throw here would
   break event publication for the session; nothing proves it does not.

Covered, for contrast, so nobody re-derives it: the stream-restart `finally`
(test:12791), the SQLITE_BUSY contention arm and its counter (test:12865,
12925), the per-thread surfacing catch (test:13051), the provenance metric's
`absent`/`assembled` denominators (test:7454–7484), the owner-cache
invalidation counter (test:16275, 16460), and the `extension.notification` /
`task/settled` activity telemetry (test:2818).

#### 7. The one sub-cut worth taking: `TurnProvenanceSidecar`

**RECOMMENDED as a slice, not a deferred option.** §II.5's outline treated
C2 as a single unextractable block. It is not: three of its ten members form
a unit with a cleaner boundary than several already-shipped slices.

`assembleTurnProvenanceFor:5110–5183` + `turnProvenanceSidecar:5185–5203` +
`replayTurnProvenanceSidecar:5205–5228` = **117 doc-inclusive lines**, and
between them they touch **`this.options.eventStore` and `this.options.logger`
and nothing else** — zero raw fields, zero collaborators, zero shared state.
Deps: **2** (`eventStore: () => this.options.eventStore` lazy-and-optional,
`logger`) — byte-for-byte `InterruptedTurnRecovery`'s convention
(ctor 1417–1425). Callers: `publishCanonicalEvent:5468` (one, internal) and
`orchestration.ts:2507` (one, external, through the public method). Zero
source-invariant pins. Zero cast reach-ins — the suite drives it through
`projectAndPublishEvent` (test:7459–7461) and the public
`replayTurnProvenanceSidecar` (test:7424, 7441), so **zero test re-points** if
the service keeps the public one-line forwarder it needs for the route
anyway. Compare the shipped baselines: slice 13 moved 293 lines on 4 deps,
slice 12 moved its half on 3, slice 9 moved 284 lines on 11.

It is also a real encapsulation gain rather than a relocation.
`assembleTurnProvenanceFor` performs a durable WRITE
(`eventStore.upsertTurnProvenance`, 5174) from inside a method named for
assembly — the "read-side feature that writes" shape. A module makes that
write its own, and gives the live/replay pair (station#1410's two halves,
today separated by 20 lines of unrelated members) one home with its
deliberate asymmetry — the replay path does NOT record the metric, because a
replay is a redelivery of a turn already counted — stated once instead of
twice.

Constraints a plan pass must carry:

* **The metric moves and T12 applies.** `turnProvenanceProjections` must be
  imported from `'../../telemetry/metrics.js'` — the same module id the suite
  mocks — which is what a new file in `src-server/services/orchestration/`
  resolves to (the `turn-progress-tracker` / `session-authorization` /
  `flow-policy-sidecar` precedent). A barrel or a different depth gets the
  real counter under a mocked suite.
* **The counter stays ABOVE the turn-id guard** (5194–5202 vs 5133): a
  completed turn carrying no turn id is exactly the population `absent`
  measures. Counting only turns that have an id reports a perfect assembly
  rate for precisely the engines the metric exists to expose.
* **The fold call at 5468 must stay inside the emit payload, below
  `appendEvent:5385`** (ordering 9 above).
* **`assembleTurnProvenanceEnvelopes` does not leave the service**: there is a
  SECOND use at 2685, in C11's `consumeConversationContextBoundary`
  re-fold. The import stays; only the C2 uses move.
* **Fail-soft is the contract, not an implementation detail.** The live caller
  runs inside the single dispatch point every event flows through; a throw
  breaks event publication for the whole session. Carry the docblock verbatim.
* **Take gap 6.3 and 6.4 with the slice.** The context-boundary `consumed`
  arm and the fail-soft catch are 32 of the 117 lines being moved, and both
  are unobserved today; a slice that moves them without pinning them ships an
  untested module and calls it an extraction.

Everything else in C2 — the ingest loop, the coalescing seam, the publish
body, the lifecycle read, the duration record, the pricing snapshot — stays.

**A footnote for whoever touches `recordStateDuration:5519–5534`:** it
references `this` zero times. It reads only its own parameter object and
`sessionStateDuration.record`. It is a pure function that happens to be a
class member, and could become a module-level function today — 16 lines, no
seam, no dep, no module. Not a slice; just don't let anyone plan one for it.

### C4 — Cooperative stop & deferred interrupt
**DONE — extracted by slice 10 (#4204) → `CooperativeStop`
(`cooperative-stop.ts`); the data below is the pre-extraction derivation.
The C2 settle-read became `settleCompletedTurn`, called at the same
pre-quarantine-gate position and pinned by a NEW source invariant plus a
quarantined-settle behavioral guard. C7 lost a raw WRITE for the first
time (`upsertLoadedSession` named dep). The teardown flags moved to the
ctor seam as the SECOND ctor-declared site, table reordered in the same
diff. First dedicated unit file since slice 3
(`cooperative-stop.test.ts`) — three service-invisible pins; the
missing-unit tally is now EIGHT of ELEVEN. Disclosed: the pre-dispatch
clears are defense-in-depth behind coalescing (joint property pinned);
the two post-command adapter asserts have no observer (accepted).**
**Owns:** `cooperativeStops:1030`, `pendingTurnInterrupts:1041`.
**Shares:** `sessionAdapters` (r 5811), `sessionReadModel` (r 6001/6030,
**w 6039** — one of the file's two raw writes to C7's map), the seam (6099),
C2's publish (5946/5963/5973), C1's asserts (5987/6016).

Methods (12, contiguous 5665–6104 apart from the seam):
`cooperativeStopBudgetMs:5665`, `applyPendingTurnInterrupt:5703`,
`recordPendingTurnInterrupt:5741`, `clearPendingTurnInterrupt:5758`,
`dispatchDeferredInterrupt:5765`, `bindPendingTurnInterrupt:5794`,
`interruptUserTurnCooperatively:5823`, `runCooperativeStop:5883–5998`,
`stopDormantSessionImmediately:5999`, `stopUserSessionImmediately:6008`,
`persistResumableStoppedSession:6025–6076`, `forgetLiveUserSession:6098–6103` (six lines).

No collaborator receives a C4 method; reached only from C2 (5402, 6466) and
C12 (3929/4203). External callers: **0**.

**Shrinkage: large.** Part I's "shares eight fields, six deleted by
`forgetLiveUserSession`" is deleted code — that method is seven lines and two
flags. Remaining cross-cluster surface: one `sessionAdapters` read, the
6039 write, three publishes, two asserts, and C2's settle-read of
`cooperativeStops` at 6466 (still before the quarantine gate at 6474 — T5).

### C7 — Session read model / inventory / tracking
**Owns:** `sessionReadModel:1093`, `threadProviders:1066`,
`ephemeralSessionThreads:1099`; co-owns `sessionAdapters:1028`.
Methods (17 after re-attributing `commandProvider` to C12):
`observeAnswerability:1770`, `listSessions:2320`, `listSessionReadModel:2351`,
`listLoadedSessionReadModel:2406`, `listAgentRuns:2413`, `readAgentRun:2487`,
`listProjectSessionBoard:2495`, `readSession:2579`,
`resolveSessionProjectSlug:2711`, `seedSessionRecord:4576`,
`isReadOnlyAttachedSession:4609`, `runtimeKindFor:5276`,
`sessionAttributionFor:5318`, `trackSession:6250`, `isEphemeralSession:6283`,
`isDormantSessionThread:7051`, `readLatestSessionStartMetadata:7074`.

C7-owned methods and maps are read through ctor dep closures across seven
collaborators — `isEphemeralSession`/`sessionAttributionFor`
(SessionTranscriptReads), `listSessions`/`loadedSessionForThread`/
`observeAnswerability`/`readSession` (SessionEventReads), `liveSessions`/
`trackSession`/`evictCollidingAttachedAliases` (AttachedSessionAdoption),
`isReadOnlyAttached`/`readSession` (SessionLifecycleModule),
`observeAnswerability`/`readSession` (ConversationHistoryReadService /
ConversationLineage), `loadedProviderFor` (CredentialProfileRecovery).
External callers: **10 files** (up from Part I's 8).

**Shrinkage: marginal — and that is the finding.** `sessionReadModel` is
touched by 22 of 134 members (was 30 of 180, measured identically — the
review reproduced the baseline to the unit): eight extractions removed only
eight of thirty touching members while the file lost 46, leaving the ratio
essentially flat (16.7%→16.4%). The reader population barely shrank because
every seam reads the map through a ctor closure (six of them: the
transcript, event-read, adoption, query, history, and credential-recovery
deps) rather than removing a reader; 32 reference lines and 10 external
caller files remain. See II.5: C7 is terminal, planned as a rename.

### C12 — Command dispatch spine
**Owns:** `startingSessionThreads:1114`, `inFlightSteers:1092` (new),
`sessionCommands:1002`, `sessionCommandImplementation:1003`.
Methods: `createSessionCommandImplementation:2966–3269` (303 lines),
`startSessionInternal:3270`, `dispatch:3282`,
`dispatchWithReceipt:3326–4267` (**941 lines**; arms adoptSession:3471,
sendTurn:3479, interruptTurn:3929, steerTurn:3989, respondToRequest:4186,
stopSession:4203), `readCommandReceipt:4553`, `listCommandReceipts:4565`,
`sessionLogger:4751`, `commandProvider:6163` (re-attributed from C7),
`withAcceptedModelLaunchPlan:6192` (retained forwarder),
`warnBestEffort:6206`, `commandThreadId:6217`, `persistReceipt:6246`
(21 in-file call sites + the adoption dep at ctor 1328).
External callers: **7 files** — incl. `orchestration-review-executor.ts`,
which now takes the service whole as a `ReviewOrchestrationPort`
(runtime-routes 2153–2157) and dispatches through it.

**Shrinkage: negative in size** (`dispatchWithReceipt` 857→941), positive in
legibility (model-launch/authz/adoption calls all named). See II.5: split
into two mini-slices (steer serialization; receipt ledger); the switch is
not a slice.

### C15 — Flow run / policy hooks / workflow sidecar
**DONE — extracted by slice 11 (#4218) → `FlowPolicySidecar`
(`flow-policy-sidecar.ts`); the data below is the pre-extraction
derivation. Ten deps: four lazy service arrows, C2's publish as void,
the T9-latched service `readSession` forwarder, C7's `runtimeKindFor` +
`engineExecutionForAdapter` as deps (C7 unmoved), and
`latestEventPayloadByMethod` absorbing the event-store `?.` at the seam
(T13: no Map or store handle crosses). The ctor reads
`flowRunService`/`veritasReadinessService` EAGERLY once for the two
bridges (identity-preserving; documented split) while method bodies read
lazily. The teardown flags stayed INSIDE the service's `forgetThreadState`
seam routing through `forgetPolicyBinding`/`forgetFlowBinding` accessors —
no new ctor-declared flag row, docblock table untouched. The lifecycle
closure collapsed to one delegated call (`prepareCompletion`). Second
consecutive slice shipping a dedicated unit file
(`flow-policy-sidecar.test.ts` — gate order, revalidated-events apply,
both spool arms + the no-readiness inverse, both cached-falsy pairs); the
missing-unit tally is now EIGHT of TWELVE. New source invariant pins the
ingest ordering (gate < post-hoc < spool, single-dispatch file-wide) with
a quarantined-ingest S3 fixture as its behavioral complement.**
**Owns (unchanged in kind):** `readinessBridge:1128`,
`commandEvidenceBridge:1129`, `commandEvidenceRoutingPolicy:1131`,
`policyThreads:1140`, `pendingPolicyWrites:1142`,
`pendingCommandSpools:1148`, `flowBoundThreads:1153`.
Methods (14, contiguous 4629–5275 except `sessionLogger`):
`readSessionFlowRun:4629`, `readSessionBuilderRun:4661`,
`attachSessionEvidence:4715`, `bindExplicitFlowRunToSession:4774`,
`enforceFlowCompletionGate:4838`, `bindWorkflowSidecarToSession:4896`,
`applyWorkflowSidecarTransition:4936`, `readSessionWorkflowState:4995`,
`bindPolicyHooksToSession:5024`, `enforcePolicyStopGate:5063`,
`applyPostHocToolPolicies:5114`, `spoolCommandEvidence:5198`,
`isFlowBoundThread:5247`, `resolvePolicyCwd:5261`.
Callback entry: `sessionLifecycles.prepareCompletion` (ctor 1376–1387 — three
C15 methods and an ordering in one closure). Ingest-loop calls at 5408/5409,
gated on `projectAndPublishEvent`'s "coalescer took it" boolean (T5).
External callers: **3 files**, all narrow reads; `attachSessionEvidence` and
`readSessionWorkflowState` still have zero non-test callers.

**Shrinkage: the largest of any core cluster.** Part I's four foreign raw
deletes of its maps are ZERO — all route through the seam's flags. The
closest thing the remaining core has to an island.

### C16 — Boot, recovery, materialization
**Owns:** `started:1177`, `sessionAttachmentSettled:1195`,
`materializingSessions:1124`, `recoveryCoordinator:1133`.
Methods (9 — one NEW): `initialize:1666–1769`,
`resolveSessionAgentForStart:1997`, `applyAgentCredentialProfileRef:2047`,
**PARTIAL-DONE — slice 13 (#4024) extracted the interrupted-turn unit into
`InterruptedTurnRecovery` (`interrupted-turn-recovery.ts`): the FileMemory
seam interface, `INTERRUPTED_TURN_MEMORY_SCAN_LIMIT`,
`resolveFileMemoryOccupancy` and the whole boot consumer (~293 lines out).
Four deps, zero owned state, one caller, zero external callers, zero
seam-map rows, zero T9 latches, no Map handle across the seam (the
`memoryAdapters` Map is absorbed at the ctor arrow), no metrics. NOTE the
dep that breaks convention on purpose: `publishEvent` is typed `boolean`,
not `void` as in `CooperativeStop`/`FlowPolicySidecar`, because the M4
refusal branch READS it — a declined publish must leave the boundary row
for the next boot, and `void` would silently convert "declined" into
"done".

The REST of C16 is closed by inspection, on C18/C2 criteria: `initialize()`
stays (T10(2) pins it by the literal `'\n  initialize(): void {'` and scans
to the first column-2 `}`; it is also the T9 latch and owns `started`);
`sessionAttachmentSettled` stays (read by C7's `observeAnswerability`);
`recoveryCoordinator` stays (three non-C16 readers plus two test cast
reach-ins); `recoverSessions` and `recoveredSessionStartOptions` stay
because they are dep TABLES for `recoverOrchestrationSessions`, already
extracted to `orchestration-session-state.ts` — moving them nests one
options interface inside another, ~22 deps for ~176 lines, the exact
criterion §II.5 used to close C2. `materializingSessions` +
`materializeRecoveredSession(Once)` is the one constructible-but-not-worth-it
cut (~16 deps, an unavoidable event-store handle across the seam, and a
`providers/__tests__` cast re-point) — recorded as a deferred OPTION, the
way §II.3 C1 records the stream-consumption half, not as a verdict.**

Pre-extraction derivation follows.
**`consumeInterruptedTurnBoundaries:6752–6897` (NEW, station#4080 slice 1,
fired fire-and-forget from `initialize:1744`)**, `recoverSessions:6898`,
`recoveredSessionStartOptions:6942–7005`, `materializeRecoveredSession:7006`,
`materializeRecoveredSessionOnce:7020`, `evictCollidingAttachedAliases:7086`.
External callers: **1 file** (`runtime-initialize.ts:564`).

**Shrinkage: negative in size, positive in shape** — `recoverSessions`'
quarantine closure is three named steps + one flagged seam call (6909–6914);
`evictCollidingAttachedAliases` one seam call (7114). `initialize()`'s chain
is four named steps with a third un-awaited tail (T9).

### C17 — Connection smoke
**DONE — extracted by slice 9 (#4195) → `ConnectionSmoke`
(`connection-smoke.ts`); the data below is the pre-extraction derivation.**
**Owns nothing.** One method: `runConnectionSmoke:4268–4551` (284 lines).
Raw-field surface is now **one read** — `threadProviders.has` at 4480; the
`sessionOwnerCache` delete Part I recorded is
`sessionAuthz.invalidateSessionOwner(threadId)` at 4549. Also touches:
`internalStops.arm` ×2 (4484/4506, deliberately never rescinded — consumed
downstream by turn-completion-notifications), C1's deadline helpers
(4475/4485/4498/4507/4520), C12's `dispatch` ×3, C10's `readSessionMessages`
(4392, the slice-4 forwarder), `initialize()` (4271),
`eventStore.deleteThread` (4548). External callers: **1**
(`station-runtime.ts:2885`). No Proxy-set membership; zero cast reach-ins.

**Shrinkage: material and specific — the cleanest cut in the core.**

## II.4 Traps, re-anchored (T1–T9) and new (T10–T13)

- **T1** — `deltaCoalescer`'s field initializer captures `this`: now
  1160–1174 (rationale 1168–1169). `clientOriginTurns:1067` is the one
  remaining argument-free initializer on the service
  (`commandEvidenceRoutingPolicy` moved into `FlowPolicySidecar` with
  slice 11, where it is again an argument-free initializer — same trap,
  new file). New inverse case documented at the `turnProgress` docblock
  1045–1054: a collaborator whose deps capture an `options.*` value eagerly
  (`loadAgentExecutionConfig`, 1231) cannot be a field initializer at all.
- **T2** — RESOLVED and pinned. Seam `forgetThreadState:6077–6097`; subset
  table docblock 6062–6069; six call sites 1602 (ctor → C6), 5583, 6099,
  6226, 6911, 7114. Part I's six-copy table is historical.
- **T3** — the test Proxy: `orchestration-service.test.ts` is now 18,161
  lines; `internalObserver` 606–700, `firstScope` 610–618 (8 names),
  `secondScope` 620–632 (12), the `Omit` 481–505. Second copy:
  `orphan-request-reconciliation.test.ts` 97–104 / 105–117.
- **T4** — callback-only inventory (current): `monitoringContextFor:5283`
  (bridge ctor 1521); the completion-gate closure (slice 11: was three
  callback-only service methods, now ONE delegated call —
  `flowPolicy.prepareCompletion` — with the three bodies module-owned);
  `projectAndPublishEvent` (also `sessionLifecycles.publish`, 1412);
  `publishCanonicalEvent` (also the coalescer flush, 1166);
  `recordStateDuration` (also 1414); `restoreSession`/`quarantineSession`/
  `setRestarting` (only via `createCredentialRecoveryModule`, 1632/1636/1637);
  `clearAbandonedAdoptionMemory`/`logAdoptionCleanupFailure` (only via
  adoption deps 1356/1358); `withAcceptedModelLaunchPlan:6192` (only via
  `recoveredSessionStartOptions:6958`). Still no `.bind(this)` anywhere.
- **T5** — load-bearing orderings, re-anchored: 6466–6472 before 6474
  (stop-settle before quarantine gate); 6423 vs 6488 (raw vs merged delta
  observe); 6418–6421 (delta observe gated on not-quarantined); 6425–6442
  ("the coalescer took it" boolean gates four downstream behaviours at
  5402–5428); 6595–6604 before 6606 (owner invalidation before SSE emit);
  5389–5395 (`turnIdentityAnchorForEvents`, not `activeTurnIdForEvents`);
  `InternalStopSuppression.arm`'s narrowed read via ctor dep 1277–1282.
- **T6** — cast reach-ins as of today: 55 `as unknown as` sites in the main
  suite; the private-member pins by cluster: C2 `projectAndPublishEvent`
  (5 blocks), C6 forwarders (17 blocks — the largest), C3 `turnProgress` (9),
  slice-6 `sessionAuthz` (5, incl. `SeamInternals` 3674–3685), C18
  `monitoringContextFor`+Set (1 block, 6745), C13 forwarder (6527, 6699),
  C7 `sessionAdapters` (4), slice-7 module (4950), C15 pair (slice 11: re-pointed through `targetedService.flowPolicy.*`, and `SeamInternals` gained a nested `flowPolicy` record with an unmapped-field throw), C4
  `pendingTurnInterrupts` (3108), C16 `recoveryCoordinator.options` (4950).
  `orphan-request-reconciliation.test.ts` has zero cast reach-ins.
- **T7** — `liveAdoptionOwners` in `attached-session-adoption.ts:72`;
  wired 1669/2225; pinned by T10(2).
- **T8** — `orchestration-source-invariants.test.ts` pins the service path
  in `SCANNED_ROOTS` (:49–53). Unchanged.
- **T9** — `initialize:1666–1769`; `started` 1667/1668; the un-awaited chain
  1675–1768; `.finally` sets `sessionAttachmentSettled:1724` even on failure
  AND now fires `interruptedTurns.consume()` fire-and-forget (slice 13 moved
  the body to `InterruptedTurnRecovery`; the call, its `.catch` and its
  warning text stay in `initialize()` verbatim, so this tail is unchanged)
  (a third un-awaited boot tail), publishing
  `session.attachment.settled:1725` to the receipt bus. Forwarders carrying
  the latch that would move with a cluster: `listSessions:2321`,
  `listSessionReadModel:2354`, `listAgentRuns:2416`,
  `listProjectSessionBoard`, `readSession:2583`, `readSessionFlowRun:4635`,
  `readSessionBuilderRun:4665`, `attachSessionEvidence:4719`,
  `readSessionWorkflowState:5004`, `runConnectionSmoke:4271`, plus the
  `SessionLifecycleModule` dep at ctor 1370.

**T10 — The ctor is a source-invariant surface, byte-exact.** Three tests
assert against this file's literal text: (1)
`orchestration-service.test.ts:4984–4985` pins the `setRestarting` writer
closure INCLUDING its twelve spaces of indentation — reflowing that arrow
reds a guard whose failure reads like a behavior break; (2)
`attached-session-adoption.test.ts:196–215` pins
`this.adoption.registerOwner()/unregisterOwner()` exactly once each, inside
bodies located by the literal strings `'\n  initialize(): void {'` and
`'\n  async shutdown(): Promise<void> {'` — changing either signature reds
it; (3) `orchestration-service.test.ts:3780–3821` requires every
`forgetThreadState` site to pass an INLINE object literal (a hoisted
`const flags` silently drops a row) and every docblock caller label to match
`[A-Za-z.]+` (a digit, hyphen, space, or backtick breaks the row count).

**T11 — Retained forwarders are biome-deletable; two are held by one
in-file caller each, one by the file's only biome-ignore.** `restartCredentialProfileRecoverySession:1800` (the file's only
biome-ignore, 1799); `quarantineCredentialProfileRecoverySession:1810` held
by the ctor closure at 1636 (deliberate asymmetry, comment 1806–1809);
`withAcceptedModelLaunchPlan:6192` held by `recoveredSessionStartOptions:
6958`. "Finishing the job" on any of these deletes a method 4–8 test casts
name. Slice 11 adds two PUBLIC forwarders with **zero callers of any
kind** (`attachSessionEvidence`, `readSessionWorkflowState`, delegating to
`FlowPolicySidecar` with their T9 latches). Public members survive biome's
unused-member pass, so nothing will ever prompt a reader about them. The
first draft of this paragraph called them "REST-facing surface", and the
moved docblock said REST callers resolve a task slug through
`readSessionWorkflowState` before reading `/api/projects/:slug/workflow` —
that route exists but reaches the sidecar service directly, so the claim
was a label nothing derives (caught in review, both copies corrected).
They are retained public API surface, not a dependency: deleting them
breaks no caller, and the only thing standing on either name is
`orphan-request-reconciliation.test.ts`'s facade list.

**T12 — The metrics mock resolves by module specifier.** The suite mocks
`'../../../telemetry/metrics.js'` (test :114). A collaborator counting a
metric must import the specifier resolving to the same module id
(`'../../telemetry/metrics.js'` from this directory) — a barrel or different
depth gets the REAL counter under a mocked suite and fails an unrelated
assertion. Compliant today: model-launch-planning:20–27 (with the in-source
note), turn-progress-tracker:6, session-authorization:7,
conversation-lineage:18, flow-policy-sidecar (three counters, with the
in-source T12 note).

**T13 — Delegated map writes are invisible to `.set(` greps.** Six sites
hand `this.threadProviders` to `resolveOrchestrationAdapterForThread`
(1830, 3493, 3946, 4011, 4189, 4216 — writes at
`orchestration-session-state.ts:141/146/153`); two hand both core maps to
`trackOrchestrationSession`/`projectOrchestrationEventToReadModel`
(6271–6272, 6532–6533 — writes at :107/111). A cluster extraction moving
one of these eight sites moves a write it does not own, and neither the
seam invariant nor a grep will notice.

## II.5 Core sequencing — the recommendation

**★ DONE — slice 9 (#4195) extracted C17 → `ConnectionSmoke`
(`connection-smoke.ts`): eleven lazy-arrow deps, zero owned state, the
`initialize()` latch on the service forwarder, both never-rescinded arm
sites now guard-pinned (the second had no observer until this slice), and
the owner-cache invalidation on the smoke tail guard-pinned (it had none).
The C1 gate is now satisfied: the deadline helpers' only remaining non-C1
consumer is C12's `runCleanupWithinDeadline` at 3827.** Original argument
kept for the record: C17 → `ConnectionSmoke`. Every criterion satisfied at once:
zero owned fields, ONE raw map read (4480), one method, one external caller,
no Proxy membership, zero cast reach-ins, contiguous tests. The old argument
against own-nothing clusters is wrong here for a specific reason: C17 is the
file's only remaining proof that a cluster can be cut on the strength of the
eight seams alone — its dep closure is eight named methods plus ONE map
read (C7's `threadProviders.has`, 4480 — see coupling 4).
Hardest couplings a plan pass must solve: (1) the C1 deadline helpers
(4475/4485/4498/4507/4520) become deps, not moves, and `adapterStopTimeoutMs`
must close over the live option; (2) the two never-rescinded
`internalStops.arm` calls (4484/4506) — the plan must state the smoke path
deliberately leaves suppression armed; (3) `readSessionMessages` (4392) deps
over the SERVICE forwarder to keep the T9 latch; (4) the one map read —
`threadProviders.has(threadId)` at 4480 — becomes a named boolean dep
(`hasThreadProvider` or similar), never a Map handle, so C7's terminal
rename inherits no new raw reader.

**★ DONE — slice 10 (#4204); see §II.3 C4. Original argument kept for the record: C4 → `CooperativeStop`.** Unblocked today; owns two maps with all
writes internal; zero external callers; proves a live-mutable-state cluster
can move. Hardest couplings: (1) C2's settle-read at 6466 becomes a module
method called at exactly that position, above the quarantine gate — warrant
a source invariant on the relative order; (2) the `sessionReadModel.set` at
6039 becomes a named dep, never a move; (3) `forgetLiveUserSession`'s flags
move to the ctor seam, slice-7 style, keeping the six-site/one-file pin and
updating the T10(3) label in the same diff.

**★ DONE — slice 11 (#4218); see §II.3 C15. Original argument kept for the record: C15 → `FlowPolicySidecar`** (after C4 — both churn the seam's ctor
flags). Seven owned fields, zero foreign raw writes, the biggest island.
Hardest couplings: (1) `sessionLifecycles.prepareCompletion` (1376–1387) —
the module owns the whole closure body, not three deps; (2) the ingest-loop
call positions at 5408/5409 gated on the T5 boolean; (3) the two flagged
seam branches route through the module (slice-6 shape) and the
`SeamInternals` fixture re-points.

**★ PARTIAL-DONE — slice 12 (#4024) as `AdapterRetirement`; see §II.3 C1 for the three-way split (retirement moved, inventory closed by inspection, streams recorded as a deferred option). Original argument kept for the record: C1 → `AdapterLifecycle` (expect PARTIAL; gate: C17 first** — C17 is
one of exactly two non-C1 consumers of the deadline helpers, and the one
about to leave; the other is C12's `dispatchWithReceipt`, whose single
`runCleanupWithinDeadline` call at 3827 stays and becomes a dep or a
retained helper — the C1 plan pass must account for it). Retirement/inventory half
moves; `consumeCurrentAdapterEvents`, `finalizeStoppedAdapterSessions`, and
the currency asserts stay beside the ingest loop. The reason a clean cut
does not exist: C2's `finally` writes two C1 fields (5509–5515), and C1
launches C2's loop (2107).

**Then C16 → `BootRecovery` (expect PARTIAL; gate: C1 and C15 first — the C15 half is satisfied by slice 11; C1 remains** —
C1 because `recoveredSessionStartOptions` closes over `assertAdapterReady`
(6946) and the adapter-currency helpers a C1 partial will re-home; C15
because `recoverSessions`' quarantine closure declares seam flags and both
slices churn the ctor flag declarations**).**
`recoverSessions` + `recoveredSessionStartOptions` + materialization +
`evictCollidingAttachedAliases` move; **`initialize:1666` stays** — it is
the T9 latch, pinned by T10(2) against its literal declaration string.

**★ DONE — C2 closed by inspection (slice 14, #4024); see §II.3 C2 for the evidence, the twelve load-bearing orderings it now carries, and the ONE recommended sub-cut (turn-provenance, 117 lines / 2 deps, shipped with that closure). Original argument kept for the record: C2: close by inspection — on ITS OWN criteria, which differ from C18's.**
C18 was closed because nothing was left (the behavior had already been
extracted; ~30 lines of glue remained). C2 is the opposite shape: ~600
lines remain and shrank not at all — the closure ground is that the
cluster OWNS nothing, is the single path every canonical event takes, and
a module would take a dep per field while making nothing unreachable
(indirection without a seam). Closure deliverable: a section documenting
the six T5 orderings against current lines, PLUS the 6466-before-6474
stop-settle ordering pinned by the source invariant the C4 slice ships
(one standard for that ordering, owned by the slice that moves the settle
side).

**C12: two mini-slices, not a cluster slice, and not soon.** The steer
serialization unit (`inFlightSteers:1092` + 4092/4105/4171 + the rationale
at 1068–1091) and the receipt ledger unit (`persistReceipt:6246`,
`readCommandReceipt:4553`, `listCommandReceipts:4565`, `commandThreadId:
6217`, `warnBestEffort:6206`). The 942-line switch is the thing every
forwarder latches through — it is not a slice.

**C7 goes last — CONFIRMED.** 22 of 134 members touch `sessionReadModel`
(essentially flat across eight extractions: 16.7%→16.4% — the extractions
did not materially reduce the reader population, they re-routed it through
six ctor read-closures); 32 reference lines; 10 external caller files. Plan it as the
epic's TERMINAL slice and as a RENAME rather than a move: the four
inventory maps become a `SessionInventory` collaborator whose accessors
replace the remaining raw sites, with `trackSession:6250` and the seam as
its only writers — and the T13 delegated-write helpers move into it in the
same slice, or the seam is a fiction.

## II.6 Corrections to Part I (wrong in kind at `71699b7c1`)

See the derivation record on #4186 for the full 25-row table. The rows that
change decisions: Part I's §1 lists eight fields that no longer exist on the
class; `inFlightSteers:1092` and `consumeInterruptedTurnBoundaries:6752` are
NEW and absent from Part I; C17's `sessionOwnerCache` write and C15's four
foreign deletes describe deleted code; `commandProvider` re-attributes from
C7 to C12; `orchestration-review-executor.ts` takes the service whole (C12
external callers 6→7); C7 external callers 8→10; the §3 matrix lacks the
delegated-write category (T13); **eight of the TEN epic-built collaborators have no
dedicated unit test file** (only `turn-progress-tracker` and
`attached-session-adoption` do; slice 9's `connection-smoke.ts` also ships
without one — its 21 suite cases all drive the service forwarder) — a
standing gap Part I implies is closed.
