---
"@kontourai/station-core": patch
---

Retain private Task creation identity and admitted declaration provenance for immutable outputs while preserving the public v1 shape. New snapshots promote the private index to v2; legacy rows remain readable with unknown provenance, and older binaries require an explicit downgrade migration. Preserve legacy deletion barriers and recheck Task absence before cascade cleanup.
