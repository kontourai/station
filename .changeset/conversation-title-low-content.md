---
"@kontourai/station-contracts": minor
---

Add the `conversation-title` contract subpath with `isLowContentPrompt`, the shared rule that keeps a prompt such as "Continue" from naming a conversation, and the optional `titleModel` app setting that names a conversation after its first reply. Runtime `ConversationListItem`s now carry `titleSource` (`prompt`, `provider` or `generated`).

Behavior change: Station generates chat titles only when `titleModel` is set. Until now, a chat kept by a file-store Agent was titled by `structureModel` when `titleModel` was empty; that fallback is gone, because the title prompt quotes the conversation and `structureModel` is configured for another purpose. Such chats now keep a title derived from their first message. To get generated titles back, set `titleModel` (Settings → Chat → Chat title model, or `titleModel` in the Station config) to the model `structureModel` names. A hosted Station never generates titles.
