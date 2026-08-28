# Decorate session summaries with read-time answerability, not a persisted observation event

## Context

station#1284 shipped a boot-time reconciliation pass that wrote a synthetic
`request.resolved{cancelled}` for requests stranded by an absent provider
adapter. PR #1338's four review rounds accumulated machinery that existed only
to service the write-time shape: a `providerRegistrationSettled` startup
barrier (the cancellation was irreversible, so it had to wait for plugin
registration), a resting-state guard (the synthetic event permanently stamped
lifecycle state), a four-state outcome type, a qualification counter, a
receipt, and a metric. station#1745 named the asymmetry — the pass converged on
WRITE while the approval inbox converged on READ — and proposed projecting the
answer at read time instead.

Branch `feat/1686-shadow-counter-readable-1745-readtime-projection` (commit
`aad1df6c`, PR #1765) implemented that: `projectRequestAnswerability`
(`src-server/services/orchestration/open-requests.ts`) answers per read whether
anything in THIS process can still answer an open request — thread attached →
yes; session past resume (`completed`/`canceled`) → no (`past_resume`); provider
adapter absent → no (`provider_absent`) — and deleted the barrier, the pass,
the synthetic event, the guard, the counter, the receipt, and the metric.
Independent verification passed all ten acceptance claims and caught all twelve
fault injections.

Independent review still found it merge-blocking, on **scope**, not mechanism:

1. **The projection had exactly one consumer** — `attention-projection.ts`. The
   stranded approval notification stays `delivered` forever (nobody actioned
   it — that part is honest), and because the notification popover renders
   `notifications minus attention-projected` (`NotificationHistory.tsx:58-66`),
   dropping the attention card makes the raw row surface in "Recent activity"
   with live Allow/Deny buttons (`NotificationHistoryItem.tsx:35-36`). The card
   the fix was built to remove reappears one surface over, with dead
   affordances attached.
2. **Every other reader of `lifecycleState`/`pendingReview` stays permanently
   wrong for a dead session** (all verified against `main` at `65266272`):
   `sessionDisplay.ts:303-309` (`isTerminalSession` never true, so every
   `!isTerminal` affordance stays enabled), `:311-319`
   (`delegatedTaskPriority` returns 0, so a dead session permanently occupies
   `DelegatedTaskCoordinator`'s single top slot),
   `ProjectSidebar.tsx:51-75` (attention badge permanently inflated; the
   `acknowledged` escape hatch covers only the `completed|failed` branch, so no
   user action clears it), `packages/cli/src/commands/approvals.ts:69-108` and
   `packages/cli/src/commands/operate/derive.ts:46-86` (both hand-fold raw
   events and list the stranded request as pending forever), and
   `orchestration-service.ts:1475,1492-1494` (a hand-copied second
   `lifecycleState`/`pendingReview` fold — the divergent-copy disease
   `open-requests.ts:1-9` exists to prevent).

   A full sweep against `main@65266272` put real numbers on the review's
   "~15": **37 distinct fold sites over these fields, 30 of them decisions**
   (affordance, priority, count, filter — not labels), of which **21 are on
   the far side of HTTP** (src-ui, packages/cli, and the delegation tool's
   cross-environment fetches) and **9 are in-process**. There are **six
   independent summary-emission routes** (read-model, loaded, detail,
   lifecycle-response, SSE snapshot, session-board) plus three sibling wire
   shapes that independently re-declare the same fields
   (`SessionBoardItem` — with an already-drifted hand-copy in
   `packages/sdk/src/query-domains/chatRuntimeTypes.ts:102` —
   `ConversationListItem`, `AgentRunSummary`'s own `hasOpenRequest` fold).
   There is no natural single choke point; only a required type member can
   enumerate the emission sites.

Two findings bound the damage and are part of this record: there is no
retention/cleanup job keyed on session status or `completedAt`, so the
never-stamped terminal state causes no storage growth; and server-side
enforcement is unchanged (`respondToRequest`/`sendTurn`/`interruptTurn` all
fail on adapter absence regardless of persisted state). Nothing became newly
executable — surfaces merely OFFER actions that used to disappear.

The question this ADR decides: **how does the answerability fact reach the
30 decision sites** that fold session state into affordances, priorities,
counts, and filters?

Two structural facts constrain every option:

- Two of the predicate's three inputs (`threadIsAttached`,
  `providerRegistered`) are **process-local and time-varying**. Multiple
  Station instances share `~/.station`; an instance with the adapter and an
  instance without it must truthfully give different answers for the same
  session.
- The CLI and UI are **different processes over HTTP**. They structurally
  cannot compute a process-local fact; it must reach them on the wire or not
  at all.

## Decision

### Option (a) — migrate every consumer to call `projectRequestAnswerability`

**Rejected.** The CLI is a different process; a process-local predicate cannot
be evaluated where the adapter registry does not exist. Structurally
impossible for roughly half the consumers, and for the rest it multiplies
call sites of a fact that should be computed once.

### Option (b) — fold answerability into `projectSessionLifecycle`

**Rejected.** The same event log would yield different `lifecycleState` in
different processes and at different moments — replay-reproducibility of the
lifecycle fold is the property everything else leans on, and this would plant
a label-vs-derivation defect at the widest blast radius in the system.

### Option (c) — persist an honest observation event (`request.unanswerable`)

When the serving process observes provider absence, append an event claiming
only what was observed — never `request.resolved{cancelled}`, which claims a
decision nobody made. The pitch: all consumers converge for free because they
already fold events; supersession handles late registration.

**Rejected, after steelmanning — its honest form contains the projection plus
all the machinery #1745 exists to delete:**

- **The cross-process lie.** The event log records session history — facts
  true for every reader. "No adapter in this process" is not such a fact.
  Process 1 (no adapter for `acme`) appends `request.unanswerable`; process 2
  (which HAS `acme`) folds the same shared log and now reports its own
  answerable session as unanswerable. Fixing that means stamping the event
  with the observing instance and teaching every fold to ask "is this
  observation about ME?" — a process-local read-time computation, i.e. the
  projection again, now with persistence bolted on.
- **The barrier returns.** At boot, before plugins register, every provider
  is "absent." An observer that writes at boot writes falsely (station#1337
  is exactly this misclassification); to avoid it, the write must wait for
  registration settlement — `providerRegistrationSettled` back from the
  grave. Supersession softens the *consequence* of a wrong write (it is no
  longer irreversible) but not the *machinery*: something must notice a late
  registration and sweep every session holding a live `unanswerable`
  observation, which is a reconciliation pass keyed on registration. A missed
  hook or a failed write leaves the log lying indefinitely; mid-window, every
  fold in every process reads the stale observation.
- **"Zero migration" is false.** Folds ignore unknown event methods.
  `collectOpenRequests` deletes only on `request.resolved`; the CLI's two
  hand-copied folds filter on `request.resolved` explicitly. A new event
  method converges nothing until every fold is taught it — and an untaught
  fold **fails silently** (stays wrong), where an undecorated consumer under
  option (d) fails at compile time. The only genuinely zero-migration variant
  is appending `request.resolved{cancelled}` — the dishonest event already
  rejected. The notification store is not event-folded at all
  (`~/.station/notifications.json`), so the popover surface needs its own
  slice under every option; (c) does not fix blocking finding 1 "for free"
  either.
- **It is the more one-way change.** Persisted events live in per-session
  logs forever; every future reader must tolerate the method even after a
  rollback. Under this repo's discipline that shape needs build-behind-flag +
  owner-gated cutover. The projection needs neither.

### Option (d) — decorate the response projection, enforced by the wire type

**Adopted.** Keep the event-log fold pure — no process-local fact ever enters
`projectSessionLifecycle`. Compute answerability once, at the boundary where
`OrchestrationSessionSummary` is handed out, and make it a **required**
member of the wire type so an undecorated summary cannot be emitted and a
16th consumer cannot appear without the compiler naming it. The branch
already proved the mechanism at `attention-projection.ts:77`: a required
`Pick<>` member turned "forgot it" into a compile failure.

The wire shape carries the two things that ARE the claim — whose process, and
when — because a bare boolean strips them:

```ts
answerability:
  | { answerable: true }
  | {
      answerable: false;
      qualification: 'past_resume' | 'provider_absent';
      observedBy: string; // serving instance id
      observedAt: string; // ISO timestamp
    };
```

Consumers **annotate, never silently filter**: the CLI renders "unanswerable
by the serving Station (no adapter for provider `acme`) as of 12:04:03"; the
notification row disables Allow/Deny and names the reason. Silent filtering
on one surface while another doesn't is exactly the mechanism that produced
blocking finding 1. The attention projection remains the one deliberate,
documented suppression (the bell badge is a count of actionable items, and it
subtracts INTO the popover, whose row then annotates).

The `listProjectSessionBoard` hand-copied fold (`:1475`, `:1492-1494`) is
**deleted, not promoted** — it is one of at least three parallel re-folds
layered over `listSessionReadModel`, and crowning one just picks a winner
among copies. The decoration is computed by one function; the **required
type member is what routes every construction site through it**, because the
sweep found six emission routes and no natural choke point — convention
cannot enumerate them, the compiler can.

## Which option can lie (the §6 test applied to the winner)

`answerability` on the wire is a derivation at the moment of emission —
computed by `projectRequestAnswerability` from live registry/attachment/fold
state — that becomes a *record of an observation* in flight. `observedBy`/
`observedAt` are what keep the record honest: the claim is explicitly "as of
T, by process P," not a timeless property of the session. A consumer can
still lazily read `.answerable` and ignore the qualifiers — that residual is
real and cannot be eliminated by the type; it is held down by (1) the
annotate-not-filter acceptance criteria naming the timestamp in rendered
copy, and (2) the enforcement backstop: a stale `answerable: true` fails
loudly at dispatch (the server rejects on adapter absence), and a stale
`answerable: false` clears on the next poll. Neither staleness direction can
make anything falsely executable.

The known "default that decides" inside the predicate is disclosed rather
than hidden: `lifecycleState ?? 'running'` folds an unknown lifecycle toward
*answerable* — i.e. toward SHOWING the card. The permissive direction here is
the visible direction, which is the failure mode we can live with (a dead
card renders and its action fails loudly) rather than the invisible one (a
live approval hidden).

## Failure mode of the chosen design

If the predicate is wrong (a misfiring arm, a registry key mismatch —
compare `runtimeId ?? provider` in `code-quality.md`), every surface of the
serving instance annotates wrongly and the attention badge over- or
under-counts **until the next read after the fix** — nothing is persisted, so
recovery is redeploy-and-refresh, and the `qualification` field makes the
misfiring arm distinguishable in the wild. The blast radius is one process's
rendered claims for the duration of the bug; enforcement is untouched. Under
option (c) the same bug would have persisted false observations into shared
logs that outlive the fix.

The structural cost accepted: the answerability fact is **ephemeral**. No
durable record says "this session was observed stranded at T." If the
receipts culture later needs that historical claim, an observation event can
be added *for that purpose* — as history, consumed by audit surfaces — without
ever feeding affordance decisions. That addition is severable and does not
reopen this decision.

## What would falsify this choice

- A consumer that structurally cannot receive the wire decoration (an offline
  reader of the raw event store with no serving process) turns out to need
  the answerability fact. Only a persisted observation reaches it.
- Evidence that cross-instance caching (a client rendering instance 1's
  summaries while dispatching to instance 2) produces user-visible wrong
  affordances that annotation cannot fix — that would argue the fact must
  travel with the session, i.e. option (c)'s shape with full observedBy
  filtering.
- Per-read decoration cost measured as material on large session lists
  (not expected: the inputs are map lookups against state already in memory).

None of these is currently in evidence. The two options were not, in the
end, genuinely close: option (c)'s honest form is option (d) plus writes,
ordering, supersession sweeps, and a silent-failure migration.

## Consequences

- `OrchestrationSessionSummary` gains a **required** `answerability` member;
  every emission path must route through the single decorator or fail to
  compile. The type-level enforcement is a named acceptance criterion of the
  re-sliced work ("the 16th consumer is a compile error"), pinned by a
  `@ts-expect-error` construction test, not just convention.
- The event log stays pure and replay-reproducible; `projectSessionLifecycle`
  is untouched.
- Deletions from PR #1765 carry over: the barrier, the boot pass, the
  synthetic `request.resolved`, the resting-state guard, the qualification
  counter, the receipt, and the orphan-reconciliation metric. station#1337
  (boot-timing misclassification) is mooted **for HTTP consumers** rather
  than fixed by more ordering: routes come up after plugin loading, so no
  client can observe the pre-registration window. The moot is not
  unconditional — an IN-PROCESS reader added before `configureRoutes` would
  re-observe it, because the fail-open rationale is applied to thread
  attachment (`recoverSessions()` settling) and NOT to provider
  registration, and the two windows are not nested. Nothing persists from
  such a read, so the consequence is a stale rendered claim for one poll,
  not a stored one.
- The stranded notification row stays `delivered` — honestly, since nobody
  decided anything — and is rendered disabled-with-reason, with an explicit
  user dismissal path (a dismissal IS a user decision, so persisting it is
  honest).
- Multi-instance truth: each serving process decorates with its own answer
  and says so. Clients of different instances may see different
  answerability for the same session — that is correct, because the answer
  governs what a dispatch through *that* instance would do.
- **All three** sibling wire shapes that re-declare these fields
  (`SessionBoardItem`, `ConversationListItem`, `AgentRunSummary`) carry the
  same required member; the drifted SDK hand-copy of `SessionBoardItem`
  (`packages/sdk/src/query-domains/chatRuntimeTypes.ts:102`) is re-pointed at
  the contracts declaration rather than extended in place. `AgentRunSummary`
  is the one whose omission the delta review caught: its `status` folds
  `waiting_for_approval` from the same raw open-request evidence, and on
  `main` the boot pass converged that at runtime, so leaving it undecorated
  left a regression on `/api/orchestration/runs` outside the enforcement the
  required member exists to provide. Carrying the decoration gives consumers
  the fact; teaching `status` itself to read it is a behaviour change tracked
  separately (station#1798).

- The fail-open window closes in a `finally`, not on the success path. The
  startup chain does unguarded store reads, so a rejection would otherwise
  leave the window open for the process lifetime — the opposite of what this
  record claims — and skip recovery reconciliation. Settling on failure
  claims only what is true: this process attached whatever it managed to.
- The work is re-sliced so each consumer surface lands independently
  reviewable, each with a rejection path a test executes — see the slice
  issues cross-referenced on station#1745. The 21 client-side decision sites
  are NOT all fixed in this arc: the review-blocking surfaces (attention,
  notifications, session display/coordinator/sidebar, CLI approvals) get
  slices; the remainder (home lanes, mobile activity groups,
  background-tasks store, snapshot handlers, the delegation tool's own
  fourth fold) are a tracked residual slice with the full enumerated site
  list — a disclosed follow-up, not silent absorption.
