# Live room stream, mentions and Agent working state (#4798, #4799, #4800)

Retention: retained as bounded review evidence for #4798, #4799 and #4800. Replace only with superseding reviewed evidence.

[Design sketch](design-sketch.md) written before implementation. [Fault injection records](fault-injection.json) for each behavior.

## Evidence classes

- **(a) real Station**: a browser against an isolated running Station.
- **(b) mounted or unit seam**: the real component, hook or route over its real dependencies, with only the network or clock stubbed.
- **(c) gallery only**: a fixture-backed capture. Never counted as (a) or (b).
- **(d) NOT_VERIFIED**: not exercised yet.

Real Station: `tests/project-room-live.spec.ts`, five journeys on an isolated Station, passed 5/5 on the PR head (the PR body names the head and log). Gallery: the scenes below were captured at 390 and 1440 wide, light and dark, and every PNG was opened; they were captured before the last merge of `main`.

| Behavior | (b) test that fails when reverted | (a) real Station | (c) gallery |
| --- | --- | --- | --- |
| Ten rooms on one connection; a message in the tenth marks its row | `project-room-routes.test.ts` "ten rooms stream over one connection"; `project-room-live.test.tsx` "ten rooms and the open one share one live connection"; `ProjectConversationListLive.test.tsx`, including "a message that lands while the stream is connecting" | spec test 1 | n/a |
| Seq gap backfilled, never skipped | `project-room-live.test.tsx` "a sequence gap is backfilled", "a room opened after the sidebar already holds the connection…"; route test "more appends than one pass may describe is a resync" | spec test 2 (a proxy drops one frame) | n/a |
| A failed resync or reconnect read never lets a later frame skip messages | `project-room-live.test.tsx` "a resync whose history read fails…", "a reconnection whose history read fails…" | **(d)** | n/a |
| A history read in flight never undoes a live merge, in the cache or for its caller | `project-room-live.test.tsx` "a history read already in flight never undoes a live append…"; past the 500 merged rows the hook remembers: "a read held across as many merges…" (control), "…more merges than the hook remembers is read again…", "a deletion merged during a held read stays deleted…", "a read outlived on every attempt fails…" | **(d)** | n/a |
| Deltas merged without a refetch | `project-room-live.test.tsx` "a live append is merged", "an update whose activity range…" | spec tests 1 and 2 | n/a |
| Typing clears on stop, on disconnect, by expiry | route tests "typing shows, clears…" and "typing expires on its own"; `ProjectRoomLive.test.tsx` "is typing follows the stream" | spec test 3 | `room-live-mention-*` |
| A person mention notifies only that person | route test "only that person is told, once…"; `project-room-mention-notifications.test.ts` (real NotificationService and membership) | spec test 4 | `notifications-for-you-*` |
| Opening the notification shows the message and marks it read | `ProjectRoomLive.test.tsx` "a notification's message is brought into view and marked"; `room-conversation-follow.browser.test.tsx`; `NotificationsPage.test.tsx` (Enter, Space, pending, no host scope) | spec test 4: unread before, Enter on the focused row, the message in view, read on return and after a reload | `notifications-for-you-*` |
| Mention dot on the channel | `ProjectConversationListLive.test.tsx`; route test "the read summary marks a room…" | **(d)** not in the spec | n/a |
| Renames update old mentions (keyed by id) | `RoomMessageText.test.tsx`; `ProjectRoomLive.test.tsx` "a mention renders by person id…" | **(d)** | `room-live-mention-*` |
| Legacy `**@name**` still renders | `RoomMessageText.test.tsx`, with a fixture in the stored Task-room history shape | n/a | n/a |
| Non-member mention refused | route test | spec test 4 | n/a |
| Member directory: room readers only, active people, `{id, displayName, kind}` only; non-member and revoked refused | route test "members (#4799): only a current room reader may list…" | **(d)** | n/a |
| Revoked mid-stream: `revoked`, then no typing, presence or messages | route test "a member revoked mid-stream gets revoked and nothing after it" | **(d)** | n/a |
| Agent working indicator follows the lifecycle | `ProjectRoomLive.test.tsx` "the Agent working row appears and clears…" (fails if hard-coded on); `ProjectConversationListLive.test.tsx` (sidebar); route test "a request still working is carried however many newer requests have settled"; "failed preparations never crowd a request still working out of the frame"; "working requests are found past more failed ones than one page…" | spec test 5 sees a recorded request's row and its outcome. No Agent can run on the e2e Station, so a real appear-then-clear is **(d) NOT_VERIFIED** | `room-agent-working-*`, `room-agent-outcome-*` |
| Stop, and Retry as a new request | `ProjectRoomLive.test.tsx` "the person who asked can Stop…" | **(d)** | `room-agent-outcome-*` |

An earlier snapshot of this table, before the real-Station and gallery runs, listed every (a) and (c) cell as pending.

## Fault injection

Each of the 25 injections ran from a clean committed tree. The named file was restored with `git checkout` and its test re-verified green. In round 1, four injections survived because their tests did not reach the behavior: typing stop and typing disconnect (masked by the 6 s expiry), the sidebar working mark (cleared by an empty list rather than a settled request), and the read summary (no unread message naming someone else). Those tests were tightened, and all four are caught in round 2. Seven were added afterwards: one for the member directory's active-only list, then six for privacy and revocation. Of those six, five are caught. Removing only the stream loop's per-frame check survives, because the response guard re-checks the same admission before every chunk and sends the terminal `revoked` frames. Removing the guard's terminal frames, or both layers, is caught. Later rounds added eight more, each caught and restored byte-exact: the For you pending and no-scope states, the live hub's replay to a late listener, the sidebar's re-read when a room is announced, two notification-focus fixes, and the three defects an independent review found (a failed reconciliation advancing the cursor, a read in flight undoing a live merge, and newer settled requests hiding one still working). Full records, including failure lines, are in [fault-injection.json](fault-injection.json).

## Not shipped, with reasons

- **Read-marker changes are not a frame kind.** Another device of the same person learns that a channel was read from the read-marker summary, refreshed every 30 s; tracked in #5040.
- **Task rooms are not on the shared stream**, a gap against #4798's "every room the sidebar shows"; it moved to #4986. Their transport (epochs, `throughSeq`, separate authorization) is its own; their sidebar rows keep the read-marker summary.
- **"Current step" is the request's lifecycle phase.** An Agent's Session steps stay private to its runner.
- **Project channels have nothing to fold.** A request publishes one message. Task rooms already fold an execution's turns into its thread; this PR adds its "is working" summary.
- **One connection per Project, not per client.** The sidebar shows one Project at a time.
- **No push.** Person-mention notifications reach the private feed and For you, not lock-screen push.
