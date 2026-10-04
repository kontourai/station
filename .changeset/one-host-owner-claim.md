---
'@kontourai/station-shared': minor
'@kontourai/station-cli': patch
---

Desktop sidecars and installed services now share one atomic host-owner claim. `claimHostOwner` replaces
`claimDesktopSidecar` and refuses any other live Desktop sidecar or durable
service on the home under one registry lock, reaping provably stale sidecar
records and returning the winning owner. `station service install` reserves the home and records policy before backend
startup, restoring the prior entry on backend failure. The service supervisor
refuses missing policy or a live conflicting owner with a readable remedy,
and stops Station if readiness publication fails. It takes the installer's
reservation before starting Station. Desktop publishes its spawned child's
PID/birth before Listening, retaining the fence while a live orphan shuts down.
Direct server entrypoints remain unfenced; bare container `service run` now
refuses missing policy and needs an explicit policy-registration lifecycle.
`removeOwnedInstance` gains `removeWhenOwnerGone`.
