---
"@kontourai/station-cli": patch
---

A supervised Station on a slow or busy host no longer counts its first boot as a crash. A core started while nothing serves (first boot, crash restart, rollback) now has 120 seconds to park instead of the 30 a handoff trial gets, and `--boot-park-timeout-ms` tunes it. A generation that misses its park or readiness deadline is logged by name (`generation 1 did not park within 120000ms (park deadline); ending it`) instead of only as a SIGTERM exit. Missed deadlines still count as failures, and the supervisor now also gives up after `maxFailures` failures in a row with no generation serving between them, so a core that never comes up stops even when long deadlines spread its failures past the failure window. `station build` gives `biome format` 120 seconds per Basis MCP app, scaled by `STATION_LIVENESS_SCALE`, and names the bound when it is exceeded.
