---
'@kontourai/station-contracts': minor
---

An automation's turn that a person stopped now reads `stopped` instead
of `failed`: `AutomationActionIntent.state` and `AUTOMATION_DELIVERY_OUTCOMES`
(and the semantic-dedupe subset) add `stopped`. The wall budget, an
engine failure, a restart, a revocation and a Stop sent by an Agent still
read `failed`. `SessionStopSettledEvent` adds an optional `byPerson: true`,
set when the Stop passes Station's person check (an operator credential
or a person's paired device; never a delegation-kind device or a request an
Agent may have made).
Clients that list deliveries without validating the outcome, as the SDK
does, show the new value unchanged.
