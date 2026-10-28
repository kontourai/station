---
"@kontourai/station-contracts": minor
---

Add the `conversation-title` contract subpath with `isLowContentPrompt`, the shared rule that keeps a prompt such as "Continue" from naming a conversation, and the optional `titleModel` app setting that names a conversation after its first reply. Title generation now runs only when `titleModel` is set: it no longer falls back to `structureModel`, and a hosted Station never runs it. Runtime `ConversationListItem`s now carry `titleSource` (`prompt`, `provider` or `generated`).
