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
a person opens the Task and when a Session is dispatched. Nothing polls.

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

### How `task_note` works

These details were settled during implementation:

- **Seeding.** A Task created from a shaping proposal is seeded with its brief
  and then the four headings. The room runtime's `seedTaskDocument` does this
  through the person's own edit path and writes only to an empty document;
  Start Task calls the same method. A Task created any other way starts empty.
  Its headings are added when the first note is recorded, at the end of the
  document. Existing text is never moved, so an older Task can end up with its
  sections in a different order.
- **Entry.** Each entry is one line:
  `- [session <sessionId>, <UTC time>] <text>`. The text is a single line of
  at most 2000 characters. Longer, empty or multi-line text is refused with
  nothing written; it is never cut. The entry goes after the last non-blank
  line of its section. A section ends at the next level-1 or level-2 heading.
  Headings inside fenced code are ignored, and if a person repeats a heading
  the first one is used.
- **In progress.** An `in_progress` entry replaces the line in that section
  that starts with the calling Session's own prefix. Other Sessions' lines
  are never touched. If a person moves the line out of the section, the next
  entry is added as a new line.
- **Authority.** The Task comes from the Session's immutable room execution
  binding, written when the provider starts. That Session must also still be
  the Task's lead Session, or a recorded independent request for this Task
  incarnation. Without both, the call is refused. The tool takes no Task id.
  The room runtime checks this again before the write commits.
- **Write path.** The entry is planned as text edits that only insert text,
  or replace the Session's own in-progress line. These edits are settled as
  exact atom operations through the room's shared working state, so revision
  history and concurrent edits by people converge as they do for any other
  edit. If the edits would delete more than their own range, the call is
  refused instead of written.
- **Edit identities (a change to the person path).** Operation ids order
  RGA siblings in ascending order. When a new insert's id sorted after the
  text already at its position, the editing planner deleted and reinserted
  everything after the edit. That rewrote other people's text and moved any
  concurrent note anchored there, about half the time for any edit in the
  middle of the document. The room runtime now gives every edit it plans a
  low, strictly decreasing id, for people's edits and notes alike. New edits
  therefore insert before the existing text. The planner's suffix-reinsert
  branch remains as a fallback.

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
