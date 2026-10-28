---
status: current
subject: Automations are scheduled work that runs in a conversation, on any engine
decided: 2026-10-28
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/3439
  - kind: issue
    ref: https://github.com/kontourai/station/issues/565
  - kind: issue
    ref: https://github.com/kontourai/station/issues/890
  - kind: issue
    ref: https://github.com/kontourai/station/issues/3628
  - kind: doc
    ref: src-server/services/scheduling/scheduled-conversation-runs.ts
  - kind: doc
    ref: src-server/services/orchestration/station-turn-handoff.ts
  - kind: doc
    ref: docs/design/automations.md
---

# Automations are scheduled work that runs in a conversation, on any engine

## Decision

The product surface called Schedule is **Automations**. An automation is a
trigger, a target and a delivery:

- **Trigger**: the existing scheduler schedule (`cron`, `every` or `at`).
- **Target** (`SchedulerJob.target`): where each run lands. Either an
  existing conversation (`{kind: 'conversation', conversationId}`), or a
  conversation the automation owns (`{kind: 'dedicated', agent, workspace?}`),
  which its first run starts and Station then records.
- **Delivery**: each run is a framed Station turn queued on that
  conversation's inbox under the key `scheduler:<runId>`. It runs on whatever
  engine the conversation runs on (Station engine, Claude Code, Codex, an ACP
  agent), its result is in the conversation, and the normal turn-completion
  notifications fire.

A job with no target keeps its old behaviour: a Station-engine turn whose
output is written to a file. New automations from the UI default to a
dedicated conversation when the host advertises `scheduledConversationTarget`.

Agent check-backs (`schedule_wake_up`) keep their storage, limits (24 hours,
3 waiting, 20 per hour) and approval rules, and are presented as automations:
the chat lists its check-backs and the automations targeting it together,
under "Automations". Both hand their turn to the inbox through one function
(`submitStationFramedTurn`). A `propose_job` proposal now targets the chat
that proposed it, so an approved job runs on that chat's own engine.

## Rules

- **Permissions.** A run acts as the automation's recorded creator
  (`createdBy`), under the conversation's normal approval mode, with no stored
  full-access grant. A run that stops for an approval surfaces as needs-you.
  A person may target a conversation they may send to; an agent's request may
  target only its own conversation, and never a dedicated one
  (`automation-target-stays-in-own-conversation`). The inbox applies the
  continuation rule again when each run is placed.
- **No replay.** A target refuses a monitor and any `retryCount` above 0. A
  run that may have reached an engine settles `indeterminate` and is never
  repeated; a restart that hands the same key over again gets the inbox's
  existing entry, so a run yields at most one turn.
- **Settlement.** The run waits for its turn's terminal event, up to 30
  minutes (`AUTOMATION_RUN_POLICY.turnDeadlineMs`). A completed turn is a
  success; an aborted or cancelled one is a failure; still running at the
  deadline is indeterminate, and the turn continues in the conversation.
- **Watermark.** The framed prompt states the last successful run's
  completion time, so recurring work can cover only what changed since.
- **Fatigue.** After 5 failed runs in a row the automation is disabled and
  one notification is sent. A success resets the count. The count is derived
  from the run log, so nothing is stored to drift. Re-enabling does not
  reset it: one more failure turns it off again.
- **Lateness.** A targeted occurrence more than 6 hours old when Station
  claims it is recorded missed (`skipped: 'late'`), not run and not
  announced. Station only ever claims the latest due occurrence, so an
  `every` schedule shorter than 6 hours is never more than one interval
  late; the cutoff bounds cron, one-time and long-interval schedules after
  Station was off. Legacy jobs keep run-latest-once.
- **`notifyStart`** is accepted for compatibility and ignored. The UI does
  not offer it.

Wire names do not change: `/api/scheduler/*`, the MCP tool names, the SDK
`scheduler` client and `SCHEDULER_OPERATOR_SURFACE`. There is no
`station automations` CLI alias: `AUTOMATION_OPERATOR_SURFACE` already uses
`enable`, `disable` and `delete` under that name for GitHub rules.

## Rationale

Scheduled runs called `generateText` on Station-engine agents only, so a job
naming a Claude Code or Codex agent failed with "Agent not found" (#890),
including one a person approved from that agent's own chat. Its output went
to a file nobody opened. Check-backs already reached any engine through the
inbox. Routing scheduled runs the same way makes one model serve both, puts
results where the person already looks, and reuses the inbox's permission
and idempotency rules instead of adding new ones.

The GitHub event sources and rules of #3439 (S2–S6) remain separate work.
They will be automations with another trigger; this record does not build
them.

## What ships

- Shipped: targets, the conversation runner, fatigue, lateness, the guard
  rule, the capability flag, the Automations page and chat section, and the
  replacement templates.
- Not shipped: GitHub event triggers (#3439 S2–S6), a new conversation per
  run, start notifications.
- Known gap: if Station stops after a dedicated target's first run started
  its conversation but before the id was recorded, the next run starts
  another conversation.
