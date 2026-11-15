# Live room stream, mentions and Agent working state (#4798, #4799, #4800)

Retention: retained as bounded review evidence for #4798, #4799 and #4800. Replace only with superseding reviewed evidence.

[Design sketch](design-sketch.md) written before implementation. [Fault injection records](fault-injection.json) for each behavior.

## Evidence classes

- **(a) real Station**: a browser against an isolated running Station.
- **(b) mounted or unit seam**: the real component, hook or route over its real dependencies, with only the network or clock stubbed.
- **(c) gallery only**: a fixture-backed capture. Never counted as (a) or (b).
- **(d) NOT_VERIFIED**: not exercised yet.

| Behavior | (b) test that fails when reverted | (a) real Station | (c) gallery |
| --- | --- | --- | --- |
| Ten rooms on one connection | `project-room-routes.test.ts` "ten rooms stream over one connection"; `project-room-live.test.tsx` "ten rooms and the open one share one live connection"; `ProjectConversationListLive.test.tsx` | `project-room-live.spec.ts` test 1: **(d) pending a heavy slot** | n/a |
| Seq gap backfilled, never skipped | `project-room-live.test.tsx` "a sequence gap is backfilled"; route test "more appends than one pass may describe is a resync" | spec test 2 (a proxy drops one frame): **(d) pending** | n/a |
| Deltas merged without a refetch | `project-room-live.test.tsx` "a live append is merged", "an update whose activity range…" | covered by spec tests 1 and 2: **(d) pending** | n/a |
| Typing clears on stop, on disconnect, by expiry | route tests "typing shows, clears…" and "typing expires on its own"; `ProjectRoomLive.test.tsx` "is typing follows the stream" | spec test 3: **(d) pending** | `room-live-mention-*`: **(d) not captured** |
| A person mention notifies only that person | route test "only that person is told, once…"; `project-room-mention-notifications.test.ts` (real NotificationService and membership) | spec test 4: **(d) pending** | `notifications-for-you-*`: **(d) not captured** |
| Opening the notification shows the message | `ProjectRoomLive.test.tsx` "a notification's message is brought into view and marked" | spec test 4: **(d) pending** | n/a |
| Mention dot on the channel | `ProjectConversationListLive.test.tsx`; route test "the read summary marks a room…" | **(d)** not in the spec | n/a |
| Renames update old mentions (keyed by id) | `RoomMessageText.test.tsx`; `ProjectRoomLive.test.tsx` "a mention renders by person id…" | **(d)** | `room-live-mention-*`: **(d) not captured** |
| Legacy `**@name**` still renders | `RoomMessageText.test.tsx`, with a fixture in the stored Task-room history shape | n/a | n/a |
| Non-member mention refused | route test; spec test 4: **(d) pending** | | |
| Agent working indicator follows the lifecycle | `ProjectRoomLive.test.tsx` "the Agent working row appears and clears…" (fails if hard-coded on); `ProjectConversationListLive.test.tsx` (sidebar) | spec test 5 sees only a recorded failure. No Agent can run on the e2e Station, so a real appear-then-clear is **(d) NOT_VERIFIED** | `room-agent-working-*`, `room-agent-outcome-*`: **(d) not captured** |
| Stop, and Retry as a new request | `ProjectRoomLive.test.tsx` "the person who asked can Stop…" | **(d)** | n/a |

## Fault injection

Each of the 18 injections ran from a clean committed tree. The named file was restored with `git checkout` and its test re-verified green. In round 1, four injections survived because their tests did not reach the behavior: typing stop and typing disconnect (masked by the 6 s expiry), the sidebar working mark (cleared by an empty list rather than a settled request), and the read summary (no unread message naming someone else). Those tests were tightened, and all four are caught in round 2. Full records, including failure lines, are in [fault-injection.json](fault-injection.json).

## Not shipped, with reasons

- **Task rooms are not on the shared stream.** Their transport (epochs, `throughSeq`, separate authorization) is its own; their sidebar rows keep the read-marker summary.
- **"Current step" is the request's lifecycle phase.** An Agent's Session steps stay private to its runner.
- **Project channels have nothing to fold.** A request publishes one message. Task rooms already fold an execution's turns into its thread; this PR adds its "is working" summary.
- **One connection per Project, not per client.** The sidebar shows one Project at a time.
- **No push.** Person-mention notifications reach the private feed and For you, not lock-screen push.
