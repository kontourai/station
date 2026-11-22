---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

An automation can have a display name. `SchedulerJob`, `AddJobOpts` and `UpdateJobOpts` carry an optional `displayName`, checked by `isSchedulerJobDisplayName` and bounded by `SCHEDULER_JOB_DISPLAY_NAME_MAX_CHARS`. `name` stays the internal slug that routes, runs and grants are keyed by, so renaming an automation (`displayName` on an update; `null` removes it) keeps its id and its runs.

`AddJobOpts.name` is now optional: a create that gives only `displayName` gets the first unused slug of `schedulerJobSlugCandidates`, decided by the host against every job; a taken slug is refused with `SCHEDULER_JOB_NAME_TAKEN`. Hosts that do this advertise the new `schedulerJobDisplayName` capability flag, read with `useSchedulerJobDisplayNameCapability()`. A Station without it drops `displayName` and still answers success, so clients offer renaming only with the flag and name the slug themselves there.
