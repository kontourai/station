---
'@kontourai/station-sdk': minor
---

`DelegatedTaskEvent` usage entries now carry the remaining canonical
`token-usage.updated` fields (#225): `cacheWriteTokens5m`,
`cacheWriteTokens1h`, `serviceTier` (opaque provider text, at most 64
characters), `contextTokens` and `contextWindowTokens`. Each is present only
when the engine reported it.
