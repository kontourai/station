---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Projects can choose how a new chat starts: on the project's set model and approval mode, or on what your last chat in that project started with. `@kontourai/station-contracts/project-chat-defaults` adds the selection, posture and `GET /api/projects/:slug/chat-defaults` view shapes and their one resolver; `ProjectConfig` gains `defaultModelSelection`, `defaultApprovalMode` and `defaultApprovalModeSelection`. The SDK adds `getProjectChatDefaults` and `useProjectChatDefaultsQuery`.
