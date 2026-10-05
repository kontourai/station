# Delegation attempt claims (receiver request-claim slice)

Opt-in durable duplicate suppression for portable delegation creates. First
slice only: the receiver claim + lookup foundation. Not the sender ledger,
fences, cancel, UI, or retention protocol.

## Opt-in field

`POST /api/orchestration/delegations` accepts an optional `attemptId`
(closed charset, max 128 chars) on portable intents only. Without it,
the request does not opt into this claim protocol; ordinary authorization and
delegation rules still apply. With it:

- The attempt is forwarded to a peer receiver only if the receiver
  advertises the `delegationAttemptClaims` capability; otherwise the create
  is refused before anything is sent (`delegation_attempt_unsupported`).
- The executing receiver durably claims `(verified caller grant, attemptId)`
  BEFORE resolution, admission, or any provider effect, keyed by the
  unambiguous tuple of the middleware-verified delegation device id and the
  attempt id — never a body-supplied sender label.

## Lookup

`GET /api/orchestration/delegations/attempts/:attemptId`, served by the
actual executing receiver only, requires the CURRENT verified delegation
peer grant the claim is keyed by (same grant, live id match). Everyone else
is refused with no data. The grant is re-resolved AFTER the store read, so
a revocation landing mid-lookup is still refused; a store fault answers a
fixed 503 with no exception text. The projection is closed — state, the
reserved task reference, and (when accepted) the initial turn id. Never a
prompt, path, digest, transcript, or provider output. SDK:
`lookupDelegationAttempt`.

## State meanings

- `none` — no claim observed NOW. NOT permission to resend: a delayed
  original may still arrive.
- `preparing` — claimed; the requested initial turn is not yet durably
  evidenced. A started session alone is NOT acceptance.
- `accepted` — the one real execution: `taskId` plus the exact initial
  `turnId`. A lost acknowledgement resolves here without re-POSTing.
- `unresolved` — the invocation may have happened; completion unproven.
  Never a resend authorization. Reconcile via the reserved task reference
  against session/turn evidence.
- `refused` — clean pre-effect refusal, terminal; the key never executes.
  When the refusal had a closed code, the projection carries it as
  `refusalCode` (for example `execution_preparation_version_mismatch`).

A `project-portable-prepared` create (version-matched execution, see
[remote execution preparation](../design/remote-execution-preparation.md))
must carry an `attemptId`: its version check is a phase of the attempt, the
matched facts are bound with the admitted facts, and every preparation
refusal the receiver raises after claiming is recorded as the tombstone's
`refusalCode` (the bound preparation receipt is dropped on refusal).

Duplicates: same attempt + same validated intent joins (`pending` /
`exists` 409, never a second effect); changed intent under the same key
conflicts; unknown capacity refuses.

## Capacity and no-replay limits

Every accepted key — including terminal tombstones — is retained up to a
finite bound (1024 records); the next NEW claim at capacity is refused,
never evicted. Nothing in this slice replays, resends, or expires a claim:
`none`/`preparing`/`unresolved` never authorize a second POST, and a
production retention/expiry protocol with sender-visible semantics is still
required before capacity pressure becomes routine.

The public caller chain is the
[`delegation route`](../../src-server/routes/orchestration/orchestration.ts),
[`station-control delegation`](../../src-server/tools/station-control-delegation.ts),
and [`claim store`](../../src-server/services/orchestration/delegation-attempt-claim-store.ts).
The [SDK lookup](../../packages/sdk/src/client/delegations.ts) reads the receiver's
closed projection. These bounds are not an exactly-once provider-effect guarantee
or evidence that a real peer journey ran in this documentation review.
