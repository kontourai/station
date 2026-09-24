---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-cli": patch
---

Muse turns no longer have a default idle bound (#2269). `TurnSupervisionFacts.idleLimitMs` (contracts) and `DelegatedTaskTurnSupervision.idleLimitMs` (SDK) are now optional and present only when an idle bound was declared for the turn; a Muse turn with no declared bound publishes a declaration with neither `idleLimitMs` nor a total budget. Consumers that read `idleLimitMs` as an always-present number must handle its absence. `station delegate status` prints "Idle limit: none declared for this turn" for such a turn.
