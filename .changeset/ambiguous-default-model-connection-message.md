---
"@kontourai/station-contracts": minor
---

Add `AMBIGUOUS_DEFAULT_MODEL_CONNECTION_MESSAGE` and `AMBIGUOUS_AGENT_MODEL_CONNECTION_MESSAGE` to `@kontourai/station-contracts/managed-model-binding`: the two sentences the server refuses a turn with when more than one model connection is enabled and nothing names which one to use (the provider service's, and an unbound agent's). The server throws them and clients that recognise the refusal match them, so the two cannot drift apart. The sentences themselves are unchanged.
