---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

A Session whose turn start may have reached its engine no longer refuses every later message until Station restarts when that engine is observed gone. Contracts add `TURN_START_HELD_CODE` (`turn_start_held`) to `@kontourai/station-contracts/orchestration`: the code of the refusal a send gets while such a start is held, so clients can say what clears it instead of suggesting a retry. Shared adds `TURN_ENGINE_ENDED_MESSAGE` to `@kontourai/station-shared/runtime-event-projection`: the interrupted-turn banner's text when Station settles the held start at runtime.
