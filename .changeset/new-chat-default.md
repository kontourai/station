---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

A Station records a default for new chats. `AppConfig.newChatDefault` (`{ agent, reason }`) names the Agent new chats start with when nothing closer names one: `first-signed-in` when Station picked the first engine that could run a chat, in the fixed order Claude Code, Codex, other engines, Station's own engine; `chosen` when a person picked it. `describeNewChatDefaultViolation` is the one rule: a `first-signed-in` record is written only while none exists. `StationCapabilityFlags.newChatDefault` reports a host that serves `POST /config/new-chat-default`. The SDK adds `useNewChatDefaultCapability()` and `useRecordNewChatDefaultMutation()`; the mutation resolves `recorded: false` with the standing default when the host keeps one it already has.
