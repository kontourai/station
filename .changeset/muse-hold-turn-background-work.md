---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

Add the Muse background-work codes: `MUSE_LINGERING_CHILD_REAPED_CODE` and `MUSE_HELD_TURN_UNFINISHED_CODE` (`runtime.warning` codes for a held Muse turn's unreported background work), and `MUSE_TURN_SLOT_RELEASING_CODE` (a retryable send refusal while the previous Muse process is still exiting). Document that an adapter may suspend a turn's declared `idleLimitMs`.

The runtime-event projection now reconciles `turn.completed.outputText` against ALL text the turn emitted, as the live chat path already does: an equal text adds nothing, and a strict extension appends only the missing suffix. This changes how reloaded transcripts render for more than Muse, in each case to match what the live view showed:

- Muse, Codex and station-agent turns whose `outputText` is the whole turn's text no longer repeat the text written before a tool (or across several tool segments) in the final paragraph.
- Turns with reasoning between text segments (thinking-interleaved Claude) no longer repeat the text before the reasoning.
- When `outputText` extends the streamed text only by a trailing suffix (a coincidental prefix, text reported only at the terminal, or a trailing newline), that suffix is now appended rather than dropped.

Turns whose `outputText` is only the final answer (Claude without interleaved reasoning) render as before.
