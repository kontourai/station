---
"@kontourai/station-sdk": minor
---

`getConversationWorkState` now returns `hidden` (third-party Session thread id to when it was hidden) from a host that keeps hidden Sessions per person, typed as `ConversationWorkState`. The new `setConversationInboxHidden(apiBase, sessionId, hidden, opts)` hides or unhides a third-party Session in the caller's own inbox under the `conversation-resolution` Feature Preview.
