---
'@kontourai/station-contracts': minor
'@kontourai/station-shared': patch
---

Three new retryable provider refusal codes: `provider_session_starting` (the
session was still starting when the wait ran out; nothing was sent),
`provider_session_start_failed` (the session could not start; nothing was
sent) and `client_turn_in_flight` (an earlier attempt with the same client
turn id still holds its key; retry with the same id). `ProviderSendTurnInput`
documents that its `signal` may only come from a server-owned stop, cancel,
deadline or shutdown, never from an HTTP request. The shared transcript
projection stamps a content run that no turn opened with its first event's
time, so a resumed session's replay sorts into place instead of after every
newer message.
