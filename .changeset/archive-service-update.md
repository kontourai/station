---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-shared': minor
---

Let a client check for and apply an update to a Station installed from a
prebuilt release archive. The update status reports the `archive` and
`archive-service` install kinds with the running and newest verified release,
and a launcher-run service's update progress (`ServiceUpdateProgress`), read
with `requestServiceUpdateProgress` or `useServiceUpdateProgressQuery`. The
shared package adds `prebuilt-archive` and `service-launcher-protocol`
subpaths for the archive and service-launcher facts the CLI and server share.
