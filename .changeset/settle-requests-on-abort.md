---
"@kontourai/station-contracts": patch
"@kontourai/station-shared": minor
"@kontourai/station-cli": patch
---

A request left open by an aborted turn is settled instead of staying pending.
`@kontourai/station-shared/request-settlement` exports
`requestIdsSettledByTurnAbort`, the fold the server and the CLI both apply.
`station approvals list` and `station operate` no longer offer such a request,
`approvals list` rows carry `requestEventId`, and `approvals respond` and
`operate` bind a decision to the request event they showed. The contracts
change is documentation of `request.opened.turnId` and of what a
`request.resolved` with status `cancelled` or `expired` means.
