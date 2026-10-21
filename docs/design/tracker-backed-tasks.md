# Tracker-backed Tasks

Status: proposal in delivery on the `task/issue-tasks` branch. The epic is
[#4003](https://github.com/kontourai/station/issues/4003), and this document
is the specification its implementation lanes build against. It records no
behavior that has landed; once the work lands, the owning guides and the
glossary take over.

## Thesis

A Station Task is a durable unit of work that several Sessions work on in
parallel or one after another. They share one memory: what has been decided,
what is done, what is in progress, and what is still open. A tracker item
(a GitHub issue first) is what the team has committed to and how they rank
it, and it is shared with people who never open Station.

The two systems divide the work as follows:

| Concern | Owner |
| --- | --- |
| What to do, priority, labels, open/closed | The tracker |
| How the work is going: decisions, progress, questions, Sessions, branch | The Station Task |
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

The Task document (the existing shared Task-room markdown document) is the
memory. It gains four fixed sections, in this order:

```markdown
## Decisions
## Done
## In progress
## Open questions
```

Content before the first fixed heading is the brief (seeded from the issue
or the shaping proposal). People can edit any part of the document. Agents
append entries through the `task_note` Station Control tool. Each entry
records the Session that wrote it and the time. `task_note` never rewrites or
deletes existing text. An "In progress" entry is keyed by Session, so a
Session replaces its own in-progress line.

Agents cannot change a Task's status. Status changes remain person-only, and
close-on-merge is unchanged.

## Session brief

When a Session is dispatched for a Task, it receives a Task brief before its
first turn. The brief is a snapshot pinned to a digest and built from:

1. the Task title, its id, and the document revision;
2. the linked work item header, re-read at dispatch: state, labels, URL, and
   comments newer than the last revision the Task recorded;
3. the other Sessions in the Task and their status words;
4. the four memory sections, cut to fit the limit (newest first; the brief
   says how much it left out);
5. three fixed rules, stated inline because Codex has no skill channel:
   record decisions, completed work and questions with `task_note`; post to
   the tracker only at a milestone; never close the tracker item.

The brief reuses the digest-pinned `TaskRoomContextSnapshot` approach from
[task-room agent requests](task-room-agent-requests.md). A Session that runs
for a long time re-reads the current memory with `get_task_brief`.

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
- **Two more parts.** After the title, id and revision the brief adds the
  Task description as its goal (at most 1000 characters). It also adds the
  document's preamble, the seeded brief before the first fixed heading (at
  most 2500). Without them a dispatched Session would not know what the Task
  is for.
- **The bound** is the existing 16000-character Task-room bound, applied to
  the whole rendered brief. Each fixed part has its own cap. The tracker
  guidance is reserved first. The memory sections fill what is left: newest
  entries first, taken in turn from each section, with a count of the entries
  left out.
- **Tracker guidance** goes in the brief whenever the Task has a
  `workItemRef`. It is the `tracker-hygiene` text, embedded as a server
  constant, because Station cannot ship a built-in skill and Codex has no
  skill channel.
- **Rules follow the link.** Every brief carries the `task_note` rule. The
  two tracker rules (post only at a milestone; never close the item) are
  added only when the Task has a `workItemRef`. A Station-only Task's brief
  has no tracker wording at all.
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
