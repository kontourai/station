# Design sketch: channels in the sidebar and on the phone (#4794, #4795)

Written before implementation. One list model feeds both surfaces: a Project's
channels and its Task rooms, with unread state from the server's read markers
(#3075) and a working mark derived from the live session lanes.

## Data (one hook, both surfaces)

```
useProjectConversationIndex(project)
  channels  ← useProjectRoomChannels (#4792)       default first, then by name; archived left out
  tasks     ← useTasksQuery(projectId)             30 most recently updated Tasks are candidates
  unread    ← useReadMarkerSummaryQuery(targets)   one POST for channels + candidate Task rooms (≤ 80 < 100)
  task room ← summary item is not `unavailable`    a Task whose room was never opened is not listed
  working   ← Task.sessionId ∈ project's Running lane (projectLiveLanes, the sidebar badge's own model)
```

- Unread = `item.unread` from the server. Nothing is derived on the client.
- Mentions: no dot. Nothing computes "mentions me" until #4799.
- Channels show no working mark. The request lifecycle that would drive it is
  #4800.
- Opening a channel marks it read through its `checkpoint.lastSeq`. Opening a
  Task room marks it read through `throughSeq`. The summary refetches, so the
  bold clears here and, within one refresh, on a second client.

## Desktop sidebar (1440)

```
┌ Station ─────────────────────── ┐
│ ⌂ Home                          │
│ ⚡ Activity                      │
│ PROJECTS                      + │
│ ◆ Onboarding revamp    2   ⌄  ⠿ │   ← expanded (active) Project
│   [Board] [Notes]               │   ← layout chips (unchanged)
│   CHANNELS                    + │   ← quiet "New channel" (icon button)
│   # general                  3  │   ← bold + count: unread
│   # design                      │
│   # launch-plan                 │
│   TASKS                         │
│   ◌ Fix login redirect        2 │   ← ◌ = subtle pulse: agent running; bold: unread
│   ▫ Draft release notes         │
│   ▫ Audit pricing copy          │
│   More Tasks                    │   ← Project's Tasks section
│ ◆ Kontour site                  │   ← collapsed Project: no sections
└─────────────────────────────────┘
```

- Row: 30px tall on desktop and 44px under the phone query. The label is
  ellipsized, and the trailing count slot holds 2ch.
- Current channel or Task: `aria-current="page"`, using the same active
  treatment as layout chips.
- Keyboard: Up/Down move between rows in the two sections (roving tabindex),
  and Enter or Space opens the focused row.
- Accessible names: "general, 3 unread", "Fix login redirect, Task room, agent
  working, 2 unread".
- Task cap: 5 rooms. "More Tasks" appears only when more exist.
- States: skeleton rows while loading, and an ErrorState with Retry for the
  channel list or the Task-room summary. A failed summary leaves channels
  listed with normal weight.
- The collapsed rail popover keeps its views list unchanged. Channels live
  under the expanded row only.

## Phone (390 / 360)

```
Project (overview)          Channel (pushed)             Thread (pushed)
┌──────────────────────┐    ┌──────────────────────┐     ┌──────────────────────┐
│ ☰  Onboarding revamp │    │ ‹  # general       ⋯ │     │ ‹  Thread · #general │
│ [New Task] [Add files]│    │    Team-wide updates │     │                      │
│ CHANNELS           + │    │ ─────────────────── │     │ Jonas  14:02         │
│ # general        3 › │    │ Jonas  14:02         │     │ Release notes are…   │
│ # design           › │    │ Release notes are…   │     │ ── 2 replies ──      │
│ # launch-plan      › │    │   2 replies ›        │     │ Maya   14:05         │
│ TASKS                │    │ …                    │     │ Looks right to me.   │
│ ◌ Fix login…     2 › │    │                      │     │                      │
│ ▫ Draft release…   › │    │ [Message #general  ↑]│     │ [Reply in thread   ↑]│
│ Live work …          │    └──────────────────────┘     └──────────────────────┘
└──────────────────────┘
```

- URL is the state, so Back is the browser's:
  - list: `/projects/<slug>`
  - channel: `?section=room&channel=<id>`
  - thread: `…&thread=<messageId>`

  Each step is a pushed entry. The header ‹ uses `history.back()` when the
  previous entry is the same page and otherwise navigates to the parent.
- The conversation is full-screen. The Project header and section picker are
  hidden, and the composer stays pinned through the shared
  keyboard-keep-above (#4810).
- Header: `#name`, the topic on a second line, and member faces. ⋯ opens the
  overflow sheet: Rename, Topic, Archive, Notes, Switch channel.
- Thread: a channel message's replies (`replyTo`). A root with replies shows
  "N replies ›" under it. The thread page lists the root, then its replies,
  and its composer replies to the root. On desktop the same thread opens
  beside the conversation, and Close or Back returns.
- Back restores the list's scroll position, saved per Project when the list is
  left and restored after the list re-renders.
- One breakpoint: `MOBILE_MEDIA_QUERY` from `useIsMobile.ts`. The Task room's
  640px block moves to it.
- No horizontal scroll at 360: rows ellipsize, and counts and chevrons never
  wrap.

## #4814 (chat dock inbox)

The selection key becomes `[authority, environment, Station, row.id]`. It drops
`chatSessionId` and the binding's `affinity`, which the open itself writes. An
`unavailable` outcome while still current reports through `onOpenFailed`.

## Changed during implementation

- On desktop a thread opens in the conversation area, with a bar back to the
  channel, not beside it. The room keeps one composer and one retained send,
  so the composer replies into the open thread instead of a second composer
  competing with it.
- In a thread, the root is followed by a quiet "N replies" divider, and
  Recap is not offered.
- The in-room back buttons go to their parent's address rather than calling
  `history.back()`; the device's Back still retraces the pushed entries.
- The working mark is a filled square in the active color, not an animation.
- Review fixes (#4855): a channel is marked read only through the newest message
  a successful history read showed, never from discovery alone, and not while a
  thread is open. Every send from a thread replies to its root, read from the
  route. A thread link to an older root pages back to it, up to 20 history
  windows (500 messages), with loading, error and "not in this channel" states.
  A failed unread summary keeps channel rows at normal weight beside its own
  retry.
