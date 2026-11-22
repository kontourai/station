---
"@kontourai/station-contracts": minor
"@kontourai/station-shared": minor
"@kontourai/station-sdk": minor
---

Add the Project brief, Project memory and Project usage, behind the `project-coordination` Feature Preview. Contracts add `@kontourai/station-contracts/project-session-context` (the brief and memory note shapes, their limits and parsers, and `composeProjectSessionContext`, the one composer of what a new Session in a Project starts from), `ProjectConfig` `goal`, `instructions`, `coordinatorEffort`, `taskModel`, `taskProviderId` and `taskEffort`, the `PROJECT_SESSION_CONTEXT_METADATA_KEY` and `PROJECT_SESSION_CONTEXT_COMPOSED_METADATA_KEY` reserved metadata keys, `projectBrief` and `projectMemory` context-injection blocks, a `project` usage grouping with `projectSlug` attribution, `projectUsageTotals`, and the `PROJECT_MEMORY_FULL_CODE` (`project_memory_full`) refusal, mapped in `PROVIDER_FAILURE_KINDS` to the non-retryable `conflict` kind. Shared's turn provenance fold reads the Project context a turn carried on every engine. The SDK adds Project memory clients (`listProjectMemory`, `getProjectMemoryNote`, `createProjectMemoryNote`, `updateProjectMemoryNote`, `deleteProjectMemoryNote`) and a `projectSlug` usage rollup filter.
