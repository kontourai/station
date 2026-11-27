## Design sketch (before code) — #4798, #4799, #4800

### One live connection per client (#4798)

```
client ──GET /api/projects/room-live?room=<slug>~<channelId>&room=…&client=<uuid>──▶ server
        ◀── subscribed {key, roomId, lastSeq, activity}         one per room, after its own `view` admission
        ◀── append     {key, message}                          message.seq must be lastSeq+1
        ◀── update     {key, message, fromActivity, activity}  edit / reaction / delete, full projected row
        ◀── read       {key, seenVersion}                      the caller's own marker moved (another device)
        ◀── typing     {key, actors}                           self-expiring; cleared on stop and on disconnect
        ◀── presence   {key, participants}
        ◀── agents     {key, requests}                         from the request lifecycle (reserved/started/…)
        ◀── resync     {key}                                   server could not compute a delta: client re-reads
        ◀── revoked    {key}                                   this room only; others keep streaming
```

- Each subscription is admitted exactly as a room history read (`service.history`, `view`), and re-checked before every frame for that room. A refused room ends only that subscription. Nothing widens: members stay read-only unless the operator granted `orchestration:operate`.
- Gap rule (client): `append.seq !== lastSeq + 1` → backfill `after=lastSeq` from history, merge, continue. `update.fromActivity !== activity` → re-read the room's windows. Never apply past a gap.
- Typing: `POST …/typing {clientId, typing}`; server keeps it ~6 s; the stream's close clears that client's typing and presence. Presence no longer heartbeats every 20 s: it lives as long as the stream that registered it.

### Mentions (#4799)

```
 Composer                                  Stored record
 ┌──────────────────────────────────────┐  text:     "@Priya can you check the copy?"
 │ @pri                                 │  mentions: [{kind:"person", actorId:"human:…:priya",
 │ ┌ People ──────────────────────────┐ │             display:"Priya", offset:0}]
 │ │ (PN) Priya Natarajan    here now │ │
 │ │ (JB) Jonas Berg                  │ │  Rendered: [@Priya Natarajan] can you check the copy?
 │ │ Agents                           │ │            └ chip, current name looked up by actorId
 │ │ (✦)  Writer            @writer   │ │
 │ └──────────────────────────────────┘ │  Legacy:   "**@Writer** draft it" still renders a chip
 └──────────────────────────────────────┘
```
- ↑/↓ + Enter/Tab on desktop; each option is a 44 px row on a phone. Agents keep today's dispatch (recipient chip).
- The server refuses a mention of someone who is not a member of the Project.
- One notification for each mentioned person (never the author), in their private feed: "Maya mentioned you in #general". Opening it goes to `/projects/<slug>?channel=<id>&message=<messageId>` and scrolls to that message, which flashes.
- Sidebar: a channel with an unread mention of you shows an accent `@` dot beside its unread count.

### Agent working state (#4800)

```
 Sidebar row                Thread summary                     Conversation (live row)
 # general   ⟳ ●3           ↳ 2 replies · ⟳ Writer is working   (✦) Writer  ⟳ Working on your request…   [Stop]
                                                                    Asked by Maya · started 2:04 PM
 Outcomes stay inline:
 (✦) Writer  ⚠ Couldn't finish — the agent didn't return an answer.    [Retry]
 (✦) Writer  ■ Stopped by Maya.                                         [Retry]
```
- State is read from the room's request records (`reserved` → Starting, `started` → Working, `published` → gone,
  `uncertain`/failure → Couldn't finish, `cancelled` → Stopped). Nothing is inferred from timers.
- "Current step" is the request's lifecycle phase. The agent's private session steps are not shown to room readers.
- Task rooms: consecutive agent-only activity rows for one run (started → finished) fold into one group:
  `(✦) Builder · 3 steps · finished 2:10 PM  ▸`, with the final answer row always visible below it.
