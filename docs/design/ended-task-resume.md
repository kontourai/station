# Resuming ended Tasks

Status: implemented behind the default-off `task-resume` Feature Preview
(personal Stations only), following the revised option B the owner approved on
2026-11-06 in [the decision record](../decisions/ended-task-resume.md) for
[#4554](https://github.com/kontourai/station/issues/4554). Choices the design
left open and the evidence are in [Implementation](#implementation). Sections
up to it are the reviewed design; where the implementation differs it says so
there. Focused route and service tests are the evidence; no release, provider
or runtime qualification is claimed.

## The question

With the **Task tracker follow-ups** preview on, Station keeps recording
comments, reviews and check runs on an ended Task's followed GitHub items for
14 days and shows them in the Task brief. Nothing acts on them. When a
reviewer asks for one more change after the Task is `done`, a person has two
choices today: start a new Task on the same work item (allowed, because only
a Task that is not done or canceled holds the item), which loses the old
Task's memory and kept worktree, or message the old lead Session directly,
which leaves the Task marked `done` while work continues.

#4554 asks whether a follow-up may resume the ended Task, and under whose
authority.

## What exists today

Source inspected on `origin/main` at `30d50aa152f5` (2026-11-06). No test was
run for this proposal.

- **No way out of an ended status.** `TASK_STATUS_TRANSITIONS` gives `done`
  and `canceled` no transitions
  ([`task-graph.ts`](../../packages/contracts/src/task-graph.ts)).
  `PATCH /api/tasks/:taskId/status` checks only that table, the dispatch
  reservation, and the route's operate-tier scope
  ([`tasks.ts`](../../src-server/routes/orchestration/tasks.ts),
  [`pairing-route-scopes.ts`](../../src-server/security/pairing-route-scopes.ts));
  no Station Control tool reaches it.
- **Ending has side effects.** `TaskGraphService.updateTaskStatus` releases
  the Task's assignment claim and then finalizes the Task worktree outside
  the status mutation: removed when nothing would be lost, otherwise kept
  with a reason (`session-running`, `uncommitted`, `unpushed`, ...) and
  retried when a turn or Session ends
  ([`task-graph-service.ts`](../../src-server/services/projects/task-graph-service.ts),
  [Task dispatch: Finishing](task-dispatcher.md#workspace-isolation)).
  Dispatch admits a Task only from a status that may move to `ready`.
- **No end time.** `TaskRecord` has `createdAt`, `updatedAt`, `dispatchedAt`
  and `createdBy`, but no `endedAt`. The follow-up poller uses `updatedAt` as
  the end time, so an edit after the end extends following
  ([`task-follow-up-poller.ts`](../../src-server/services/work-item-providers/task-follow-up-poller.ts)).
- **Close-on-merge is sticky.** `closeOnMerge` stays on the record after the
  Task ends; `setCloseOnMerge` refuses on an ended Task.
- **Wake authority is the lead owner's.** `TaskFollowUpWake` sends as the
  lead Session's recorded owner after `canUseTaskSource(context, task, owner,
  execute = true)`, re-checked when the inbox places the entry. It skips done
  and canceled Tasks and stopped leads, and wakes on any Task that is not
  ended, whichever lead `TaskRecord.sessionId` names
  ([`task-follow-up-wake.ts`](../../src-server/services/work-item-providers/task-follow-up-wake.ts),
  [`context-efficiency-runtime.ts`](../../src-server/runtime/context-efficiency-runtime.ts)).
- **Project access is Station's, not GitHub's.** `canUseTaskSource` resolves
  access through the Project's shares and membership admissions (`active`
  members whose actions include `execute`). GitHub's `authorAssociation`
  (`OWNER`, `MEMBER`, `COLLABORATOR`) describes the author's relationship to
  the repository and is used only to classify follow-ups.
- **No GitHub identity link.** Station's verified identities are
  `tailscale-serve`, local accounts (passkeys, OIDC with a hashed subject),
  and paired devices. The `kontour-account` provider that could federate a
  GitHub sign-in is reserved and unimplemented
  ([`identity-source.ts`](../../src-server/services/identity/identity-source.ts)).
  The follow-up reader records an author's login, not GitHub's user id
  ([`github-follow-up-reader.ts`](../../src-server/services/work-item-providers/github-follow-up-reader.ts)),
  and reads a comment's body once, when it is first recorded.
- **The agents' account is the gh login.** Agents post tracker updates with
  the host's `gh` login, so comments made with it never wake the lead. On a
  single-user Station that is also the person's own account.

## Options

| Option | What a follow-up on an ended Task does | Recommendation |
| --- | --- | --- |
| A. Notify only | Recorded and shown; the ended Task header counts follow-ups since it ended | Safe, but leaves the new-Task workaround |
| **B. A person resumes `done` Tasks** | Recorded and shown; the Station operator in person chooses **Resume**, which moves it to `ready` | **Recommended** |
| C. As B, and `canceled` Tasks too | Same, for canceled Tasks | Not recommended; see [Which Tasks](#which-tasks) |
| D. GitHub resumes automatically | A qualifying GitHub comment moves the Task back to work | Not safe today; see [Automatic resume](#automatic-resume-from-github) |

## Automatic resume from GitHub

Option D cannot be supported safely with the identity Station has today:

1. **No trusted mapping from a GitHub author to a Station principal.**
   `authorAssociation` says nothing about current access to a Station
   Project, and Station stores no verified GitHub account for any principal.
   Logins can be renamed and later reused, so even a typed login mapping
   would be spoofable over time.
2. **The person and the agents share an account on a single-user Station.**
   The poller cannot tell a person's comment from an agent's on that account,
   which is why those comments never wake a lead. A resume trigger on that
   account would let an agent resume its own ended Task.
3. **A comment is not an instruction.** Follow-up text is untrusted data,
   possibly quoting others, and may be edited after Station read it. Treating
   any comment, or a phrase inside one, as a command to restart work would
   let anyone who can comment steer Station.
4. **Ending was a person's decision.** A `done` or `canceled` status was set
   by a person, by a board or repair action, or by close-on-merge, which a
   person opted into. Reversing it without a person in Station replaces that
   decision with whatever account commented.

What would have to exist first, as its own decision:

- a verified, revocable link between a Station principal and a GitHub
  account, keyed by GitHub's numeric user id and proven by GitHub OAuth by
  the signed-in person (for example the `kontour-account` provider), and a
  reader that records the author's user id;
- agents posting with a separate identity (for example a GitHub App), so a
  person's own account can be trusted as a trigger;
- a per-Task opt-in, set by a person in Station;
- an explicit trigger whose content Station verifies at the moment it acts,
  rechecked against the linked principal's current `execute` access.

Until then, the safe use of a follow-up is to show it to a person who can act.

## Recommended design (option B)

### Who may resume

The first version admits only the Station operator in person, through a
person-only route. Agents, paired devices without that proof, GitHub, and
ordinary account members cannot resume:

- The route requires both its operate-tier scope and the server-owned
  `isOperatorInPersonNotAgent` witness. Absence from Station Control alone
  is insufficient; direct HTTP requests must pass the same checks.
- The resumer must also have current Task read and Project execution access,
  checked through the canonical authority owners immediately before the
  synchronous store mutation, against the same Task incarnation (`createdAt`)
  and Project. Unknown authority refuses.
- Project membership is held in a separate store. This check is not an atomic
  transaction across membership and Task state; a subsequent revocation
  prevents execution through fresh dispatch authorization. Resume itself
  starts no work.
- Do not equate Project `execute` membership with permission to dispatch via
  the current HTTP route. Broader member access needs a separate decision and
  one shared admission check used by both resume and dispatch. The first
  version must prove the in-person operator can perform both.

### Which Tasks

- **Tracker-backed `done`**: resumable within the window only with a GitHub
  `workItemRef` and without `createdBy: automation-rule`. Non-GitHub, repair,
  and other automation-owned Tasks are refused; their external lifecycle
  owners are outside this proposal.
- **`canceled`**: not resumable. A person stopped the work on purpose;
  starting a new Task on the work item is the explicit path, and the
  one-open-Task rule already allows it. (Option C changes only this.)
- **`blocked`**: not ended, so not in scope. A person unblocks it with the
  existing status change; follow-ups already wake its lead except for failing
  checks.
- **Any other status**: refused as not ended.

### End time and window

- Add `TaskRecord.endedAt`, written in the same mutation as every move into
  `done` or `canceled` (status change, board or repair action,
  close-on-merge), and never changed by edits.
- Resume is allowed while `now - endedAt` is at most 14 days, the same duration
  the follow-up poller uses. The dialog shows retained observations, which
  may be absent or stale when polling is disabled, unavailable, or backing
  off. This window does not establish freshness. The poller uses `endedAt`
  and falls back to `updatedAt` only for
  records written before the field existed.
- A Task with no `endedAt` (ended before the field existed) is refused as end
  time unknown. Inferring it from `updatedAt` would let an edit extend the
  window.

### What resume does

Enter the existing in-process Task worktree custody queue first, then use
one synchronous Task store mutation inside it. Never hold the store lock
while awaiting git or another asynchronous operation. The custody queue does
not provide cross-process exclusion; deployment must keep a single lifecycle
writer, or implementation must add a shared custody mechanism before claiming
this guarantee across processes:

- Moves the Task from `done` to `ready`. This is not a new entry in
  `TASK_STATUS_TRANSITIONS`; the general status route still refuses it.
- Clears `endedAt` and `closeOnMerge`. Otherwise a resumed Task whose kept
  pull requests are all merged could close again on the first refresh after
  dispatch moves it into `in_progress`; the operator can opt in again.
- Clears the active `sessionId` and `dispatchedAt` attachment while retaining
  prior Session identity and dispatch history in the resume record. This
  prevents every automatic lead wake, including Task questions and tracker
  follow-ups, from targeting the earlier lead before a new dispatch.
- Appends a resume record (below).

Resume starts no Session work and sends nothing to any Session. The person
then dispatches the Task through the existing dispatcher, which re-checks
admission, acquires the claim, reuses the kept Task worktree or provisions a
new one, and starts a new lead whose brief includes the retained follow-ups.
The UI may offer **Resume and dispatch**, which makes the two calls in turn;
each is authorized on its own.

Leaving the Session out keeps every existing guarantee in place: dispatch
already owns durable start, claim, worktree and restart recovery, and the
inbox stays the only delivery path.

### Authority and the mandate

- The Task's mandate (title, description, Task document, `createdBy`,
  `workItemRef` and its provenance, earlier dispatch records and Task memory)
  is not edited by resume.
- New work runs only under the in-person operator's current dispatch
  authority. The first implementation must exercise that exact request path
  and its fresh authorization, including revocation between resume and
  dispatch. The earlier lead's owner does not authorize subsequent work.
- If the resumer is not the person who dispatched the earlier lead, the
  authority over the Task's next work changes. That happens only through this
  explicit action and is visible in the resume record and the confirmation
  dialog, which names the earlier lead's owner.
- All automatic lead wakes and their inbox placement rechecks must resolve
  the current attachment. Resume clears it atomically; Task questions with
  no lead remain held, and tracker observations remain recorded. A new
  dispatch attaches a lead. Reservation expiry must restore the empty
  attachment captured after resume, never the historical lead. The previous
  lead may still be messaged explicitly in Station, but automatic delivery
  cannot start it under its old owner's authority.

### Resume record

An append-only record stored with the Task in the same write as the status
change, keyed by Task incarnation:

| Field | Value |
| --- | --- |
| `resumeId` | Client-generated id; the idempotency key |
| `taskId`, `taskCreatedAt` | The incarnation |
| `fromStatus` | `done` |
| `endedAt` | The end time that was cleared |
| `resumedAt` | Server time |
| `resumedBy` | The resumer's principal id |
| `clientOrigin` | The request's authenticated origin |
| `reason` | The person's own text, at most 500 characters |
| `previousLeadOwner` | The earlier lead's recorded owner, if any |
| `previousSessionId`, `previousDispatchedAt` | The attachment cleared by resume, if present |
| `followUpsSeenThrough` | The latest follow-up `recordedAt` shown in the dialog |

At most 20 resumes per incarnation; the 21st is refused (start a new Task).
The Task brief shows each resume as a Station line with the reason quoted
under the resumer's label, like other text people write.

### Exactly once, races and restarts

- **Idempotent and authorized.** Bind the receipt to Task incarnation,
  `resumeId`, and authenticated `resumedBy`. Recheck the same principal's
  current in-person witness, read access and execution authority before any
  replay disclosure. A different principal or revoked access is refused
  without revealing the receipt. An authorized same-input retry returns
  the immutable resume receipt and the current authorized Task view with
  `replayed: true`, never a saved `ready` snapshot. Different inputs conflict.
  Check for an authorized replay before the status/end-time compare and set,
  because a successful resume already cleared `endedAt`. A lost response is
  recovered with the same principal and `resumeId`.
- **Compare and set.** The request names the `taskCreatedAt` and `endedAt`
  the person saw. A different incarnation, status or end time refuses with
  the current state and writes nothing, so of two concurrent resumes only one
  commits.
- **Atomic Task state.** The status, cleared attachment and fields, and
  resume record are one durable Task-store write; after a crash the Task is
  either resumed with its record or untouched. This does not make external
  authority, worktree, or automation stores part of the transaction.
  Automation-owned Tasks are refused rather than reconciling their lifecycle
  stores here.
- **One open Task per work item.** Inside the mutation, resume refuses when
  another Task that is not done or canceled holds the same work item,
  naming it, as `POST /api/tasks` answers 409 today.
- **Dispatch reservation.** Refused while one exists, as status changes are.
- **Running turn.** Refused when any Task-associated Session has an open
  turn, and when the retained worktree path is busy. These are distinct
  checks: finalization currently checks path occupancy. Resume never
  interrupts a turn, and dispatch must recheck before sharing a kept path.
- **Worktree finalization.** Resume runs inside the Task custody queue.
  Finalization already re-reads status inside that queue, so a finalization
  that runs after resume does nothing. One that finishes first leaves the
  worktree removed or kept, and the next dispatch reuses or provisions it.
  This ordering is process-local; a second lifecycle writer requires shared
  custody rather than relying on this queue.

### GitHub text and actors

- The confirmation lists follow-ups recorded since `endedAt`, newest first,
  with each item's class (`member`, `bot`, `ci`, `other`), association, and
  whether it was written with Station's own `gh` account, then the text quoted
  as data under the public-tracker label.
- Nothing from GitHub fills the reason, the Task document or any
  instruction. The new lead reads follow-ups through the brief, as quoted
  data, exactly as today.
- Bots, checks, other authors and the agents' own account can prompt a person
  to look; none of them can resume.

### Refusals

Every refusal writes nothing and returns a stable code:

| Code | When |
| --- | --- |
| `task_resume_unavailable` | Preview off, hosted mode, or the store cannot be read |
| `task_resume_not_permitted` | No in-person operator witness, operate tier, current read/execute authority, or same-principal replay authority |
| `task_resume_not_supported` | No GitHub work item, or Task is owned by automation |
| `task_resume_not_ended` | The Task is not `done` |
| `task_resume_canceled` | The Task is `canceled` |
| `task_resume_end_unknown` | No `endedAt` |
| `task_resume_expired` | More than 14 days since `endedAt` |
| `task_resume_conflict` | Incarnation, status or `endedAt` differ from the request, or a `resumeId` is reused with other inputs |
| `task_resume_work_item_taken` | Another open Task holds the work item |
| `task_resume_dispatch_reserved` | A dispatch reservation exists |
| `task_resume_turn_running` | A Task Session has an open turn, or its retained worktree is busy |
| `task_resume_limit` | 20 resumes already recorded |

When access, the end time or the Task's state cannot be established, resume
refuses; it never falls back to a weaker check.

### Storage compatibility

Store the bounded resume records alongside Task state in the same Task-store
write. The current decoder accepts an exact field list, so `endedAt` and the
resume collection require an explicit format migration and decoder update.
Legacy records lack a trustworthy end time and remain nonresumable. Before
migration, retain a recoverable pre-migration snapshot. Older Station builds
cannot read the new fields: downgrade requires restoring that snapshot, which
loses later Task changes, or a supported export/conversion tool. Document that
choice in the implementation and never silently drop resume records to make
an older decoder accept the file.

## Surfaces if implemented

- **Preview**: a new Feature Preview, `task-resume`, off by default and not
  offered in hosted mode. It does not depend on the follow-ups preview;
  without it the dialog shows no follow-ups.
- **Capability**: `taskResume` in `station-capability-flags.ts`, withdrawn in
  hosted mode, with a row in `consumed-capability-flags.test.ts`.
- **Contracts**: `TaskRecord.endedAt`; `TaskResumeRecord`; the request
  (`resumeId`, `expectedCreatedAt`, `expectedEndedAt`, `reason`,
  `followUpsSeenThrough`) and result (`task`, `resume`, `replayed`); a shared
  `taskResumeRefusal(task, now)` so the UI shows the same reasons the server
  enforces. `TASK_STATUS_TRANSITIONS` keeps `done: []`.
- **Route**: `POST /api/tasks/:taskId/resume`, operate tier plus the
  in-person operator witness, personal mode, added to
  `pairing-route-scopes.ts` and absent from every Station Control tool.
- **SDK and CLI**: a client method gated on `taskResume`. A host without the
  flag is reported as unable to resume, with updating as one remedy. A CLI
  command taking `--reason` is included only if it can present the same
  server-verifiable in-person witness; otherwise record a CLI parity
  exemption and leave that surface unavailable.
- **MCP**: none. Agents cannot resume.
- **UI**: the ended Task header shows the end date, the resume deadline and
  the number of follow-ups since the end. **Resume** opens the confirmation
  described above with the reason field; a refusal disables it and says why.
- **Docs**: this record becomes an implemented contract;
  [Tracker-backed Tasks](tracker-backed-tasks.md), the API reference, the
  Task guide and the decision record are updated with it.

## Tests required

At the real boundaries (the mounted route with a real `TaskGraphService`,
Task store, follow-up store, membership service and dispatcher), not helpers:

- A local operator resumes a `done` Task: status `ready`, `endedAt` and
  `closeOnMerge` cleared, one resume record, and the next dispatch starts a
  lead whose brief shows the retained follow-ups and the resume line.
- Refusals for each code above, each asserting nothing was written.
- Ordinary account members and agents are refused even with operate or
  Project execute permission; the in-person operator succeeds through both
  resume and dispatch. Revoked or unknown read/execute authority refuses
  resume/replay/dispatch, with no provider start or receipt disclosure.
- Non-GitHub and automation-owned Tasks are refused without touching their
  lifecycle stores; the operator's changed authority is recorded.
- A Station Control request to the route is refused by the authority guard.
- Same-principal authorized replay returns one immutable receipt plus the
  current Task view, including after dispatch. Another caller or revoked
  caller receives nothing. Different inputs conflict; two concurrent resumes
  commit one; a restart after write but before response replays the receipt.
- A finalization queued before resume does not remove the worktree; a kept
  worktree is reused by the next dispatch; a removed one is provisioned.
- After resume, both a Task-room question and a tracker comment cannot wake
  the earlier lead, including entries queued before resume and checked again
  at placement. Questions remain held and reach the newly dispatched lead.
  Expiring a dispatch reservation restores no earlier lead attachment.
- Format migration retains history, legacy unknown end times refuse, and
  downgrade recovery follows the documented snapshot/conversion procedure.
- The poller follows by `endedAt`, so an edit after the end no longer extends
  following, and a pre-field record still uses `updatedAt`.

Fault injection must show the CAS, the immediate pre-commit authority check,
the authorized `resumeId` replay, the custody ordering and the cleared lead
attachment each fail a named test when removed.

## Acceptance for an implementation

- The owner has approved the decision record, and it is `current`
  (2026-11-06).
- With the preview off, nothing changes: no route answers, no flag is
  advertised, the UI shows no Resume.
- Every refusal and approval in [Tests required](#tests-required) passes at
  the route boundary, with fault-injection results reported.
- No agent, Station Control tool, GitHub comment or automation can resume.
- The general status route still refuses moves out of `done` and `canceled`.
- Docs and contracts are updated together, and #4554 closes only when this
  ships.

## Implementation slices

1. **`endedAt`.** Write it on every move into an ended status and use it in
   the follow-up poller. This fixes the poller's edit-extends-following gap
   on its own.
2. **Resume.** The service mutation, resume record, route, preview,
   capability flag, close-on-merge clearing, custody, and the
   cleared lead attachment, with the boundary tests and storage migration.
3. **SDK and CLI.** Subject to the in-person witness requirement above.
4. **UI.** The ended header, the confirmation dialog and **Resume and
   dispatch**.

Not proposed here, each needing its own decision: delivering retained
follow-ups into a still-live earlier lead instead of a new dispatch, and
automatic resume from GitHub once an identity link exists.

## Implementation

Where the code lives: the contract and the shared refusal reading
([`task-resume.ts`](../../packages/contracts/src/task-resume.ts)),
`TaskGraphService.resumeTask` and the store decoder
([`task-graph-service.ts`](../../src-server/services/projects/task-graph-service.ts)),
the route ([`task-resume.ts`](../../src-server/routes/orchestration/task-resume.ts))
and its authority composition in `runtime-routes.ts`, the SDK client
([`task-resume.ts`](../../packages/sdk/src/task-resume.ts)) and the UI section
([`TaskResumeSection.tsx`](../../src-ui/src/views/task-workspace/TaskResumeSection.tsx)).

Choices and differences from the sections above:

- **Who.** "Current authority" is four checks, all read again under the store
  lock immediately before the write or any replay disclosure:
  `isOperatorInPersonNotAgent`, the request principal still current, the
  canonical Task read (`canonicalTaskSourceMayRead`), Project execution
  (`canUseTaskSource(..., execute = true)`), and the request's own scope for
  `POST /api/tasks/:taskId/dispatch`. The operator in person includes the
  operator's own paired devices (#3994); ordinary account members are not in
  person. Membership lives in its own store, so this is a recheck, not a
  transaction across stores.
- **Which Tasks.** "A GitHub `workItemRef`" is a canonical GitHub ref the
  Project's board checked (`workItemProvenance: 'project-board'`), the same
  rule tracker reads follow. `createdBy` `external-monitor` is refused with
  `automation-rule`.
- **Turns and worktrees.** The turn check asks whether any Session this
  incarnation dispatched, or its conversation's current Session, has an open
  turn; an unknown answer counts as running. The kept worktree's occupancy is
  the finalizer's own `isWorkspaceBusy`. A resumed Task's first dispatch
  refuses to reuse a kept worktree that has a running turn (the turn may have
  started after the resume); a later dispatch reuses it.
- **Capability flag.** `taskResume` is a static fact about the build, withdrawn
  in hosted mode, as `sessionPersonReads` is: with the preview off the route
  answers `task_resume_unavailable` rather than the handshake dropping the
  flag, so an older host's 404 and an off preview stay distinguishable. The UI
  shows nothing while the preview is off.
- **Own account.** The follow-up store does not record whether an item was
  written with Station's own `gh` account, so the confirmation shows the class
  and association but not that fact.
- **CLI.** None: a `station` CLI call on the host carries the same home
  credential an agent's shell command could, so it cannot present a witness
  the server can tell apart from an agent. `scripts/cli-mcp-parity.json`
  records the exemption. There is no MCP tool.
- **Storage.** `endedAt` and `resumes` are new `TaskRecord` fields in
  `task-graph.json`. The first write that adds either copies the file to
  `task-graph.json.pre-task-resume` (refusing the write if the copy fails),
  and later writes keep that first copy. An older build refuses the new
  document as a whole (its decoder accepts an exact field list) rather than
  dropping fields. To downgrade, stop Station and put the
  `.pre-task-resume` copy back as `task-graph.json`, which loses Task changes
  made since; there is no conversion tool.
- **Custody.** The worktree custody queue is process-local; the store write is
  serialized across processes by its file lock, but the custody ordering holds
  only with one lifecycle writer per Station home, as today.

Evidence (focused tests, run on the implementing branch):
`task-resume.service.test.ts` (end time, storage migration, every refusal
writing nothing, authority read under the lock, replay after restart and
dispatch, concurrency, reservation expiry, worktree busy and custody order),
`task-resume-wakes.test.ts` (queued and new Task-question and tracker wakes
after resume, with the production placement rule), `task-follow-ups.test.ts`
(the poller follows by `endedAt`), `runtime-routes-task-resume.test.ts` (the
mounted route through `configureRuntimeRoutes`: preview off, operator resume,
dispatch and replay, Station Control and internal-token refusal, read-only and
revoked devices), `consumed-capability-flags.test.ts`,
`runtime-routes-declare-pull-request-engine.test.ts` (close-on-merge writes
`endedAt`), `task-brief.test.ts`, the SDK and UI tests. Not verified: an
ordinary account member's request at the mounted route (the in-person witness
itself is the canonical one) and behavior across two Station processes.

## Limitations

- Resume keeps the Task's memory and records, but a worktree that
  finalization already removed is provisioned again as for any dispatch;
  finalization removes one only when its commits were pushed.
- The operator still has to notice the follow-up. The ended header and brief
  show it; there is no notification beyond what the Task list shows today.
- Messaging the earlier lead directly in Station remains possible and does
  not change the Task's status.
