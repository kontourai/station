# Room conversation: target sketch

Written before implementation (#4790, #4793). One list and one composer serve the Project
room and the Task room. Type is 14px (`--k-text-md`) on a 22px line
(`--k-text-md + --k-space-2`). Spacing uses the six `--k-space-*` steps; colors come only
from `--k-*` tokens.

## 1440

```
┌ # Project room ─────────────────────────────────── (JB)(S) 2 here ─ [Conversation][Notes] ┐
│                                                                                            │
│                         ───────  Tuesday, November 3  ───────                              │
│ (JB) Jonas Berg  14:02                                          ┌──────────────────────┐   │
│      Morning! The pricing page copy is ready for review.        │ ↩ Reply   ⋯          │◄ hover bar
│ 14:03 I kept the three tiers and moved the FAQ under the table.  └──────────────────────┘   │
│  ▲ stacked row: no avatar or name; its time shows in the gutter on hover                   │
│ [S]  Scout  AGENT  14:06                                                                   │
│      I checked the draft against the plan limits in `pricing.yaml`:                        │
│        • Team lists 10 seats; the plan allows 15.                                          │
│      ┌──────────────────────────────────────┐                                             │
│      │ (MC)(JB) 2 replies   Last reply 13:31 │  thread summary (Task room)                  │
│      └──────────────────────────────────────┘                                             │
│ ──────────────────────────────────────────────────────────────── New ─                    │ unread divider
│ (JB) Jonas Berg  16:04                                                                     │
│      Release notes are drafted.                                                            │
│                                   ( ↓ 3 new messages )                                     │ jump pill
│ ┌────────────────────────────────────────────────────────────────────────────────────┐    │
│ │ Message #Project room                                                              │    │ composer
│ │ [@] [Ask an agent]                                                           ( ➤ ) │    │ round send
│ └────────────────────────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Avatars: people are circles, agents are rounded squares in the brand color, so the two read
  apart before the "Agent" badge.
- A group is one author within 5 minutes on the same day. System rows and replies start a
  new group.
- Times are short (`14:06`); the full date and time is the tooltip.
- The hover bar sits on the row's top-right edge, so it covers no text. Keyboard focus inside
  the row shows it too.
- Day dividers are centered labels on a hairline. The unread divider is an accent hairline
  labeled "New" at the right edge.

## 390

```
┌ ‹  # Project room           ┐
│ ── Tuesday, November 3 ──   │
│ (JB) Jonas Berg  14:02      │
│      Morning! The pricing   │
│      page copy is ready…    │
│      I kept the three tiers │
│ [S]  Scout  AGENT  14:06    │
│      I checked the draft …  │
│                             │
│     ( ↓ 3 new messages )    │
│ ┌─────────────────────────┐ │
│ │ Message #Project room   │ │ grows to 5 lines, then scrolls
│ │ [@][Ask]           (➤)  │ │ 44px targets
│ └─────────────────────────┘ │ rides the keyboard (visual viewport)
└─────────────────────────────┘
```

- A long press opens the row's action bar (touch has no hover). Every control in the bar and
  composer is at least 44px.
- Return adds a new line on a touch keyboard; the round send button sends. On desktop, Enter
  sends and Shift+Enter adds a new line. IME composition never sends.
- At 360px nothing scrolls sideways: code blocks scroll inside their own frame, and long words
  wrap.
