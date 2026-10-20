---
'@kontourai/station-cli': patch
---

Environment-only product telemetry opt-in (`STATION_PRODUCT_TELEMETRY_ENABLED=true`, legacy `STATION_TELEMETRY_ENABLED=true`, or `STATION_TELEMETRY_TIER=full`) now supplies at most a Lite default, even with a disclosure receipt. Full delivery stops until the operator explicitly chooses Full in config and acknowledges the current disclosure in Settings. Lite sending is not implemented in this foundation. `station telemetry status` and Settings report the environment reason and migration guidance. Existing explicit stored choices still take precedence; DO_NOT_TRACK still forces Off.
