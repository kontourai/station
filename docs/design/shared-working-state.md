# Shared working-state protocol

> **Reading status: current domain protocol and recorded harness scope.**
> [SharedWorkingState](../../src-server/domain/shared-working-state.ts) owns
> convergence and revision facts; persistence is composed through the
> [room working-state adapter](../../src-server/services/orchestration/project-task-room-working-state.ts)
> and its worker. The harness descriptions below are not newly executed
> convergence, authorization, performance, or recovery results.

The protocol introduced in [archive#2889](https://github.com/kontourai/station-archive/issues/2889)
defines the pre-UI contract for a shared **text document**. This
is not the conversation log. [Project/Task room history](project-task-room-history.md)
describes the current durable room owner; [conversation state](conversation-state.md)
retains the broader channel-home design and its historical survey.

## Contract boundary

`SharedWorkingState` is a Station-owned, provider-neutral domain Module. Its
Interface accepts and returns versioned Station operations, snapshots, bounded
deltas, typed outcomes, and a provable revision. It has no transport, database,
editor, identity-directory, or permission-store dependency. Composition Adapters
may persist snapshots, send operations, resolve human/agent principals, and
obtain the current Project/Task grant; none of those choices change the
convergence Interface.

New operations and run snapshots use schema `2`. Peers must explicitly offer
v2 for resync; v1-only peers receive `unsupported_version`, with no implicit
downleveling. Already admitted v1 operations remain readable for duplicate
recognition and delayed delivery. Stored v1 snapshots and receipts retain their
original schema and identity until an accepted document mutation writes v2. Stable opaque
identities are `documentId`, `replicaId`, `actorId`, `operationId`, atom ID, and
the content-addressed `RevisionId`. An actor's `displayLabel` is attribution
only. Authorization keys on the server-resolved `actorId`, never a label.

Attribution may carry Project, Task, agent-session, run, proposed-change, and
correlation links. Those fields are purposefully absent from the convergence
digest, so observability cannot alter document truth.

## Scope and exclusions

Slice 1 is UTF-8 text/code only. It excludes binary assets, editor-rendered
rich text, generated files, directory trees, permission metadata, and files
that exceed the later persistence Adapter's explicitly configured size bound.
It does not implement a UI, filesystem synchronization, last-write-wins file
persistence, a vendor wire format, or a replicated conversation log. Presence,
cursor/follow state, typing, and selection are ephemeral transport signals and
MUST NOT enter the durable operation log, revision digest, snapshot, or delta.

## Ordering and outcomes

Each operation names causal parents. An insert also names a predecessor atom;
a delete names target atoms. If a required parent or atom is absent, the Module
returns `deferred`, retains the operation locally, and releases it once its
requirements become known. Before a live deferred write releases, the Module
checks the *then-current* server-derived grant again; a revoked actor or stale
epoch is removed with a named rejected release. An already known or already
deferred ID with the same canonical operation digest is `duplicate`; the same
ID with a different payload is `operation_equivocation` and fails closed.

`createSharedWorkingState()` composes distinct capabilities over one private
authority: UI/editor callers receive only `live`, while the persistence or
transport Adapter retains `recovery.replay()`/`recovery.reconcile()`. Recovery
replays already-admitted authoritative facts without consulting a later writer
epoch, so a grant change cannot erase history. If it unblocks live deferred
work without a current grant, that work remains explicitly pending and
restorable until `recovery.reconcile(currentGrant)` or a live write performs
the required current-grant check. The unified reconciliation seam always
drains ready trusted facts and never authorizes live work accidentally.
If an authoritative replay names the exact ID/digest of locally live-deferred
work, the entry is promoted to trusted and reconciled; a source delta such as
`[root, child]` therefore realizes its advertised revision on a recovering
peer. A live deferred rejection is not itself an operation; the Module drops
the affected replay history so a requester at the pre-settlement revision gets
a snapshot rather than a misleading delta that cannot convey the rejection.
This is an explicit replay-checkpoint barrier, not an array-index cleanup: it
remains correct when a bounded history ring has just shifted an older entry.
Only operations recorded after the new checkpoint may form a delta chain.
The live port is ECMAScript-private/closure-backed: it exposes neither a
recovery method nor the private convergence core at runtime. No production
caller composes this split yet: the room runtime and working-state worker
construct the live-only `SharedWorkingState` class directly, so the recovery
ports are exercised only by the domain tests.

Before all of those outcomes, the Module validates schema and shape, including
well-formed Unicode (lone surrogates fail closed) and self/future-self atom
references, checks the
document identity, then checks the current server-derived scope, allowed actor,
and authorization epoch. It fails closed with one of `malformed`,
`unsupported_version`, `wrong_document`, `unauthorized`, or `stale_writer`.
A revoked actor and an actor using an old epoch therefore cannot make a delayed
write become current simply because it carries a valid historical operation.

Concurrent inserts use a deterministic reference order: siblings after the
same predecessor atom are ordered by stable atom ID (`operationId:index`) with
an explicit UTF-16 code-unit comparator, never `localeCompare`; each
operation's characters form a predecessor chain. The v2 representation stores
one run per insert, splitting only where deletions change visibility. A deleted
range retains its insertion identity, scalar start, length and predecessor,
with `text: null`; adjacent deleted ranges from the same insertion merge.
Deleted text payloads are discarded, while every old scalar position remains
addressable for delayed inserts, deletes and retries. Text projection splits
runs at branch anchors and traverses iteratively, without expanding tombstone
ranges or depending on JavaScript call-stack depth. The implementation is an RGA-style reference algorithm; that is an
Implementation choice, not a third-party or Station public wire format. It was
chosen over OT because the contract requires offline permutations and replay
without a central transform sequence, and over importing a CRDT package because
the required Station envelope, authorization boundary, revision proof, and
harness must remain independently specified. A future mechanism must preserve
the interface and the harness proofs before it may replace the reference
implementation.

## Revision, resync, and compaction

The revision is a SHA-256 digest of a recursively canonicalized projection of
schema version, document ID, canonical runs/tombstone ranges, and known operation IDs
plus canonical operation digests and every deferred operation's ID, digest,
and admission class. Thus two replicas with identical visible text but
different admitted pending work have different revisions and cannot falsely
claim an empty resync.
It is therefore independent of arrival order and attribution labels. A snapshot
contains those runs, its revision, scope, operation-ID digest tombstones, and
deferred operations with their admission class. Its checkpoint is required to
equal its revision. Restore validates scalar types, unique IDs, atom
predecessor closure/acyclicity, atom-owner/known-operation consistency,
deferred consistency/bounds, and the recomputed revision before it is accepted.
Run positions must cover each insertion from zero without gaps or overlaps.
Restore checks predecessor closure and cycles over runs, so a deleted range
does not require per-character allocation. The v1 reader retains its original
atom-graph and revision validation.

`resync(afterRevision, maxOperations, offeredVersions)` returns an ordered
delta only when the exact predecessor remains in the configured bounded
in-memory replay window and the count fits `maxOperations`. A request cannot
widen the configured retention bound. Otherwise it returns a verified
snapshot; it never invents continuity across a compacted or unknown revision.
`compact()` drops replay payload history and coalesces adjacent ranges.
Canonical snapshots and revision hashes always use the same normalized runs,
so compaction never changes revision identity or convergence. Operation
identity/digest tombstones and pending causal work remain, so an old retry is
still a duplicate. These identities still grow with edits: this is bounded
document storage, not unlimited lifetime editing. The worker explicitly refuses
`document-full` before committing a snapshot that exceeds the shared 512 KiB
bound; the evidence step uses that same constant and admission measure.

Each save retains operation identity/digest metadata, about 180 B for a small
editor save. The per-document lifetime is therefore roughly 2.5–3k saves before
an explicit `document-full` error, depending on text, operation IDs and run
fragmentation. This is a storage estimate, not a measured editor throughput
guarantee. With runs, the 256 KiB visible-text and 768 KiB evidence-record limits
are reachable; the worker pre-check covers both as well as the 512 KiB snapshot
limit before committing.

Writes containing an insertion leave a 16 KiB deletion reserve in both snapshot
and evidence-record budgets. The worker also preserves the snapshot reserve for
diagnostic bulk seeds that skip evidence publication. A person can use that
headroom to delete inside a live run after even a one-character insertion is
refused: splitting the run and retaining the deletion's digest can increase
stored bytes despite reducing visible text. Deletions may spend the reserve;
it is finite, so arbitrarily fragmented bulk deletions or indefinitely repeated
deletion saves can still reach `document-full`. Refusal rolls back the entire
batch without leaving a publication pending. Ordinary saves coalesce an unclaimed candidate even when the Station-wide
evidence ledger is full. A requested immutable reference can still be refused
by that separate ledger cap (#4055).

Both retained replay and deferred admission are bounded configuration: replay
retention, deferred operation count, and deferred UTF-8 payload bytes have
safe defaults and fail closed with `deferred_limit_exceeded`; a response limit
cannot expand retained history.

## Stored documents and receipt compatibility

The v1 reader reconstructs the old writer's exact sorted atom snapshot and
`swsr-v1` revision, including deleted character values. Read, evidence import,
pending publication drain, and receipt verification do not upgrade it. On the
next accepted mutation the document writes runs with an `swsr-v2` revision.
Old operation IDs/digests and all atom positions survive that transition; the
existing SQLite tables and 512 KiB CHECK remain unchanged. Rejected writes do
not migrate stored bytes.

Receipt identity still hashes the full canonical snapshot. A receipt made
from v2 therefore has a new identity, while existing v1 receipts verify against
their original snapshot and retain their identity. New receipts may name old
receipts as parents. Neither old receipts nor their attestations are rewritten.
The pre-v2 binary at `03728690b3e` already has an exact snapshot-schema fence,
following the room v4/v5 pattern of rejecting an unsupported schema instead of
downleveling it. Its `SharedWorkingState.#restore` rejects schema 2 with
`shared working-state snapshot is malformed`. The working-state worker's
`load` catches that exception and returns unavailable; both `read` and `settle`
refuse, without constructing or persisting an empty replacement. The runtime
preserves unavailable and the document route returns HTTP 503 `Room unavailable`.
No additional room-history fence is needed for this format change. This
downgrade path was traced in source; running an older binary on a v2 home is
still a separate validation obligation. Rollback after a v2 write requires a
compatible reader or restoring a pre-upgrade home backup. Never remove the
snapshot row to make an older binary open it.
The checked-in `shared-working-state-v1.json` fixture was captured from the
actual v1 writer and evidence module on the pinned main base, rather than
synthesized by the new codec.

Task Review stores the original opaque revision and quote outside the document.
After a v1 plan is saved as v2, quote relocation uses the current text, without
interpreting the `swsr-v1` or `swsr-v2` prefix. A quote that still resolves stays
Open; the persisted thread retains its original revision and the projection
reports the current v2 revision. The Review document chip shows a compact
working revision (schema prefix plus eight digest characters), with the full
current revision in its title; the transition chip can span v1 and v2.

## Evidence and telemetry

`src-server/domain/__tests__/shared-working-state.test.ts` is the deterministic
adversarial harness. It runs two replicas through permutation, duplicate,
delayed dependency, cross-locale ordering, partition/reconnect, applying a
delta to a recovering replica, replay, bounded-delta fallback, compaction plus
deferred restore, revocation before release, operation mutation/equivocation,
malformed input/snapshot faults, and a large nested document. It asserts
byte-identical UTF-8 text and exact revision equality.
It also proves deferred-state revision/resync integrity, both live→trusted and
trusted→live dependency directions, separate recovery capability ownership,
lone-surrogate rejection, deferred count/byte limits, and 20k-atom restore.

The Module emits `station.shared_working_state.operations` with bounded
`operation` (`apply|resync|compact`) and outcome attributes. It records protocol
health without adding document contents, labels, identities, or correlation
values to telemetry.

The run-format regression uses a 12,000-character room seed through the real
worker and evidence bridge. The worker churn test isolates 2,000 insert/delete
operations from the unchanged Station-wide receipt cap, checks the persisted
snapshot bound, and reopens SQLite halfway through. Seeded randomized tests
compare compacted/restored delivery permutations with an independent
per-character RGA oracle, including concurrent edits to deleted anchors and
Unicode. These tests do not claim unlimited edit history or repair #4055.
