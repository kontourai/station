---
"@kontourai/station-contracts": minor
---

An automation can have a display name. `SchedulerJob`, `AddJobOpts` and `UpdateJobOpts` carry an optional `displayName`, bounded by the new `SCHEDULER_JOB_DISPLAY_NAME_MAX_CHARS`. `name` stays the internal slug that routes, runs and grants are keyed by, so renaming an automation (`displayName` on an update; `null` removes it) keeps its id and its runs. A Station from before this change ignores the field, and the job keeps showing its slug.
