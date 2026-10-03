---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-shared': patch
---

Add optional `clientInputId` to turn steering and an explicit indeterminate
result so acknowledgement retries preserve one engine invocation. Add a
per-device Return preference. Preserve nonterminal retry errors in the runtime
transcript projection instead of treating them as failed turns.
