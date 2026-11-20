---
"@kontourai/station-contracts": minor
---

Add optional `viewingSessionIds` to `FocusReport` and `FocusSurfaceSnapshot`
in `@kontourai/station-contracts/presence`, with `FOCUS_VIEWING_SESSION_IDS_MAX`
and `FOCUS_VIEWING_SESSION_ID_PATTERN`. A focused document that lists the chat it
shows quiets a finished-turn (`done`/`info`) alert on the person's other surfaces
only for that session. A report without the field keeps device-wide focus.
Hosts built before this field answer 400 to it, and the Station client then
reports without it.
