---
status: current
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

The owner approved the revised option B of
[Resuming ended Tasks](../design/ended-task-resume.md) for
[#4554](https://github.com/kontourai/station/issues/4554) on 2026-11-06.
This is approved for implementation, not yet shipped: until an implementation
lands, `done` and `canceled` Tasks stay ended, as
[#4508 decision 4](task-tracker-followups.md) says. The design holds the
evidence, the alternatives, the refusals, the races, the tests and the
implementation slices that follow from these answers.

## Decisions

1. **Who resumes.** Only the Station operator in person, through a route that
   verifies that witness, after seeing the retained follow-ups. A GitHub
   comment never resumes a Task, because Station has no verified link between
   a GitHub account and a Station principal, and `author_association` does not
   establish current Project access.
2. **Whose authority.** The in-person operator with current Task read and
   Project execution authority. Broader account membership does not currently
   establish permission to dispatch; admitting members needs a separate shared
   authorization design. A change from the earlier lead's authority is
   recorded.
3. **Which Tasks.** Non-automation Tasks with a GitHub work item and status
   `done`, within 14 days of a stable `endedAt`. `canceled` stays ended; a
   person starts a new Task on the work item instead.
4. **What resume does.** Move the Task to `ready`, clear `endedAt`,
   close-on-merge, and the active lead attachment, append an immutable resume
   record, and start nothing. The operator then dispatches through the
   existing dispatcher. All automatic delivery holds until a new lead is
   attached; historical leads receive no automatic wake.

Recording `endedAt` and using it in the follow-up poller applies whether or
not resume is enabled.
