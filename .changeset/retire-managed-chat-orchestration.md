---
"@kontourai/station-contracts": minor
---

Remove the inert `AppConfig.managedChatOrchestration` field. `GET /config/app`
no longer injects it, and `STATION_FEATURES=managed-chat-orchestration` no
longer has any effect; managed chat has run through orchestration
unconditionally since ADR 0014. Add `RETIRED_APP_CONFIG_KEYS`, which the server
uses to drop the key from config files written by earlier releases.
`PUT /config/app` now reports the key as `unknown` instead of
`runtime-derived`.
