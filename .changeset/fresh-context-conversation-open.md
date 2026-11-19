---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Allow `resolveConversationOpen` to report an authorized empty-context
reservation as `fresh-context-ready`. The earlier transcript remains readable,
and the next successful continuation starts the reserved Session with fresh
context. The result exposes reservation identities separately from execution.
