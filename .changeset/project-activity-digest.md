---
'@kontourai/station-contracts': minor
---

`@kontourai/station-contracts/session-attention` now also owns the session
state fold the UI words its rows from: `orchestrationLifecycleLabel`,
`sessionAttentionKind` and `SessionStateLabel` moved here from the UI (which
re-exports them), plus `SESSION_STATUS_WORDS`, the status ladder's words, and
`sessionLadderWord(session)`, the ladder's word for a session summary alone.

Station Control gains two read-only tools for an agent working in a Project
(station#3413). `list_project_activity` lists the Sessions in the caller's own
Project (or the global space), newest activity first, with each Session's
status word (the one the UI shows), whether a turn is running, last activity,
engine and agent, and the worktree and branch Station recorded; a page is at
most 50 Sessions and a larger limit is refused. `get_session_digest` summarizes
one Session from recorded events only, with no model summarizing: its title,
Project, engine, status and turn count, and per turn (newest first) the
request's first line, how it ended, tool calls by name, files an engine
reported editing, pull requests declared, and Sessions delegated during it. A
page holds at most 25 turns and 8 KiB, and a cursor pages to older turns; more is
refused. Both read as the calling Session's owner, and a caller that is not a
bound operator sees only its own Project (or the global space): another
Project's, another person's, another Station's and an unconfined Session read as
not found.

`read_conversation` gains `aroundMessageId`: pass a `search_sessions` hit's
`messageId` to read the page that contains that message, with `prevCursor` and
`nextCursor` to walk either way, under the same 50-message, 64 KB and 16 KB
limits. A message id that is not in the conversation is refused with
`conversation_read_anchor_not_found`. User messages now carry the stable id a
search hit names (`<turn start event>:user`) instead of a positional `proj-<n>`.
