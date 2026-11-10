---
"@kontourai/station-cli": minor
---

Remove the `--features=<flags>` option from `start`, `dev`, `service install` and `service run`. It only set `STATION_FEATURES`, whose last flag, `strands-runtime`, Station no longer reads: the persisted `runtime` setting is the only runtime selector (`station config set runtime strands`, then restart). The option is refused with that instruction rather than ignored. A service installed with `--features` does not start until it is reinstalled without it; `station service status` names the option, the `config set` command that keeps Strands, and the reinstall command.
