---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Delegated turn supervision can now be idle-only. `DelegatedTaskTurnSupervision.deadlineAt`, `remainingMs` and `totalLimitMs` (SDK) and `TurnSupervisionFacts.deadlineAt`/`totalLimitMs` (contracts) are optional and present together only when a total turn budget was declared; Muse declares none by default. Consumers that read them as always-present numbers must handle their absence. Contracts also add `MUSE_TURN_IDLE_TIMEOUT_CODE`/`MUSE_TURN_TOTAL_TIMEOUT_CODE` and widen the `tool.completed` status documentation (`unresolved` at a one-turn engine's turn end, engine-reported `cancelled`).
