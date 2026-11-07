---
status: current
subject: Bounded GitHub follow-ups for tracker-backed Tasks
decided: 2026-11-04
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4508
  - kind: doc
    ref: docs/design/tracker-backed-tasks.md
  - kind: doc
    ref: docs/decisions/agent-authored-tracker-updates.md
---

# Bounded GitHub follow-ups for tracker-backed Tasks

The owner approved the following behavior in [#4508](https://github.com/kontourai/station/issues/4508). This is a decision, not a claim that the behavior is implemented.

1. **Freshness.** A new feature preview, off by default, permits bounded polling at approximately five-minute intervals using the existing scheduler or monitor infrastructure. Only Tasks with a GitHub `workItemRef` that are live or ended within 14 days are observed. There is no new daemon, webhook, or ingress.
2. **Delivery.** Comments and reviews on the Task's own followed items from authors whose GitHub `author_association` is `OWNER`, `MEMBER`, or `COLLABORATOR` wake its lead Session through the durable Task question inbox path. Delivery queues behind a running turn, starts a turn when idle, and skips done or canceled Tasks and stopped leads. A failing check conclusion on a followed PR also wakes the lead unless the Task is blocked. GitHub Apps, logins ending in `[bot]`, and other authors are recorded and shown in the Task brief but never wake the lead.
3. **Text.** Actor text is data, quoted under a line identifying its author as in the existing Task brief. Each excerpt is bounded to approximately 1,000 characters. A wake entry carries identities and the bounded quoted excerpt, never unbounded raw text.
4. **Ended Tasks.** Resuming done or canceled Tasks is out of scope. Their observations are recorded and visible without changing Task status. Resume is tracked separately in [#4554](https://github.com/kontourai/station/issues/4554), whose open questions are in [Resuming ended tracker-backed Tasks](ended-task-resume.md) (`needs-decision`).
5. **Followed PRs.** Follow the primary work item and PRs a person kept on the Task under the existing keep rule. A Session declaration alone does not start following a PR. A kept PR is followed only when its repository is the board-checked primary item's repository (canonical, case-insensitive). Its owner, repository and number come from a Session's declaration, which an agent or text it read can steer, so a kept PR in any other repository is never read with the host's `gh` login; it is recorded and shown in the Task brief as not followed (different repository). This same-repository rule was added in review of the first slice.

## Implementation status

[#4556](https://github.com/kontourai/station/pull/4556) implements all five
decisions behind the `task-tracker-follow-ups` preview: polling, durable
per-Task observations, the Task brief's "Tracker follow-ups" section, and the
lead wake. Choices the decision left open:

- An ended Task's end time is its `updatedAt`, since a Task record keeps no
  end time.
- Hosted mode does not offer the preview, since hosted tenants have no host
  `gh` login of their own.
- One wake per poll carries every new waking item of the Task (at most eight
  written out, the rest counted), deduplicated by GitHub kind and id.
- Comments and reviews made with the same GitHub account Station's `gh` uses
  never wake the lead: agents post their tracker updates with that account,
  so waking on them would let a lead wake itself. On a single-user Station
  your own GitHub comments are therefore recorded and shown in the brief but
  do not wake the lead; to steer it, message it in Station. When GitHub does
  not report that account (no login, or a deleted one), no comment or review
  wakes the lead; only failing checks do.
- Failing conclusions are `FAILURE`, `TIMED_OUT` and `STARTUP_FAILURE`.
- A wake the lead's owner may no longer read, or that finds no inbox or no
  owner, waits for the next poll; a Task that is done, canceled or has a
  stopped lead records the items without waking. See
[Tracker follow-ups](../design/tracker-backed-tasks.md#tracker-follow-ups).

Two-way status sync remains outside Station's scope under [work-plane Decision 4](../design/work-plane-composition.md#decisions-owner-ratified-2026-07-20). This decision does not authorize arbitrary GitHub mentions to start work or interrupt an active turn.
