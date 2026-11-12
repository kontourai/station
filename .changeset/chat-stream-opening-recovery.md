---
"@kontourai/station-sdk": patch
---

Recover live event streams when connection headers stall, settle cancellation even when a transport ignores abort, and restart the active reader while preserving its accepted replay cursor. The opening deadline ends at headers and does not limit a healthy stream's lifetime.
