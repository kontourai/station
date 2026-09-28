---
"@kontourai/station-sdk": patch
---

A per-call request deadline that fires while the response body is being read now raises `StationRequestTimeoutError`, with the same `method` and `mutation` facts as a deadline missed before the headers. Before, the envelope helpers reported it as an unreadable body ("Orchestration API error: 200", "Request failed"). A command whose headers had already arrived, and whose change may have been applied, therefore read as a plain failure.
