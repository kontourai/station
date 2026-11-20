---
"@kontourai/station-sdk": minor
"@kontourai/station-contracts": minor
---

Read sessions that live on a connected SSH environment's Station. `fetchRemoteSessionHistory(environmentId, threadId, { cursor?, turnLimit? }, { apiBase?, requestScope?, signal? })` reads one read-only, bounded history page relayed by the named Station and rejects with `StationHttpError` carrying the route's `code`, and `readRemoteSessionHistoryCapability(apiBase)` reports the new `remoteSessionHistory` handshake flag (`StationCapabilityFlags.remoteSessionHistory`), which hosted Stations withdraw. `listOrchestrationSessions` takes an optional `{ limit }` asking for only the newest sessions. A response past `maxResponseBytes` now rejects with `StationResponseTooLargeError`, and the orchestration and conversation-search readers keep it as the `cause` of their unreadable-body error. `getOrchestrationSessionDetailWindow` rejects with `SessionDetailWindowUnsupportedError` (also exported from the agent entry) when a host answers without a `window-v1` page.
