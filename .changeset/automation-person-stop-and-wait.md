---
'@kontourai/station-contracts': minor
---

An automation's turn that a person stopped now reads `interrupted` instead
of `failed`: `AutomationActionIntent.state` and `AUTOMATION_DELIVERY_OUTCOMES`
(and the semantic-dedupe subset) add `interrupted`. The wall budget, an
engine failure, a restart, a revocation and a Stop sent by an Agent still
read `failed`. `SessionStopSettledEvent` adds an optional `byPerson: true`,
set when the Stop command came from an operator or paired-device client.
Clients that list deliveries without validating the outcome, as the SDK
does, show the new value unchanged.
