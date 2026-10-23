---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Tracker-backed Tasks (station#4003).

`@kontourai/station-contracts/task-memory` is new: the Task summary revision
and keyed record shapes (decisions, open questions, dead ends), their limits,
default importance, the stateless write checks (`checkTaskRecordWrite`,
`taskSummaryRefusal`) and refusal wording, `taskAwaitsAnswer`, and the
Learning shapes a done Task's promotion candidates use. Every bound is a
refusal.

`@kontourai/station-contracts/work-item-provider` adds the tracker observation
shapes (`WorkItemObservation`, `WorkItemObservationResult`,
`WORK_ITEM_OBSERVATION_LIMITS`), Start Task's result, and the GitHub work-item
ref helpers (`parseGitHubWorkItemRef`, `formatGitHubWorkItemRef`,
`gitHubIssueUrlFromWorkItemRef`, `workItemRefFromGitHubIssueUrl`).
`TaskRecord` gains an optional `workItemObservedAt`, and
`@kontourai/station-contracts/provider` names the Task brief start metadata
keys (`TASK_BRIEF_METADATA_KEY`, `TASK_BRIEF_COMPOSED_METADATA_KEY`).

`@kontourai/station-sdk` adds Start Task from a work item
(`startTaskFromWorkItem`, `useStartTaskFromWorkItemMutation`), the Task's
linked-item read (`useTaskWorkItemQuery`), Task memory reads and writes
(`useTaskMemoryQuery`, `useTaskSummaryHistoryQuery`,
`useUpdateTaskSummaryMutation`, `useWriteTaskRecordMutation` and their fetch
functions; a stale summary edit rejects with `TaskSummaryConflictError`
carrying the current revision), and a done Task's Learning review
(`useTaskLearningQuery`, `usePromoteTaskLearningMutation`,
`useDismissTaskLearningMutation`).
