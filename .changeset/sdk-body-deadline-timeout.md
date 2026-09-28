---
"@kontourai/station-sdk": patch
---

A per-call request deadline that fires while a response body is being read, through `json()`, `text()`, `arrayBuffer()`, `blob()`, `formData()` or `bytes()`, now raises `StationRequestTimeoutError` with the same `method` and `mutation` facts as a deadline missed before the headers. `response.body` streams are not covered.

Every SDK helper that unwraps a body passes that error on instead of reporting an unreadable or non-JSON body ("Orchestration API error: 200", "Request failed", "Expected JSON response"). This covers `readEnvelopeOrThrow`, `readJsonBody` and each client module's own unwrap, on both the 2xx and non-2xx branches, and every fallback written as `.catch(...)` on a body read, `.then(...)` chains included. Before, a command whose headers had arrived, and whose change may have been applied, read as a plain failure.

Where a call classifies failures into its own typed uncertainty, a mid-body deadline now gets the same classification as a deadline before the headers:

- `adoptOrchestrationSession` throws `AdoptSessionError` with `failureClass: 'uncertain-no-response'`, so a continuation that may have been created is not read as a definite answer.
- `launchScheduledCheckStarter` throws `ScheduledCheckStarterResponseError`.
- `resolveConversationOpen` fails with kind `'network'`.

Helpers that wrap the whole request in a typed error of their own keep doing so for a mid-body deadline too. The answer basis, narrative binding, flow-gate evaluations, task basis and unified search helpers report it as their typed error with status 0, exactly as they report a deadline before the headers. The attachment-staging probe reports `unknown`. For task basis this is a change: its inner body read used to report a mid-body deadline as a non-JSON answer with the response's status, and now reports it as status 0.

The deadline-bound response is still a `Response`: `response.constructor === Response` holds, and a body reader the runtime lacks is reported as absent.
