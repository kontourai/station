---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add the coordinator in a Project Room's `#general`, behind the `project-room-coordinator` Feature Preview. Contracts add `@kontourai/station-contracts/project-room-coordinator` (the Project's coordinator limits and their parser and defaults, `askedForPullRequest`, `parseCoordinatorReply` for the reply's `station_routing` block, the row states, the suggested-Tasks card view and the status sweep result), `ProjectConfig.roomCoordinator` and the `projectRoomCoordinator` capability flag. The SDK adds `@kontourai/station-sdk/project-room-coordinator`: the card, Start, status sweep and settings clients and their React hooks.
