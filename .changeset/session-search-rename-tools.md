---
'@kontourai/station-contracts': minor
---

`ConversationListItem.titleSource` gains `'agent'`: the provenance of a title a
station-control agent set with the new `rename_session` tool (#176). An agent
title is not a person's, so a UI replaces it without asking, as it does a
`generated` one; a title with `titleSource: 'user'` is still never replaced by
an agent.

Station Control gains two tools. `search_sessions` searches the calling
session owner's own transcripts through the unified search behind
`POST /api/search` (session and message hits only, query of 2 to 256
characters, refused outside that range) and, for every caller including a
bound operator, sees only the transcripts of the person the calling session
acts for. Its hits are message hits, mostly from
native Claude and Codex session transcripts. `rename_session` renames a
Station-stored conversation through its own route,
`POST /api/conversations/:id/agent-title`, and refuses with `person_title` over
a person's title (decided atomically with the write) and with
`runtime_title_unsupported` for a native Claude or Codex conversation, whose
title the runtime owns, so a search hit is usually not renameable. A title is
refused, not truncated, when over 80 characters, empty, or containing control,
line-separator or bidirectional-control characters (leading and trailing
spaces are trimmed). `rename_session` reaches only a conversation the calling
session's owner owns, except that a bound operator caller is not limited to one
owner's conversations; a caller that is not bound also stays in its own
session's Project scope.
