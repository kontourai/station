---
"@kontourai/station-contracts": minor
---

Add the `conversation-title` contract subpath with `isLowContentPrompt`, the shared rule that keeps a prompt such as "Continue" from naming a conversation, and the optional `titleModel` app setting that names a conversation after its first reply. Runtime `ConversationListItem`s now carry `titleSource` (`prompt`, `provider` or `generated`).
