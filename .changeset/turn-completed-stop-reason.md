---
'@kontourai/station-contracts': minor
---

`TurnCompletedEvent` gains an optional `stopReason` (#354): the engine's own
stop reason, carried only when the shared `finishReason` vocabulary cannot
express it and `finishReason` therefore reads `'other'`. The ACP adapter sets
it for `refusal` and `max_turn_requests`, so those completions are no longer
indistinguishable from any other `'other'` stop. The turn's outcome is
unchanged.
