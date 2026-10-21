# Tracker-backed Tasks

Status: proposal in delivery on the `task/issue-tasks` branch. The epic is
[#4003](https://github.com/kontourai/station/issues/4003), and this document
is the specification its implementation lanes build against. It records no
behavior that has landed; once the work lands, the owning guides and the
glossary take over.

## Thesis

A Station Task is a durable unit of work that several Sessions work on in
parallel or one after another. They share one memory: what is true now, what
has been decided, what is still open for a person, and what has already been
tried and failed. A tracker item
(a GitHub issue first) is what the team has committed to and how they rank
it, and it is shared with people who never open Station.

The two systems divide the work as follows:

| Concern | Owner |
| --- | --- |
| What to do, priority, labels, open/closed | The tracker |
| How the work is going: summary, decisions, questions, dead ends, Sessions, branch | The Station Task |
| A closed issue | The merged PR's `Closes #N` |
| A human-readable progress note on the issue | An Agent, at milestones, following the `tracker-hygiene` skill |

Nothing mirrors status between the two. Station re-reads the linked item when
a person opens the Task, when a Session is dispatched, and when a Session asks
for its brief with `get_task_brief`. Nothing polls.

## Task ↔ tracker item cardinality

- A Task has **zero or one primary** work item, `TaskRecord.workItemRef`
  (`github:owner/repo#123`). Zero means a Station-only Task.
- A work item is the primary item of **at most one Task that is not done or
  canceled**. **Start Task** on an item that already has such a Task opens
  that Task.
- A Task may have **any number of secondary** items, stored as typed
  `external` references: an epic's sub-issues, a bug found along the way, a
  related item. They are displayed and linked from the PR with `Closes #N`
  where appropriate. They are never claimed and never seed the Task.
- Issue hierarchy (sub-issues, Linear projects, Jira epics) stays in the
  tracker. Station does not copy it.
- Size is the person's choice. One bug or a whole epic can each be one Task.
  Split a Task in two only when the parts should land or be prioritized
  separately. Parallel work inside one Task is done with more Sessions, not
  more Tasks.

## Task memory

What a Task knows comes in four layers. The third and fourth are new here.

| Layer | What it is | Who writes it |
| --- | --- | --- |
| 1. Durability | Monument: Sessions and the Station process survive restarts | Station |
| 2. Facts | The event store's records: `get_session_digest` and `list_project_activity` ([#3428](https://github.com/kontourai/station/issues/3428)), kept outputs, the observed work item | Station derives them; no agent writes them |
| 3. Judgment | **Task memory**: what matters, decided by agents and editable by people | Agents and people |
| 4. Learning | A done Task's standing decisions and dead ends, promoted into the Project's knowledge store | A person reviews; Station writes the record |

Task memory has two parts. Both are stored in the orchestration database,
per Task incarnation (a Task re-created under the same id starts empty), in
two append-only tables (migration 017). Every revision and every version is
kept.

**The Task summary** is one bounded text that agents rewrite and never
append to. It is a runbook: what is true now, what works, what is next, and
what is risky.

- A write over 4,000 characters is refused with a message telling the
  writer to prune it. Nothing is cut.
- Writes use optimistic concurrency: `task_summary_update {text,
  baseRevision}`. When `baseRevision` is no longer the current revision,
  nothing is written and the refusal carries the current text and revision
  so the writer can merge and retry. The same text again writes no new
  revision.
- Each revision records its author (a Session or a person) and time. People
  read and edit it from the Task workspace under the same rules, including
  the conflict path.

**Task records** are keyed decisions, questions and dead ends:
`task_record {kind, key, text?, importance?, action?, reason?}`.

- `key` is a short lowercase slug (letters, digits, single hyphens, at most
  64 characters); anything else is refused. Text is at most 1,000
  characters.
- `set` (the default) creates a record, or supersedes the live record with
  the same kind and key; the earlier version stays in the history.
- A `question` is open until `answer`, which stores the answer beside the
  question. `retire` withdraws any record with a required reason and keeps it
  in the history. `set` on an answered or retired key brings it back.
- Live records are capped per kind: 40 active decisions, 20 open questions
  and 30 active dead ends. A new key past the cap is refused with "supersede
  or retire one". Superseding a live key takes no new slot.
- `importance` is `standing` (shown in every Task brief) or `on_topic`
  (counted in the brief, listed on request). Every kind defaults to
  `standing`. A decision constrains all later work. An open question needs a
  person whatever its topic. A dead end exists so the next Session does not
  repeat it, which only works if the brief shows it. A writer marks a record
  `on_topic` when it matters only to one narrow part of the Task.
- An open question on a Task that is not done or canceled puts the Task in
  **Needs you**. The Tasks list carries `openQuestionCount`, and the existing
  Task fold on Home and in the inbox reads it: the Task's word becomes
  "Task · Needs answer" in the Needs you lane until the question is answered.

Agents cannot change a Task's status, and memory writes never touch it or the
Task document. Status changes remain person-only, and close-on-merge is
unchanged.

### Why not the Task document

An earlier draft kept memory as four fixed headings in the shared Task-room
document, with agents appending entries. Two findings replaced it.

- **Capacity.** The room document's stored state grows with every character
  ever typed, not with its current length
  ([#4007](https://github.com/kontourai/station/issues/4007)). An agent
  appending at every step would exhaust it, and nothing in an append-only
  document ever gets shorter. A rewritten summary with its own cap stays the
  same size however long the Task runs.
- **Derivation over self-report.** Most of what an "In progress" or "Done"
  entry said is already recorded as fact: which Sessions ran, what each turn
  asked, its outcome, the files it changed and the pull requests it declared.
  Asking agents to restate it costs tokens and invites drift between the
  record and the claim. The brief derives that layer from the event store
  instead, and Task memory keeps only what no record holds: judgment.

The Task document stays the person-authored brief that Start Task seeds from
the issue. Nothing parses memory out of it.

## Session brief

When a Session is dispatched for a Task, it receives a Task brief before its
first turn. The brief is a snapshot pinned to a digest, composed in this
order:

1. the Task (title, id, document revision, goal), its linked work item
   re-read at dispatch, and the Task document as written;
2. the Task summary, in full, with its revision and author;
3. standing decisions;
4. open questions, each with who asked;
5. recent dead ends;
6. a compact line per Session of the Task, from the same facts
   `get_session_digest` and `list_project_activity` report: the status word,
   the turn count, and the newest turn's request, outcome, changed-file count
   and declared pull request;
7. what was left out, each line naming the call that fetches it;

followed by the rules and, for a Task with a tracker item, the tracker
guidance. `on_topic` records, answered questions and retired records appear
only as counts.

The brief reuses the digest-pinned `TaskRoomContextSnapshot` approach from
[task-room agent requests](task-room-agent-requests.md). A Session that runs
for a long time re-reads it with `get_task_brief`. That tool also takes
`include: "all_records"` (every record, both tiers, answered and retired ones
with their answers and reasons) or `include: "summary_history"` (the newest
ten summary revisions). These are options of the one tool rather than a
second tool: the authority is the same (the calling Session's own bound
Task), the omission notices name one tool, and the Station Control registry
gains no read entry.

Implementation notes (brief lane), where the build differs from the list
above:

- **Delivery is with the first turn, on every engine.** Dispatch builds the
  brief and records it in the Session's start metadata under a reserved,
  server-only key. Station prepends it to the first turn's ambient context,
  the same place an authored Agent prompt goes on engines without a
  system-prompt channel. It is not a system-prompt addition, even on Claude.
  Task dispatch resolves no Agent definition to append to, so this is one
  path for Claude Code, Codex, ACP and Station's engine. It also keeps the
  snapshot a single turn in the transcript, so a later resume does not
  re-apply a stale one. The person's typed text stays the transcript text.
  Station's engine relays ambient context to `/chat`, whose ambient bound
  rises from 4000 to 4000 + 1 + the brief bound for this reason.
- **The bound** is the existing 16,000-character Task-room bound, applied to
  the whole rendered brief. Each fixed part has its own cap: goal 1,000, the
  Task document 2,500 (800 once a summary exists, since the summary then
  carries what is true now), five tracker comments of 400, and a 400-character
  labels line. The summary is shown whole; its cap is a refusal at write
  time. With every fixed part at its worst, about 1,800 characters remain for
  records and Sessions, so the newest record always fits. Records fill that
  space newest first, taken in turn from each kind, then Session lines
  (at most eight, newest activity first). Everything left out is counted.
- **Tracker guidance** goes in the brief whenever the Task has a
  `workItemRef`. It is the `tracker-hygiene` text, embedded as a server
  constant, because Station cannot ship a built-in skill and Codex has no
  skill channel.
- **Rules follow the link.** Every brief carries the two memory rules:
  update the summary with `task_summary_update` at milestones and before
  stopping, and record decisions, questions and dead ends with
  `task_record`. The two tracker rules (post only at a milestone; never close
  the item) are added only when the Task has a `workItemRef`. A Station-only
  Task's brief has no tracker wording at all.
- **"Comments newer than the last revision the Task recorded".** A Task
  records no tracker revision. It records `TaskRecord.workItemObservedAt`,
  the time of the last tracker read that counted. Start Task sets it. A
  dispatch whose read observed the item advances it to that read's time, and
  only once the dispatch is recorded. A failed start therefore cannot hide
  comments from the next one. The read asks for comments since that mark,
  or since the Task's creation when there is none. A failed, timed-out
  (10 s) or non-observed read becomes one line, such as `linked item not
  re-read: unauthenticated`. It never fails the dispatch and leaves the mark
  where it was.
- **One reader.** Dispatch, `get_task_brief`, Start Task and the Task's
  linked-item header all read through the runtime's single
  `GitHubWorkItemObserver` (the host's `gh` login).
- **`get_task_brief` re-reads the tracker** through that reader, with the same
  10 s bound and the same one-line failure. It asks for comments since the
  Task's mark but never moves it: the mark records what dispatched Sessions
  were shown, not what one Session caught up on.

### Write authority

`task_summary_update` and `task_record` take no Task argument. The routes
read the Session from the verified Station Control caller and the Task from
that Session's immutable room execution binding. The Session must be the
Task's lead or a recorded independent request of this Task incarnation, and
the write re-checks that inside its `BEGIN IMMEDIATE` transaction. A person
writes through the Task room's request authority, the same as document edits.

### Server read API for later lanes

The promotion lane and the lead wake read Task memory through the store
(`EventStore.taskMemoryStore()`, in
[`task-memory-store.ts`](../../src-server/services/orchestration/task-memory-store.ts)),
keyed by Task incarnation `{taskId, taskCreatedAt}`:

- `listStandingRecords(incarnation)` returns `{decisions, deadEnds}`: the
  active, standing ones.
- `listOpenQuestions(incarnation)` returns each open question with
  `askedBySessionId` when a Session asked it.
- `countOpenQuestions(incarnations)` returns a per-Task count, as the Tasks
  list uses it.

### Lead wake

An open question reaches people through Needs you. The Task's lead Session
learns of a question or an answer only when it reads its brief, so Station
also puts one message into the lead's conversation
([`task-question-wake.ts`](../../src-server/services/orchestration/task-question-wake.ts)):

- **What wakes the lead.** A question opened (`set`) by a Session that is not
  the lead, and an answer by anyone who is not the lead, a person or another
  Session. A question a person opens does not wake it: questions are for
  people. Decisions, dead ends and retires never wake it.
- **Who the lead is.** `TaskRecord.sessionId`, compared by conversation, so a
  successor Session of the lead is still the lead. Independently requested
  Sessions are never leads, so there is one lead or none.
- **No loops.** Only the lead is woken, and nothing the lead writes wakes
  anyone. A woken lead that asks or answers in turn sends nothing.
- **No live lead, no send.** A Task with no lead, a Task that is done or
  canceled, or a lead whose current Session has stopped (`completed`,
  `failed`, `canceled`) gets nothing; the question still shows in Needs you.
- **Record before effect.** The wake runs only after the version has
  committed. Its failure never fails or rolls back the write: the write's
  answer is unchanged, and the failure is logged as `task question wake not
  delivered` with the Task, key, version, action and reason.
- **Exactly once per version.** The message is a conversation inbox entry
  (the held follow-up inbox, `ThreadInboxDelivery`), keyed by a digest of the
  Task incarnation, record key, version and action. A resubmitted key answers
  the stored entry, and placement reads the conversation's turn ledger before
  it starts anything, so a retry or a restart never sends twice. Setting the
  same question again writes a new version and so wakes the lead again.
- **Busy or idle.** The inbox's rule: an idle lead gets a new turn now; a
  running one keeps the message queued until its turn ends. A wake never
  steers. It is not urgent enough to change a turn already running, and a
  steer would need a second durable record to pin its branch. It is sent as
  the lead Session's recorded owner, with an internal client origin.
- **The text** names the key and who asked or answered, quotes the question
  (and the answer), and for an open question says how to answer:
  `task_record` with `action: "answer"`.

Gap: a crash after the write commits and before the inbox entry is submitted
loses that one wake. Nothing re-derives it at startup, because inbox
retention could then let an old version send again. The question still shows
in Needs you and in the lead's next `get_task_brief`.

## Learning: promoting a done Task's lessons

When a Task is done (a person's status change or close-on-merge), its
active, standing decisions and dead ends become **candidates** for the
Project's knowledge store. A person reviews each one in the Task workspace:
**Promote** (edit the title and text, then write it) or **Dismiss**. Nothing
is promoted on its own, following the lesson that promotion is a reviewed
step.

- **Derived, not copied.** Candidates are read from
  `listStandingRecords(incarnation)` each time the Task opens. A Task that is
  not done offers none; reopening a Task stops offering them. `on_topic`
  records, answered questions and retired records are never candidates.
- **The store's own write path.** Promote creates one `raw` record through
  the Project store's adapter (`KnowledgeStoreProvider.adapterFor(rootId)`),
  the same create `POST /api/knowledge/roots/:rootId/records` uses. Its
  category is `task-learning.decisions` or `task-learning.dead-ends`.
  Provenance uses the Kit's creation fields: `agent` is
  `station-task-learning` (the process that wrote it), `session_id` is the
  Session that wrote the record version (absent when a person did), and
  `note` names the person, the Task, its creation time, the record
  `kind/key` and version, and the work item.
- **Once per version.** The record's id is derived from the record's kind,
  key and version and a digest of the Task incarnation. The store refuses a
  second record with that id, so promoting the same version twice writes once
  (the second answer is `already-promoted`), whichever Project store it went
  to. "Promoted" is read back from the stores, not recorded beside them. A
  later version of the same key is a new candidate.
- **Dismissal is the one state Station keeps**: an append-only row per
  dismissed record version (`task_learning_dismissals`, migration 018).
- **No store.** A Project without a knowledge store still lists its
  candidates and says so plainly, with a link to the Project page, where
  Knowledge stores has **Create store**. Promote is disabled until one exists.
- **Person only.** The routes take the Task room's request authority, like
  the person's Task memory edits, and no Station Control tool names them, so
  the central guard refuses an agent's request. An agent can still capture
  its own raw record with `add_knowledge_record`; that does not touch a
  candidate.
- **Search.** A promoted record is searchable after its store is reindexed.
  Promotion does not index it, as no store write does today.

The Knowledge Kit's `propose`/`apply`/`reject` gate was considered and not
used: it records a proposed change to an existing `concept` record, carried
by a proposer record that must already be in the store. A candidate would
then be written into the store before anyone reviewed it.

## Starting a Task from a tracker item

The project Tasks board already lists read-only provider items
(`ProviderWorkItem`). **Start Task** on such a row creates a Task with the
following fields:

- `sourceProvider` and `workItemRef` from the item;
- the title from the item;
- the item body and its last few comments as the brief, with a link back to
  the item;
- a dispatch that also records the existing assignment claim.

The `workItemRef` is the deduplication key (see Cardinality).

## Reading the tracker

Reads go through the host's existing authenticated CLI (`gh` for GitHub),
following the same exact-identity discipline as the pull request provider.
Station stores no tracker token. Agents comment on the tracker with that same
host login, so the Station operator's tracker identity is the author.
Unattended Sessions follow the same rule, by the
[agent-authored tracker updates](../decisions/agent-authored-tracker-updates.md)
decision.

Linear and Jira come later. The likely route is their remote MCP servers with
the engine handling sign-in. That route has not been tested against Station's
MCP passthrough.

## Delivery shape

Lanes merge into one Task branch, and only that branch opens a pull request to
`main`. Required CI runs on pull requests that target `main` and on the merge
queue. Lane branches and the Task branch use no runners until that single
pull request opens. This is the intended pattern for coupled work under
limited runner capacity. It is not a backlog roll-up: unrelated work still
lands separately, so that a red result points to one owner.

## Non-goals

- Deterministic two-way status sync. It stays upstream
  ([work-plane Decision 4](work-plane-composition.md#decisions-owner-ratified-2026-07-20);
  kontourai/flow-agents#1508).
- A separate Epic entity, or copying issue hierarchy into Station.
- Polling, webhooks, or standing jobs for freshness.
