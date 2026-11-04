---
"@kontourai/station-shared": minor
"@kontourai/station-cli": patch
---

Terminals survive core server restarts and upgrades under the process supervisor: a shell keeps its process and every line of output across a handoff. Lifecycle journal events from a supervised core name the supervisor that owns the instance, so `station start --lifecycle-journal` (used by dogfood and the end-to-end suite) now runs under the supervisor too.
