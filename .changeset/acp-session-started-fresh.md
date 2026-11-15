---
"@kontourai/station-contracts": minor
---

Add `ACP_SESSION_STARTED_FRESH_CODE` (`acp.session-started-fresh`), the `runtime.warning` code an ACP session publishes when the engine could not reload the conversation it was asked to resume and Station started a new engine session in its place, and the optional `ProviderSession.engineContextStartedFresh` that a start returns in that case so orchestration delivers the conversation's first-turn context again.
