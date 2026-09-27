---
'@kontourai/station-shared': patch
'@kontourai/station-cli': patch
---

Run every Windows current-user ACL command through one shared runner with one
120-second budget, sized for a cold or saturated host. The server's local-grant
secret used 30 seconds and timed out on a loaded Windows runner; the CLI's profile
store and triage storage had no bound at all. `station start` now fails as soon
as the server process exits during startup instead of waiting out its readiness
deadline.
