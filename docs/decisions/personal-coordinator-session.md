---
status: current
subject: One coordinator Session per person, woken from delivered attention notifications through the conversation inbox
decided: 2026-10-28
evidence:
  - kind: commit
    ref: 0d933ad05f7
  - kind: commit
    ref: b6a9730da7d
  - kind: commit
    ref: 445dbae30c8
  - kind: commit
    ref: 97611a72fbd
  - kind: doc
    ref: src-server/services/orchestration/coordinator-session.ts
  - kind: doc
    ref: src-server/routes/orchestration/coordinator.ts
  - kind: doc
    ref: packages/contracts/src/coordinator.ts
  - kind: doc
    ref: src-ui/src/lib/productNames.ts
  - kind: doc
    ref: docs/user/houston.md
---

# Personal coordinator Session

#3628 gives a person one persistent chat that delegates, is woken when their
work needs them, and brings back results and decisions. The product calls it
**Houston** and its overview **Mission Control**.

## Names

Both names are pending a trademark and collision check. They live in one UI
copy source (`src-ui/src/lib/productNames.ts`). Wire names, routes
(`/api/orchestration/coordinator`), contract identifiers, the capability flag
(`coordinatorSession`), storage tables (`coordinator_*`) and the engine-facing
wake text say `coordinator` or nothing, so a rename changes one file.
Mission Control is Home's page title. The sidebar entry, the Home landmark
and the route still say Home: renaming the navigation is left for after the
names are cleared.

## Designation

One designation per person, keyed by the request principal's user id, with a
conversation designated for at most one person. A second designation is
refused (`coordinator_already_designated`) unless the request says `replace`;
the UI offers that as its own action ("Make this Houston instead"). Only a
person's own request may designate (a request that may be an agent's is
refused), and it needs the same authority as sending to the conversation. The
designation records the person's dispatch actor, which every wake replays.

## Wake source: delivered notifications

Station already decides when a person's work reaches an attention state and
writes a notification for it (approvals, turn completion and failure,
`notify_user`), scoped to the Session's readers. The wake reads that one
stream (`NOTIFICATION_DELIVERED`) instead of hooking each producer: no second
copy of the producers' rules can drift. Only records naming a Session wake
it; a requested stop does not. The person must still be able to read the
Session when the item is recorded.

Self-wakes are excluded by construction: the coordinator's own conversation,
and a delegated child's finished or failed turn, which #3158's delegation
delivery already returns once. #3158 delivers only settled turns, so a child
of the coordinator that needs the person still wakes it. Without the first exclusion, each wake turn ending would write a
"finished" record that woke the coordinator again.

## Bounds

Coalesce for 30 s, at most 12 wakes per rolling hour, 10 items named per wake
and 100 items waiting per person. These are contract constants. The hourly cap
holds items for the next slot rather than dropping them; only the pending cap
refuses, and the item stays in the person's Attention. Each bound has a test
at max + 1.

Dedupe is a 7-day window (`COORDINATOR_WAKE_DEDUPE_WINDOW_MS`), not forever.
Items are keyed by the producer's dedupe tag, which is per turn or per
request, and a notification lives at most a day, so a repeat after the window
can only come from a replay. Keeping every item key forever would grow without
bound to guard against an event the producers don't emit; the window is the
stated guarantee.

## Delivery

The wake is a conversation inbox entry (#3568), the path agent wake-ups use:
it waits for a running turn, and placement applies the live continuation's
permission rule. The wake row and its claimed items are committed before the
inbox call, under a key derived from the wake id, so a restart re-submits the
same turn and the inbox accepts it once. An inbox refusal or error that wrote
nothing releases the items and retries after 1, 5, 15 and then every 60
minutes (`COORDINATOR_WAKE_RETRY_DELAYS_MS`); each attempt is a wake row, so
the hourly cap bounds retries too.

Read access to each item's Session is decided at observation, when a wake is
composed or re-sent after a restart, and when the inbox is about to place it.
The last check is the inbox's sender policy (`placementRefusal`): a wake
naming an unreadable Session is refused there and nothing is sent; its
readable items go back for a fresh wake. The same policy refuses a wake whose
conversation is no longer the coordinator, and one queued longer than
`COORDINATOR_WAKE_QUEUED_MAX_AGE_MS` (24 hours), whose items are not re-sent.
So a wake's text reaches the engine only if, at placement, the person can
still read every Session it names, it is still their coordinator, and it is
at most a day old. The retry attempt and due time are stored, so a restart
resumes the backoff.

When the person replaces or removes the designation, or deletes the
conversation, the wakes still queued in the old conversation's inbox are
withdrawn in one inbox operation (`cancelQueued`: every entry is cancelled
before the conversation is driven again, so none is placed in between), and
the old target's retry timer and backoff are cleared. A wake already being
placed cannot be withdrawn; the placement policy also refuses a retired
target's wake. A designation whose conversation the
person can no longer read counts as absent: it is not shown, and a new
designation replaces it without `replace`.

The person is told what Station can do: the read and write routes return
`delivery`, derived from the current Session. Wakes are `blocked` when the
Session's last turn has ended in the log but its durable turn boundary is
still held (#4051: Codex and Muse turn terminals carry no invocation id). It
does not use `hasActiveTurn`, which reads that same boundary and so cannot
tell a stuck one from a running turn; a long turn or an approval wait reads
`ready`. `toolsPending` holds while the live Session
started without the Station tools. This is derived rather than keyed to engine
names, so it stops reporting `blocked` once #4051 is fixed.

## Provisioning and permissions

A coordinator's Sessions get the built-in Station tool servers and their
default auto-approvals on any Agent and engine. Delivery follows each engine's
existing rule: an ACP connection without HTTP MCP support gets an
`engine-capability-absent` receipt instead. This is the same list the
reserved Station role gets, and the person's designation is the opt-in. What
the Agent authored is kept and wins on conflict, its own `autoApprove`
included. No other restriction or grant is added.

## Not in this decision

- A durable person-scoped working picture (issue slice 4).
- Scheduled jobs, PR or CI events and Automations delivering into the
  coordinator (slice 5). The Automations lane will offer the coordinator as a
  default target once it lands.
- Steering a running coordinator turn: wakes always queue.
