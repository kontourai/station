---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Add the `delegatedInputAnswers` Station capability flag. A Station that
advertises it accepts an optional `expectedInputRequest` on
`POST /api/orchestration/delegations/:taskId/continue` and delivers the
follow-up only as the answer to that exact open input request, refusing with
`input_request_changed` when it is gone or replaced. Senders must gate the
field on the flag; an older Station would drop it and deliver an unbound turn.
The delegated-task snapshot's `pendingRequest` gains optional `eventId`,
`body` (the presented question text) and `callerCanRespond` (the serving
Station's own check for the reading caller). The orchestration contract's
`OrchestrationPeerPendingRequest` and the attention contract's
`AttentionPeerRequestReference` carry the matching optional fields.
