---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

A child transcript can be read the way a chat reads it. `ChildWorkTranscriptPage` now carries `offset` and `endOffset` (where a page's messages start and end; a read from past the end names the end), and `getChildWorkTranscript` accepts `tail: true` for the latest messages. The new `useChildWorkTranscriptTailQuery` opens on the latest messages, loads older ones through `fetchPreviousPage`, and while the child runs reads only the messages past its last `endOffset`, instead of re-reading every loaded page. Against a Station from before page ranges it pages forward by `nextOffset` (`hasLaterPage`) and re-reads its pages while the child runs.

Approval copy is plainer. `toolPolicyDeliveryExplanation` now reads, for example, "Station's approval rules apply to every tool call." and "This engine handles its own approvals; Station's rules aren't used.", and the approval-mode setting's `never` option is labelled "Full access".
