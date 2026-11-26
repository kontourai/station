---
status: current
subject: Release-candidate archive identity and producer provenance
decided: 2026-11-15
evidence:
  - kind: adr
    ref: docs/adr/0020-distribution-two-trains-channels-as-pointers.md
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4929
  - kind: doc
    ref: docs/guides/release-rings.md
---

# Release-candidate archive identity and producer provenance

The owner decision on #4929 replaces the separate Beta release channel with
Stable release candidates. RC and final tags carry the same product version
and runtime identity; promotion must retain the candidate's archive bytes.
Nightly keeps its separate identity and version sequence.

This amends ADR 0020 D1's deferred promotion prerequisite for the RC-to-Stable
path. The frozen ADR remains historical. It does not merge Nightly's trust
boundary, home or launcher into Stable.

New Stable packaged archive provenance is schema 3: source SHA, product version,
creation timestamp, runtime channel, release channel and prerelease policy.
It contains no origin tag. Nightly producers retain schema 2 because deployed
Nightly installers must be able to verify their next update. `vX.Y.Z-rc.N` and `vX.Y.Z` both produce Stable
`X.Y.Z` provenance. Consumers bind this identity to an authenticated manifest's
SHA, version and channel. Legacy schema 2 archives retain their exact-tag
validation; they do not acquire cross-tag promotion authority.

A product version does not prove producer provenance. GitHub attestation
verification still binds an asset to its actual producing workflow, source tag
and SHA. Publishing the same bytes at a final release therefore needs a
separate, verified producer-to-publication binding; changing a destination tag
must never rewrite or pretend to reproduce an attestation.

Protected publication separately authenticates the producer-to-publication
receipt, unchanged asset inventory and original source attestations before
promoting stores, feeds or pointers. RC publication skips Stable rolling
authorities. Runtime, signing-key and setup admission reject retired Beta
identities; read-only legacy metadata never grants an active surface. The
current operator procedure and recovery limits live in the release guides.

Executable fixture checks cover archive and installer identity/refusal paths.
Real platform packaging, installations, provider processing and the complete
release rehearsal require their own receipts.
