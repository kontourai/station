---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Keep unread state on the server (#3075). The new `@kontourai/station-contracts/read-markers` module defines one read marker per person and conversation (agent conversations, Project rooms and Task rooms): monotonic, owned by the request's person, and never ahead of the conversation's current version. Conversation inventory items carry the derived `readState` (`version`, `seenVersion`, `unread`), or `{ version, unavailable: true }` when it cannot be read, and the `readMarkers` capability flag announces the new routes. The SDK adds `markRead`, `fetchReadMarkerSummary`, `useMarkReadMutation`, `useReadMarkerSummaryQuery` and `readMarkerQueries`; `useAcknowledgeConversationMutation` now updates the cached row's `readState` at once and restores it if the server refuses.
