---
'@kontourai/station-contracts': patch
---

`CONVERSATION_HANDOFF_DISCLOSURE_LABELS.authorizedTranscript` now reads
"Recent conversation messages, up to a size limit" (was "Conversation
transcript"). An Agent/engine handoff, and a continuation that cannot resume a
native cursor, now seed the new engine with the most recent whole messages under
an estimated-token budget instead of the last 6,000 characters, and tell it how
many earlier messages were left out and that they are not available to it.
