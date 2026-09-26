---
"@kontourai/station-cli": patch
---

`station registry` no longer fails with "Registry install aliases are unavailable" once a registry plugin has been installed, and no longer guesses installed state from local files. The running Station owns installed state; `station registry plugins list` reports it.
