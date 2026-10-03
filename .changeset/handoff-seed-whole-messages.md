---
'@kontourai/station-contracts': patch
---

`CONVERSATION_HANDOFF_DISCLOSURE_LABELS.authorizedTranscript` now reads
"Recent conversation messages, up to a size limit" (was "Conversation
transcript"). An Agent/engine handoff, and a continuation that cannot resume a
native cursor, now seed the new engine with the most recent whole messages under
an estimated-token budget instead of the last 6,000 characters. The seed tells
the engine how many earlier user and assistant text messages were left out, how
many messages had no text to carry, and that the full conversation remains
stored in Station.
