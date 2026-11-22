---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

A reply the engine stopped at its output limit no longer reads as finished. `OrchestrationSessionSummary.lastTurnCutOff` (`'max-tokens'`) is set while the Session's latest turn completed with `finishReason: 'max-tokens'` and no turn is open after it; `sessionLadderWord` then answers the new `SESSION_STATUS_WORDS.cutOff` ("Cut off") instead of "Done". The runtime-event projection marks that turn's last row with `metadata.turnCutOff`. Claude Code (a `max_tokens` result), ACP agents, the Station agent (an SDK `length` finish), Ollama and Bedrock report an output-limit stop. Codex, Muse Code, OpenCode and Copilot never do: their adapters report only `stop`, `cancelled` or `other`, so their cut-off replies still read "Done". Absent on older hosts.
