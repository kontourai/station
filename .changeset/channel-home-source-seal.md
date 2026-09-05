---
"@kontourai/station-core": patch
"@kontourai/station-contracts": minor
---

Add private source-room write sealing and bind Task execution to its exact room before provider startup. Keep dispatch admission durable through external claims, startup and final association, and prevent uncertain session creation from being retried without reconciliation. Introduce the dedicated home-transfer grant; public cloud handoff and target activation remain unavailable.
