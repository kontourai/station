---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

A Station records a default for new chats. `AppConfig.newChatDefault` (`{ agent, reason }`) names the Agent new chats start with when nothing closer names one: `first-signed-in` when Station picked the first engine whose sign-in it has verified, in the fixed order Claude Code, Codex, other engines by id; `chosen` when a person picked it. `describeNewChatDefaultViolation` is the one rule: a `first-signed-in` record is written only while none exists. `StationCapabilityFlags.newChatDefault` reports a host that serves `POST /config/new-chat-default`. The SDK adds `useNewChatDefaultCapability()` and `useRecordNewChatDefaultMutation()`; the mutation resolves `recorded: false` with the standing default when the host keeps one it already has.

Behaviour change: on an upgraded Station with no remembered Agent, new chats move from Station's assistant to the first engine whose sign-in Station has verified.
