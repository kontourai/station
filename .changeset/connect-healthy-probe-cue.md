---
"@kontourai/station-connect": minor
---

Connection health reports each completed probe: the coordinator's status carries `completedProbes`, and `useConnectionStatus` accepts `onHealthyProbe`, called once per probe that completes while connected, for both probed and managed-loopback endpoints. Station uses it to re-read an unreadable plugin list in the background instead of leaving plugin tabs unavailable until the page is reloaded.
