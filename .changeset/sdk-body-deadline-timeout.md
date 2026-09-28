---
"@kontourai/station-sdk": patch
---

A per-call request deadline that fires while a response body is being read, through `json()`, `text()`, `arrayBuffer()`, `blob()`, `formData()` or `bytes()`, now raises `StationRequestTimeoutError` with the same `method` and `mutation` facts as a deadline missed before the headers. `response.body` streams are not covered.

Every SDK helper that unwraps a body passes that error on. This covers the envelope helpers (`readEnvelopeOrThrow`, `readJsonBody` and each client module's own unwrap, on both the 2xx and non-2xx branches) and every fallback written as `.catch(...)` on a body reader. Before, these helpers reported the timeout as an unreadable or non-JSON body ("Orchestration API error: 200", "Request failed", "Expected JSON response"). A command whose headers had arrived, and whose change may have been applied, therefore read as a plain failure.

Helpers that wrap the whole request in a typed error of their own (answer basis, narrative binding, flow-gate evaluations, task basis, unified search, the attachment-staging probe) are unchanged. They already report a timeout before the headers and one mid-body the same way.

The deadline-bound response is still a `Response`: `response.constructor === Response` holds, and a body reader the runtime lacks is reported as absent.
