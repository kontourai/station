---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

Add the Muse background-work codes: `MUSE_LINGERING_CHILD_REAPED_CODE` and `MUSE_HELD_TURN_UNFINISHED_CODE` (`runtime.warning` codes for a held Muse turn's unreported background work), and `MUSE_TURN_SLOT_RELEASING_CODE` (a retryable send refusal while the previous Muse process is still exiting). Document that an adapter may suspend a turn's declared `idleLimitMs`. The runtime-event projection now reconciles `turn.completed.outputText` against all of a turn's emitted text: an equal text adds nothing and a strict extension appends only the missing suffix, so a turn whose `outputText` is its whole text no longer duplicates text written before a tool.
