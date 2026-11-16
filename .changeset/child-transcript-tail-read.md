---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

A child transcript can be read the way a chat reads it. `ChildWorkTranscriptPage` now carries `offset` and `endOffset` (where a page's messages start and end), and `getChildWorkTranscript` accepts `tail: true` for the latest messages. The new `useChildWorkTranscriptTailQuery` opens on the latest messages, loads older ones through `fetchPreviousPage`, and while the child runs reads only the messages past its last `endOffset`, instead of re-reading every loaded page.
