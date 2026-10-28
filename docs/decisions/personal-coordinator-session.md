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
and children it delegated, whose results #3158's delegation delivery already
returns once. Without the first exclusion, each wake turn ending would write a
"finished" record that woke the coordinator again.

## Bounds

Coalesce for 30 s, at most 12 wakes per rolling hour, 10 items named per wake
and 100 items waiting per person. These are contract constants. The hourly cap
holds items for the next slot rather than dropping them; only the pending cap
refuses, and the item stays in the person's Attention. Each bound has a test
at max + 1.

## Delivery

The wake is a conversation inbox entry (#3568), the path agent wake-ups use:
it waits for a running turn, and placement applies the live continuation's
permission rule. The wake row and its claimed items are committed before the
inbox call, under a key derived from the wake id, so a restart re-submits the
same turn and the inbox accepts it once. An inbox refusal that wrote nothing
releases the items for the next wake.

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
