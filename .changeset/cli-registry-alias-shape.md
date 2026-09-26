---
"@kontourai/station-cli": patch
---

`station registry` no longer fails with "Registry install aliases are unavailable" after a registry install. It now reads the alias records the server writes (`pluginName` with its registry ownership) and marks those plugins `[installed]`.
