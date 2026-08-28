# Design: revision-bound evidence

> Status: implemented contract for [#2891](https://github.com/kontourai/station/issues/2891).

## Purpose

`RevisionEvidenceModule` turns a settled, durable `SharedWorkingState` snapshot
into an immutable Station revision receipt. It is neither a filesystem adapter
nor a second synchronization mechanism. It restores untrusted input through
the #2889 contract, rejects retained deferred causal work as `pending_state`,
then reconstructs a canonical `restored.snapshot()` before it hashes or
retains anything. A valid but differently ordered input snapshot therefore
creates the same receipt identity.

The caller cannot assert immutable attribution. A required injected
`RevisionAttributionAuthority` first receives the reconstructed scope, shared
revision, and opaque request ID, then returns the server-owned actor and
Session/run/proposed-change correlation. The Module independently derives its
canonical identity payload and deterministic revision ID; only then does the
authority issue a bounded opaque portable attestation that binds that exact ID,
parents, scope/shared revision, actor/correlation, and canonical payload. An
unavailable, malformed, or scope-mismatched authority result rejects freeze;
caller actor/correlation fields are ignored. The attestation is retained and
exported but deliberately does not enter the revision identity, so distinct
valid authority tokens cannot change an otherwise identical receipt ID. Unknown fields—
including local paths—are neither hashed nor exported. The
`revision-evidence-v1:<sha256>` identity binds the canonical snapshot and
Station attribution, while its embedded #2889 shared revision is the content
witness. The interface bounds identifiers, labels, text,
attestations, snapshots, records, import entry count, and total import bytes
before durable admission.

## States and ownership

The public state distinguishes `live_buffer`, `locally_pending`,
`committed_revision`, and a canonical `proposed_change` status. Live and
pending buffers are never evidence. A committed child must name parents from
the exact same Project, Task, and document scope.

This module has no proposed-change decision lifecycle. `ProposedChangeService`
owns the canonical `pending`, `approved`, `rejected`, and `superseded` states
and decision provenance. The Module receives a narrow injected lookup seam and
on each resolution verifies the current canonical record. An available diff
requires exact Project/Task/document scope, transitive `before → after`
ancestry, both authority-derived correlations naming the exact change and its
canonical Session (plus a canonical run when supplied), and exact text against
the canonical base/proposed snapshot semantics. Create's null base and delete's
null proposed snapshot mean empty text; modify/rename require exact content.
Approved decision provenance, including its bounded reason and supplied
snapshots/hashes, is returned without giving this module hash semantics. The
lookup first requires the cheap canonical decision shape (zero decisions while
pending, exactly one while decided) before it validates the full contract.
Pending is `UNVERIFIED` and rejected/superseded is `UNAVAILABLE`; this module
cannot fabricate approval.

The Module likewise owns no Surface evidence, Flow gate, Survey review, or
Veritas semantics. Its immutable evidence/gate input reference resolves only
as `AVAILABLE`, `UNAVAILABLE`, or `UNVERIFIED`; consuming primitives decide
what those states mean in their own domain.

## Portable recovery

`exportPortable()` returns defensively cloned, locale-independent canonical
order. `importPortable()` rejects excessive entry count before any size walk,
then accounts exactly for portable JSON bytes (escaped strings, keys,
punctuation, and scalars) with a cycle-safe streaming traversal. Strings are
accounted incrementally by JSON code unit/UTF-8 escape rules (including control
escapes and lone surrogates), and every nested value receives only its
parent's remaining byte budget after delimiters and keys, stopping without
allocating a serialized whole string. Array and object limits are checked before
element/property walks; sparse array holes are counted as JSON `null`, and
malformed/proxy faults reject rather than throw.
It rederives every record identity from its reconstructed #2889
snapshot, validates parent closure and exact scope, and commits only a complete
batch. It also asks a compatible authority to verify each opaque attestation
against the exported revision ID, parents, scope/shared revision,
actor/correlation, and canonical identity payload. An importer
without that authority, or with an invalid attestation, returns
`attribution_unverified`; a recomputed public digest does not authenticate
attribution. Malformed/tampered data, retained pending state, missing parents,
scope mismatch, identity collision, and capacity exhaustion fail closed with
named outcomes. No local filesystem path is required to verify an imported
receipt, but a compatible authority is required to trust its attribution.

The default retained capacity is 256 receipts. `EventStore` composes the
private SQLite receipt adapter over its existing orchestration database; it
never adds an NDJSON log or a second database. Freeze and portable import use
one SQLite `BEGIN IMMEDIATE` batch with exact durable readback. Before any
write, the Module bounded-restores and authority-validates the current ledger;
the Adapter then recomputes the same count/aggregate/digest witness inside the
write transaction and refuses a stale witness. It revalidates every retained
row under that lock before checking resulting receipt count, each record's
bytes, and the exact escaped JSON bytes of the whole portable envelope. A
successful write can therefore always fit the bounded restore contract and
cannot extend a corrupt or authority-incompatible ledger. Restore SQL rejects
oversized/exact-length-invalid receipt IDs, scope IDs, digests, and record JSON
before materializing payloads and reads at most 32 rows per page, then passes
the complete bounded set through the same portable validator for schema,
digest, settled-state, topology, scope, and compatible authority attestation.
Corrupt/unavailable recovery is explicit (`revision_unavailable`), never an
empty healthy ledger. Capacity is the retention policy: it rejects new receipts
without pruning an active room/history reference. There is no time-based
expiry in this slice. A lost post-commit response and a peer witness race each
receive one bounded restore/retry; the retry's exact inserted count determines
`duplicate` versus `imported`. A live peer miss refreshes from SQLite before
returning.

`reader().resolve({ scope, revisionId })` is the later room/SDK seam. It
projects text, parents, actor, and correlation only after exact scope matching;
canonical snapshots, opaque attestations, storage metadata, and local paths
remain server-only. `EventStore.close()` fences and clears every Module it
created before closing SQLite, so retained readers cannot serve cached content.
EventStore registers the Module before its first callback-bearing restore. A
lifecycle generation is captured around every attribution verify/attest,
canonical proposed-change lookup, durable persist, and cache admission; close
increments the generation, and every callback return plus every cache mutation
or available/duplicate/imported return rechecks it. A reentrant close after
COMMIT therefore returns unavailable and leaves no cache, while the durable row
remains honestly recoverable by a new EventStore instance.
Corrupt, unavailable, and closed storage is explicit through revision lookup,
portable export, proposed-change resolution, evidence/gate resolution, and the
room reader. `station.revision_evidence.outcomes` records bounded freeze,
persist, restore, resolution, import, and canonical proposed-change outcomes.
