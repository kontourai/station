---
status: current
subject: Agents keep tracker items current through comments and PR links, not status sync
decided: 2026-10-21
evidence:
  - kind: doc
    ref: docs/design/work-plane-composition.md
  - kind: doc
    ref: docs/plans/task-tracker-sync-upstream-gaps.md
  - kind: doc
    ref: docs/design/tracker-backed-tasks.md
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4003
---

# Agents keep tracker items current through comments and PR links

The owner decided this on 2026-10-21.

[Work-plane Decision 4](../design/work-plane-composition.md#decisions-owner-ratified-2026-07-20)
says that two-way work-item sync (status and field updates, conflict policy)
is an upstream Flow Agents contract, and that Station never builds its own.
That decision still stands. This record defines what falls outside it:

- **Not sync:** an Agent posts a short progress comment on its Task's linked
  item at milestones, and a pull request links the item with `Closes #N`. The
  Agent writes these because it judged them useful. They do not mirror any
  field, and no conflict policy applies to them.
- **Credentials:** those writes use the host's existing authenticated CLI
  (`gh` for GitHub). Station stores no tracker token, and Agent Sessions,
  including unattended ones, use that host login. The rule in
  [automations](../design/automations.md) that agent sessions carry no GitHub
  write credential applies to automation-dispatched Sessions. It does not
  apply to Sessions a person dispatches for a Task.
- **Still forbidden:** an Agent must not close, reopen, retitle, relabel or
  reprioritize a tracker item, and must not change a Station Task's status.
  Closing happens only through a merged pull request. Status remains a
  person's action, or the Task's existing close-on-merge opt-in.

## Why

Deterministic write-back is blocked upstream (kontourai/flow-agents#1507,
#1508, #1509), and the shared memory that Tasks need does not depend on it. A
person reading the tracker needs a readable status. A Session needs the full
execution memory, which lives in the Station Task.
