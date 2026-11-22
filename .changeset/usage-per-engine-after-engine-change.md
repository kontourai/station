---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
---

A conversation that changes engine keeps each engine's usage (#5389). Folding the whole lineage as one stream let an engine that reports a running total (Codex) replace what a per-turn engine (Claude Code) had counted.

`foldLineageUsageEvents` (new subpath `@kontourai/station-shared/usage-lineage-fold`) folds Sessions into runs (for Codex, Sessions on the same recorded native thread; for other engines, consecutive Sessions of the engine) and combines the runs per engine into `LineageUsageAggregate.engines` (`EngineUsageAggregate`). The per-Session fold in `usage-fold` is unchanged. The conversation stats response gains `engines` (`ConversationEngineUsage`, validated by `parseConversationStatsResponse`, which refuses an engine listed twice or more than `CONVERSATION_STATS_ENGINES_MAX` rows; `reportsEngineTokens` is the shared "reported tokens" predicate). When more than one engine reported tokens, the response's own token figures are absent rather than a sum across engines; turns, tool calls and costs (per unit) stay conversation-wide. A single-engine conversation gains its one `engines` row; its figures change only where a Codex successor ran on a new native thread, whose total now adds to the earlier thread's instead of replacing it.
