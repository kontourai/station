# Delegation attempt claims (receiver request-claim slice)

Opt-in exactly-once-ish protection for portable delegation creates. First
slice only: the receiver claim + lookup foundation. Not the sender ledger,
fences, cancel, UI, or retention protocol.

## Opt-in field

`POST /api/orchestration/delegations` accepts an optional `attemptId`
(closed charset, max 128 chars) on portable intents only. Without it,
behavior is byte-identical to before. With it:

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
is refused with no data. The projection is closed — state, the reserved
task reference, and (when accepted) the initial turn id. Never a prompt,
path, digest, transcript, or provider output. SDK: `lookupDelegationAttempt`.

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
