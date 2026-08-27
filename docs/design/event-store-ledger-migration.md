# EventStore ledger migration order

Completed behavioural ledger extractions are `TurnDeduplicator`,
`AdoptionLedger`, and `RecoveryLedger`. RecoveryLedger composes the private
credential-application factory/handle protocol for exact evidence. Each owns
the caller family named here; this is not a claim that every EventStore method
has moved or that retained persistence details are a new caller Interface.

`CommandReceiptLedger`, `DeliveryCheckpoint`, and the broader `SessionJournal`
are retained internal boundaries, not pending wrappers. They need a
deletion-complete caller family before any new Module is justified.

The contributor-facing Interface, composition, and test map is [Module
map](../architecture/module-map.md). This document records ledger disposition
rather than creating a second Interface reference.

| Area | Disposition | Why it stays this way |
| --- | --- | --- |
| TurnDeduplicator | Completed | One opaque owner capability owns `(threadId, clientTurnId)` settlement across restart and contention. |
| AdoptionLedger | Completed | Reservation, ownership, legal transitions, and atomic commit moved out of EventStore forwarding methods. |
| RecoveryLedger | Completed | Recovery arm/claim/terminal/compensation and startup reconciliation are one intent-shaped Interface. |
| CredentialApplicationFactory/Handle | Completed, private | Exact stage/settle/ack evidence is composed with RecoveryLedger; raw attempt identities do not become a caller Interface. |
| NativeInvocationRuns and VoiceTurnRuns | Completed, private | Direct `/invoke*` provider calls use a pre-effect claim; provider-correlated voice starts are already observed possible effects. EventStore composes both authorities and RunService reads only canonical `invoke:*` and `voice:*` projections. |
| `/chat` turn dedup | Retained internal facade | Direct `/api/agents/:slug/chat` owns conversation-id replay and a bounded 2,000-row compatibility family over the same SQLite primitive. It is not a second TurnDeduplicator caller family or a generic ledger candidate. |
| Command receipts | Retained internal | Adoption commit still couples receipt persistence atomically with child and Flow facts. A CRUD extraction would split that truth. |
| Delivery checkpoints | Retained internal | One narrow caller owns monotonic checkpoint advance; a new Seam would add surface without variation. |
| Session journal | Deferred | Its caller family and retention/query semantics are broader than a bounded ledger slice. |

## RecoveryLedger

The RecoveryLedger Interface owns arm, immutable projection, due/profile claim,
provider observation, startup reconciliation, terminal outcomes, cancellation,
and compensation. `arm` is idempotent by fingerprint: a collision returns the
original durable intent rather than merging caller input. Snapshots are frozen
and redact dispatch attempt and correlation credentials. A claim is a
claim-local capability: it can release only before invocation, accept provider
evidence once, or become indeterminate; changed transition intent is invalid
and an exact durable retry is idempotent.

Legal transitions are `armed|manual -> resumed/prepared`, then either
`armed|manual` (pre-invocation release), `resumed/accepted`, or
`indeterminate`. Only an accepted attempt can terminally succeed. Every durable
compare-and-set reports `applied`, `stale`, `invalid`, or `unavailable`; callers
must never project success or cleanup completion without `applied`. A thrown or
ambiguous SQLite operation is `unavailable`, so the caller retains its opaque
capability for the exact retry rather than guessing durability.

Bulk `reconcilePrepared` is startup-only: it first rejects a prepared row with
a live durable owner fence, then atomically changes only an abandoned
owner/attempt/correlation tuple and returns its exact winners. Live profile
completion is restricted to the original process-local claim capability; a
reconstructed process has no claim and waits for startup reconciliation to
conservatively make uncertainty compensable. SQLite uses indexed due-time reads
and guarded compare-and-set updates, preserving due ordering (`due_at`, then
creation) while keeping transaction coordination and owner-liveness checks
inside the Implementation.

Ownership pairs an owner UUID with the shared process-identity birth
fingerprint. A matching live PID is retained; a dead PID or mismatched birth is
reclaimable; an unavailable identity probe fails closed. A terminal operation
which observes a post-write SQLite fault reads back only its exact desired fact,
so an identical durable write is idempotently applied rather than falsely
reported as unavailable.

Credential-profile application truth belongs to the private
CredentialApplicationFactory/Handle composed at the EventStore/connection
Seam, not to a public configuration projection or the recovery transition
table. The RecoveryClaim passes its claim-local opaque key to private
CredentialProfileRecoveryAdapter.stage; ConnectionService then calls Factory.start
and returns an opaque Handle before profile effects. That application
then moves in place through `staged`, `adopted`, `rolled-back`, `superseded`,
or `indeterminate`, so a successfully staged attempt can terminalize even at
capacity. Normal projections and `/api/config/app` do not expose receipt or
pending-attempt identity. Recovery acknowledges only after its own terminal
compare-and-set is durable; acknowledgement failure keeps exact evidence for
retry. Evidence is independent of profile membership, so deleting an old
profile cannot erase restart facts. Linked prepared, accepted, and
terminal-awaiting-ack rows always use their exact receipt path. Legacy prepared
rows without a key are terminally quarantined; they never authorize broad
rollback against a possible successor.
