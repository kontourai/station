# Shared working-state protocol

Issue archive#2889 defines the pre-UI contract for a shared **text document**. This
is not the channel conversation log: `docs/design/conversation-state.md`
remains the authority for conversation messages, moderation, and their
single-home sequencing.

## Contract boundary

`SharedWorkingState` is a Station-owned, provider-neutral domain Module. Its
Interface accepts and returns versioned Station operations, snapshots, bounded
deltas, typed outcomes, and a provable revision. It has no transport, database,
editor, identity-directory, or permission-store dependency. A later Adapter
may persist snapshots, send operations, resolve human/agent principals, and
obtain the current Project/Task grant; none of those choices change the
convergence Interface.

The current schema is `1`. Peers explicitly offer versions and select v1, or
receive `unsupported_version`; there is no implicit downleveling. Stable opaque
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
recovery method nor the private convergence core at runtime.

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
operation's characters form a predecessor chain. Deletes mark atoms as
tombstones. Text projection is iterative, so a deeply nested document does not
depend on the JavaScript call-stack depth. The implementation is an RGA-style reference algorithm; that is an
Implementation choice, not a third-party or Station public wire format. It was
chosen over OT because the contract requires offline permutations and replay
without a central transform sequence, and over importing a CRDT package because
the required Station envelope, authorization boundary, revision proof, and
harness must remain independently specified. A future mechanism must preserve
the interface and the harness proofs before it may replace the reference
implementation.

## Revision, resync, and compaction

The revision is a SHA-256 digest of a recursively canonicalized projection of
schema version, document ID, atom graph/tombstones, and known operation IDs
plus canonical operation digests and every deferred operation's ID, digest,
and admission class. Thus two replicas with identical visible text but
different admitted pending work have different revisions and cannot falsely
claim an empty resync.
It is therefore independent of arrival order and attribution labels. A snapshot
contains that graph, its revision, scope, operation-ID digest tombstones, and
deferred operations with their admission class. Its checkpoint is required to
equal its revision. Restore validates scalar types, unique IDs, atom
predecessor closure/acyclicity, atom-owner/known-operation consistency,
deferred consistency/bounds, and the recomputed revision before it is accepted.
Predecessor closure and cycle validation uses a linear color traversal, not a
per-atom path walk.

`resync(afterRevision, maxOperations, offeredVersions)` returns an ordered
delta only when the exact predecessor remains in the configured bounded
in-memory replay window and the count fits `maxOperations`. A request cannot
widen the configured retention bound. Otherwise it returns a verified
snapshot; it never invents continuity across a compacted or unknown revision.
`compact()` removes only replay payload history. It retains the atom graph and
operation identity/digest tombstones, and includes pending causal work in the
returned snapshot, so the resulting revision remains provable and an old retry
remains a duplicate rather than new work.

Both retained replay and deferred admission are bounded configuration: replay
retention, deferred operation count, and deferred UTF-8 payload bytes have
safe defaults and fail closed with `deferred_limit_exceeded`; a response limit
cannot expand retained history.

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
`shared-working-state-benchmark.test.ts` is a small 100-operation fixture that
reports the apply duration and serialized snapshot/delta byte sizes without a
host-dependent pass/fail time ceiling.

The Module emits `station.shared_working_state.operations` with bounded
`operation` (`apply|resync|compact`) and outcome attributes. It records protocol
health without adding document contents, labels, identities, or correlation
values to telemetry.
