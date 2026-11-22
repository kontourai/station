---
"@kontourai/station-contracts": minor
---

Add `AMBIGUOUS_DEFAULT_MODEL_CONNECTION_MESSAGE` to `@kontourai/station-contracts/managed-model-binding`: the sentence the server refuses a turn with when more than one model connection is enabled and none is the default. The server throws it and clients that recognise the refusal match it, so the two cannot drift apart.
