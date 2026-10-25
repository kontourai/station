---
"@kontourai/station-cli": minor
---

`station start` and `station service run` run the core server under the Station process supervisor, and the instance record names the supervisor as the owner. `station restart` hands a running instance to a new core generation in place, `station stop` drains it through the supervisor's control channel, and `station supervisor status` shows what the supervisor reports. `STATION_DIRECT_LAUNCH=1` keeps the direct start.
