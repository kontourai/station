# Delegation attempt claims

Opt-in durable duplicate suppression for portable delegation creates. Only the
receiver side exists: the request claim and its lookup. There is no sender
ledger, fence, cancel, UI or retention protocol yet.

All delegation creates require `clientTurnId`. The separate
[CreateRequestClaims owner](../../src-server/services/orchestration/create-request-claims.ts)
binds authenticated user/tenant/principal and verified calling Session to the
request kind, key and input. The receiver's earlier portable-attempt claim also
binds a required inherited tool policy. Reusing an attempt with added or changed
`toolAllowlistConstraints` conflicts before the existing attempt can be named;
unchanged policy still identifies the original attempt. These digests establish
request identity, not authority. Each intended request needs a unique key.
Completed receipts replay for seven days of elapsed host uptime, then expire. Wall-clock
jumps do not change that duration; uptime resets conservatively preserve the
remaining window. Dead unmarked requests reclaim immediately, including changed
input and resumed Sessions; live, unknown or marked owners still refuse changed input. A starting mark without confirmed
acceptance is indeterminate within its seven-day window. At expiry, the same key
can reclaim only when no durable Session start record exists. Otherwise a compact
tombstone keeps refusing it with its original Session reference.

Tombstones are pruned oldest first only under admission capacity pressure; they
count toward the 1,024-record and 4 MiB bounds. If pruning cannot make room, a typed
HTTP 429 starts nothing. A pruned key loses protection, so neither absence nor
expiry authorizes automatic retry. Inspect the original Session before any
deliberate separate new request, which may duplicate existing work. The
[API reference](../reference/api.md) owns the precise starting/refusal rules,
3 KiB pending receipt reservation and clock limits. It preserves the peer
identity, lookup authority and opt-in `attemptId` protocol below. The SDK uses an
existing `attemptId` as its default key; retain it with the original input.

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
peer grant the claim is keyed by (same grant, live id match). Callers without
a current qualifying delegation-peer grant are refused with no data. A different
valid peer grant reads only its own `(grant, attemptId)` namespace; when it has
no matching claim, the response is `none`, without disclosing another grant's
claim. The grant is re-resolved AFTER the store read, so
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
matched facts are bound with the admitted facts, and a preparation refusal
after claiming is recorded as the tombstone's `refusalCode` when that state
transition succeeds (the bound preparation receipt is dropped on refusal).
If recording a refusal or unresolved outcome fails, the claim remains at its
earlier durable state; that state still suppresses another invocation and never
authorizes resend.

Duplicates: same attempt + same validated intent joins (`pending` /
`exists` 409, never a second effect); changed intent under the same key
conflicts; unknown capacity refuses.

## Capacity and no-replay limits

Every accepted key — including terminal tombstones — is retained up to a
finite bound (1024 records); the next NEW claim at capacity is refused,
never evicted. Nothing replays, resends, or expires a claim:
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
