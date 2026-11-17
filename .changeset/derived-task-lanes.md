---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Derive a Task's board lane from live facts instead of its stored status. Contracts add `@kontourai/station-contracts/task-lane` (`deriveTaskLane`, `partitionTaskLanes`, and the Task pull request facts shapes) and optional `draft`, `reviewDecision` and `mergeReadiness` on `PullRequest`. The SDK adds `useTaskPullRequestFactsQuery` for `GET /api/tasks/pull-request-facts`.
