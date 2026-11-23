---
"@kontourai/station-contracts": minor
---

`SchedulerJob` carries two more read-only fields from the list read. `recentOutcomes` holds the job's last `SCHEDULER_RECENT_OUTCOMES_LIMIT` (12) finished runs, oldest first, each a `SchedulerRunOutcome` (`worked`, `failed`, `skipped` for a late occurrence recorded missed, or `unknown`), counted by occurrence so a run that retried is one, with `more` when older runs exist. `pausedItself` (`{ failures, at }`) is present while Station keeps the job turned off after repeated failures and nobody has turned it back on. Both are absent from an older Station and when the reader may not read every run of the job, so clients treat absence as unknown.
