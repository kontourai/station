---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

A send's delivery can be looked up by its idempotency key. Contracts add
`TurnDeliveryInspection` (`not-received`, `received`, `started`,
`indeterminate`, `expired`, `unknown`), an optional client key on send-turn
input and an optional `clientTurnId` on `turn.started`. The SDK adds
`getTurnDelivery(apiBase, conversationId, clientTurnId, { projectSlug? })`, a
read-only lookup; a Station without it answers `404`, surfaced as a refusal.
