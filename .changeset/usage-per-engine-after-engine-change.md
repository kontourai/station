---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

A conversation that changes engine keeps each engine's usage (#5389). Folding the whole lineage as one stream let an engine that reports a running total (Codex) replace what a per-turn engine (Claude Code) had counted.

`foldLineageUsageEvents` (`@kontourai/station-shared/usage-fold`) folds consecutive Sessions of one engine as one stream and combines the runs per engine into `SessionUsageAggregate.engines` (`EngineUsageAggregate`). The conversation stats response gains `engines` (`ConversationEngineUsage`, validated by `parseConversationStatsResponse`). When more than one engine reported tokens, the response's own token figures are absent rather than a sum across engines; turns, tool calls and costs (per unit) stay conversation-wide. A single-engine conversation reads as before, plus its one `engines` row.
