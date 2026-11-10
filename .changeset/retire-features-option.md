---
"@kontourai/station-cli": minor
---

The server no longer reads `STATION_FEATURES`, and the CLI's `--features` option is removed. The persisted `runtime` setting is the only runtime selector: `station config set runtime strands`, then restart. `--features=strands-runtime` and `STATION_FEATURES=strands-runtime` are refused with that instruction instead of silently starting VoltAgent. A service installed with `--features=strands-runtime` must be reinstalled without it.
