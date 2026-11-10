---
"@kontourai/station-cli": minor
---

The Station server no longer reads `STATION_FEATURES`; the persisted `runtime` setting is the only runtime selector (`station config set runtime strands`, then restart). The CLI's `--features=<flags>` option, which only set that variable, is removed from `start`, `dev`, `service install`, `service run` and `setup local`. A `--features=<list>` naming `strands-runtime`, or a `STATION_FEATURES` value naming it when Station starts, is refused with that instruction rather than ignored, so it cannot silently start Station on VoltAgent; other values are ignored by `start` and `service`, and `dev` and `setup local` reject `--features` as an unknown option. A service installed with `--features=strands-runtime` does not start until it is reinstalled without it.
