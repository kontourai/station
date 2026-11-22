---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

A reply the engine stopped at its output limit no longer reads as finished. `OrchestrationSessionSummary.lastTurnCutOff` (`'max-tokens'`) is set while the Session's latest turn completed with `finishReason: 'max-tokens'` and no turn is open after it; `sessionLadderWord` then answers the new `SESSION_STATUS_WORDS.cutOff` ("Cut off") instead of "Done". The runtime-event projection marks that turn's last row with `metadata.turnCutOff`. Engines that report no finish reason stay unmarked. Absent on older hosts.
