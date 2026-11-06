---
status: needs-decision
subject: Resuming ended tracker-backed Tasks after GitHub follow-ups
decided: 2026-11-06
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4554
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4508
  - kind: doc
    ref: docs/design/ended-task-resume.md
  - kind: doc
    ref: docs/decisions/task-tracker-followups.md
  - kind: doc
    ref: docs/design/tracker-backed-tasks.md
---

# Resuming ended tracker-backed Tasks after GitHub follow-ups

No answer has been ratified. Until one is, `done` and `canceled` Tasks stay
ended: follow-ups on their GitHub items are recorded and shown for 14 days
and change nothing, as [#4508 decision 4](task-tracker-followups.md) says.
This record names the open subject for
[#4554](https://github.com/kontourai/station/issues/4554). The proposal, its
evidence and its alternatives are in
[Resuming ended Tasks](../design/ended-task-resume.md).

## Decision needed

1. **Who resumes.** Recommended: only a signed-in Station person, through a
   person-only route, after seeing the retained follow-ups. A GitHub comment
   never resumes a Task, because Station has no verified link between a
   GitHub account and a Station principal, and `author_association` does not
   establish current Project access.
2. **Whose authority.** Recommended: anyone who may currently dispatch the
   Task (`execute` access to its Project). New work runs only under the
   person who dispatches it; when that is not the earlier lead's owner, the
   change of authority is recorded in the resume record. The alternative is
   to allow only the earlier lead's owner.
3. **Which Tasks.** Recommended: `done` only, within 14 days of a new stable
   `endedAt`, the follow-up window. `canceled` stays ended; a person starts a
   new Task on the work item instead.
4. **What resume does.** Recommended: move the Task to `ready`, clear
   `endedAt` and close-on-merge, append an immutable resume record, and start
   nothing. The person then dispatches through the existing dispatcher, and
   only leads dispatched after the resume are woken by follow-ups.

The design lists the refusals, races, tests and implementation slices that
follow from these answers. Recording `endedAt` and using it in the follow-up
poller is useful whichever answer is chosen.
