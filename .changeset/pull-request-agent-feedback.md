---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add pull request agent feedback, behind the `pull-request-agent-feedback` Feature Preview. Contracts add `@kontourai/station-contracts/pull-request-feedback` (settings, status, delivery and observation shapes), an optional `getFeedbackObservation` on the pull request provider, and a `pullRequestFeedback` capability flag. The SDK adds a client for `/api/pull-request-feedback` to read a conversation's feedback state, turn its switches on or off, send a paused pull request's feedback again, and read whether the host serves it.
