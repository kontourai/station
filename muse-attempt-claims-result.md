# Attempt claims (#485) — slice result log

Lane: `feat/project-attempt-claims-485-20260921`. First-slice scope only:
receiver claim + lookup foundation. NOT waived: full sender
ActionOperation/cancel/fence/UI/retention work, sender ledger.

## Prior turn (root-reviewed 1e6a2dde1; direction accepted)

F1–F4 blocking corrections, committed at `1e6a2dde1` (prior turn report;
this turn re-observed the focused counts below, all else as reported):

- F1 (sentinel): `readLedger` uses a unique missing-file sentinel; present
  `null`/`false`/`0`/`""` fails closed as malformed, file left
  byte-identical. State-dependent validation (admitted facts for admitted+,
  real turn id for accepted, tuple-key/identity match). Store v1→v2.
- F2 (owner capability): 256-bit secret, SHA-256 verifier persisted,
  `timingSafeEqual` on every transition incl. across store instances.
  Wrong/random/empty/other-claim tokens → not-owner, zero mutation.
- F3 (tuple key): length-prefixed `delegationAttemptClaimKey` at
  reserve/existing/lookup; colon-tuple collision tests green.
- F4 (acceptance): `session-started` vs `accepted` split; stable
  `initialClientTurnId` on the one dispatch; accept only on the real
  returned turn id; lost ACK resolves to exact task+turn via lookup/409.
- Plus SDK/contracts changesets and `docs/guides/delegation-attempt-claims.md`
  (kept from 1e6; unchanged this turn).

Prior focused (as reported): 80/80 (store 44, caller 18, route 18).
Pre-existing red (root-owned, untouched): 3 FAILs in
`orchestration.routes.test.ts` (continue/respond), parent-lane red.

## This turn: two-Station live qualification (commit 2e70b51a9 + 7b0b6de39)

Source: `tests/portable-receiver-live-proof.spec.ts` (15 tests: 10 existing
preserved byte-identical in behavior, 5 new attempt-claim cases), real
enrolled peer + receiver-only offer + real free muse echo + strict JSON argv
launch oracle (`argv[0]=='exec'`, malformed record fails, never skipped).

New live proofs (all through the controller's real peer forward unless noted):

1. Opt-in create with `attemptId` reaches the actual receiver (1 new muse
   exec in the receiver execution root carrying the turn token); authorized
   lookup (SAME receiver peer credential) returns `accepted` with the ACTUAL
   task AND real initial turn; turnId ≠ taskId and ∈ receiver
   `turn.started` evidence (session creation distinguished from turn
   acceptance); second lookup resolves identically with no re-POST and no
   new launch.
2. Redelivered identical attempt → 409 `delegation_attempt_exists` naming the
   exact taskId+turnId, launch delta 0.
3. Three concurrent identical attempts → exactly one 200, rest 409
   (pending/exists), launch delta exactly 1 after a 15 s straggler window,
   lookup names the winner's task.
4. Same key + different prompt → 409 `delegation_attempt_conflict` with NO
   taskId/turnId, launch delta 0, original accepted claim untouched.
5. Operator lookup → 403 `delegation_attempt_caller_unsupported`, no data. A
   second live delegation grant looks up `none` (no cross-grant disclosure);
   after revoking it, lookup → 401 with no data, and a create over the
   revoked grant → 401 with no provider effect.

Controller-side lookup is NOT implemented (controller serves only its local
claim store): lookups address the receiver directly with the same peer
credential in this Node-side protocol test only — never a browser/operator
credential. Frontend/controller tracking of the projection is next-slice work.
First-slice support does NOT include a sender ledger.

### Commands (exact) and outcomes

- `npm run typecheck:e2e` → PASS (exit 0), before and after the spec edit.
- `node scripts/test-fixture-policy.mjs` → PASS (0 legacy sites), before and
  after.
- `npx biome check tests/portable-receiver-live-proof.spec.ts
  scripts/ui-bundle-budget.json` → clean (one `--write` formatting pass on
  the spec).
- Canonical runner, short-TMPDIR prerequisite:
  `TMPDIR=/tmp/e2e-tmp TMP=/tmp/e2e-tmp TEMP=/tmp/e2e-tmp
  PORTABLE_PROOF_ARTIFACT_DIR=/tmp/attempt-claims-proof-artifacts
  node scripts/run-e2e-suite.mjs --suite=smoke-live
  --spec=tests/portable-receiver-live-proof.spec.ts` → **15 passed
  (56.1s)**, exit 0. Suite Station on 3702/5734 (jittered; 55838 never
  touched), `✓ Stopped`.
- Canonical focused suite `npm run test:focused -- <store, caller, route
  attempt tests>` → **80 passed (80)**, exit 0. Re-observed this turn.
- `npm run build:ui` → green after the attributed raise below (336858,
  deterministic across rebuilds).

### Reds met and diagnosed (retained honestly, not run-to-green)

- Long sandbox TMPDIR broke tsx IPC (`listen EINVAL` on a >100-char pipe
  path) at runner startup. Fixed by short TMPDIR (`/tmp/e2e-tmp`) —
  environment prerequisite, not product code.
- UI bundle gate: entry JS 336858 vs 336857 ceiling (+1). Two-build
  attribution in-tree with one node_modules: `c5a4cf2bc` builds 336849,
  HEAD builds 336858 (+9, deterministic). Only UI-graph runtime addition in
  range is this lane's public SDK `lookupDelegationAttempt` client riding
  the already-eager delegations module (UI uses its delegation clients at
  runtime; no waste, no lazy-load candidate; all other diffs are
  types/comments). Ceiling raised to 336858 in `7b0b6de39` with the number
  and attribution in the commit message, per the gate's own process. Root
  reviews before gates.
- `orchestration.routes.test.ts` 3 FAILs (continue/respond): pre-existing
  parent-lane red per prior turn; untouched, not re-run here (no broad
  regression per instructions).

### Cleanup and artifacts

- Runner + spec `afterAll`: suite Station `✓ Stopped`; 3702/5734 probed
  closed; fixture homes removed on green (owned listeners stopped, no
  orphans; 55838 never allocated or signaled).
- `/tmp/attempt-claims-proof-artifacts/` empty (evidence preserved only on
  failure). Known useful paths on failure:
  `PORTABLE_PROOF_ARTIFACT_DIR/<instance>-<ts>/{controller,receiver,muse-launch-observations}.log`
  + `run-meta.json`.
- Commits this turn: `2e70b51a9` (spec only, +507), `7b0b6de39` (budget
  JSON 1-line). No push/PR/merge, no other-tree edits, no stash/reset/rebase.

### NOT_VERIFIED / explicit remaining limits

- Transfer budgets (needs baseline sibling + install), ci:fast/full
  regression, pre-existing route-fixture red (root PR2286).
- Unsupported-peer (pre-claim receiver build): deliberately not verified
  (fabricating one would weaken the check).
- Live capacity bound (1024) and live crash-window states
  (`preparing`/`unresolved`/`refused` over the wire): unit-tested only; the
  echo path accepts too fast to observe `preparing` live.
- Reconciliation/retention/fence/cancel/UI, sender ledger, controller-side
  and frontend tracking of lookups: next-slice work, unchanged.
- No 485/106 closure claimed.
