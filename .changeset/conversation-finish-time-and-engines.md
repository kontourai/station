---
"@kontourai/station-contracts": minor
---

`OrchestrationSessionSummary` and `ConversationListItem` carry `lifecycleChangedAt`, when the current lifecycle state was entered (a finished session's real finish time), and `ConversationListItem` carries `executionProviders`, the distinct engines the conversation ran on in lineage order.
