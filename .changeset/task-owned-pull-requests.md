---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Let a Task watch the pull requests it keeps until they land, behind the `pull-request-agent-feedback` Feature Preview. Contracts add `@kontourai/station-contracts/pull-request-watch` (the Project setting, a Task's choice, the ready test, refused-action kinds and the Task's watch view), optional `ProjectConfig.pullRequestWatch`, `TaskRecord.pullRequestWatch` and `TaskRecord.pullRequestWatchHold`, the `fix-budget` pause reason and the `fixAttemptsUsed` Task lane rung. Station builds that predate them refuse a Task store carrying either Task field. The SDK adds `@kontourai/station-sdk/pull-request-watch` to read a Task's watch and set a Task's or Project's choice.
