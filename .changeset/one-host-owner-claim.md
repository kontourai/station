---
'@kontourai/station-shared': minor
'@kontourai/station-cli': patch
---

A Station home now has one atomic host-owner claim. `claimHostOwner` replaces
`claimDesktopSidecar` and refuses any other live Desktop sidecar or durable
service on the home under one registry lock, reaping provably stale sidecar
records and returning the winning owner. `station service install` and the
service supervisor refuse (the supervisor waits) while a live Desktop sidecar
holds the home, with a message naming the holder and the remedy.
`removeOwnedInstance` gains `removeWhenOwnerGone`.
