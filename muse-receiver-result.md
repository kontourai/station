# Portable receiver — Muse implementation result

Worktree: `project-portable-receiver-484-20260920` (Station 708 base).
Prior commits preserved: `71878e02a`, `69e8af539`, `5ca05a249`
(effect guards), `d097bccf8` (exact association + recovery spawn guards).

Note: no `muse-receiver-result.md` / `receiver-root-review.md` was present
in this worktree when this turn started (checked working tree; history-wide
search was inconclusive), so this document starts here rather than
appending. The GLM live-proof lane owns its own TEST-ONLY files; none were
touched.

## Turn: root review of d097bccf8 — HTTP caller-path fix (controller/receiver split + no-onward-hop)

Root finding: `POST /delegations` in
`src-server/routes/orchestration/orchestration.ts` eagerly called
`deps.authorizeReceiverExecution` BEFORE `delegateTask` resolved/forwarded
the environment, so a CONTROLLER operator request targeting a SAVED
receiver wrongly required a local Project offer/association on the
controller. The earlier local-guard move fixed direct function tests only,
not this HTTP caller.

### Fix (canonical resolution/composition owner)

- Route mints NOTHING eagerly. For a `project-portable` intent it captures
  the server-only mint factory (bound to the current request credential
  via `isRequestPrincipalCurrent`) plus verified caller facts BEFORE any
  await, and threads them into `delegateTask`. No environment is resolved
  in the route, so nothing races the single `resolveTarget` inside
  `delegateTask`. The factory is a closure — it cannot cross public JSON.
- `delegateTask` (`src-server/tools/station-control-delegation.ts`) mints
  the admission through the factory ONLY when its single resolution
  selects `current` (actual local execution). A forwarding controller
  never mints and needs no local offer/association. A sender holding a
  minted admission while forwarding is refused fail-closed. The recheck
  chain (start boundary, turn boundary, effect-threaded admission) is
  unchanged.
- No-onward-hop: an INBOUND enrolled peer (`PairedDevice.kind ===
  'delegation'`, read by runtime composition off the verified
  credential's device record — never body/userId/metadata) requesting
  portable mode toward a non-current destination is refused with distinct
  code `receiver_execution_forwarding_refused` BEFORE any peer handshake
  fetch, forward POST, or provider effect. Operator and ordinary personal
  `device` controllers MAY still select a saved peer; same-alias-resolved-
  current executes locally (verdict uses the actual selected destination,
  never the alias string). SSH portable forwarding still refuses as
  before. `isInboundDelegationPeer` additionally exempts operator/internal
  callers even against a corrupt record.
- Route maps every `ReceiverExecutionRefusal` to an exact 403 WITH its
  `code` (create, continue, respond paths — previously message-only).
- `runtime-routes.ts` wires `resolveInboundDeviceKind` from the same
  `identifyDevice` lookup the principal resolver uses.

### Tests (all through the REAL route → actual delegateTask composition)

`src-server/routes/orchestration/__tests__/orchestration-portable-delegation.test.ts`
(17 tests in file), new `controller/receiver split` block:

1. Controller with NO local offer forwards the exact portable intent to
   the configured peer; sender factory spy never called; forwarded body
   keeps portable ids with `environment: { kind: 'current' }`.
2. Enrolled-peer inbound (`inboundDeviceKind: 'delegation'`) to a third
   host → exact 403 + `receiver_execution_forwarding_refused`, zero peer
   fetches, no mint, no session/turn effect.
3. Operator/ordinary-device controllers MAY select the saved peer
   (forward allowed, no mint) — both `undefined` and `'device'` kinds.
4. Wrong expected handshake environment → exact 403 +
   `receiver_execution_not_offered`, no dispatch POST.
5. Missing `portableExecutionOffers` capability flag → exact 403 + code,
   no dispatch POST.
6. Receiver-local positive: factory minted once with exact ids, admitted
   cwd bound to the started session.
7. Receiver-local without wired factory → exact 403 + code, no effect.
8. Legacy non-portable peer forwarding unchanged (control).
9. `isInboundDelegationPeer` unit pin: operator/internal/local-operator
   never peers; `delegation` kind is the positive signal.

First block updated: route composes the factory (never a minted
admission); refusal mapping asserts exact 403 + code.

### Verified this turn

- Focused + neighboring suites: 634/634 across 5 files
  (portable-delegation 17, orchestration.routes, routes.wired,
  project-contribution-service, orchestration-service 449).
- `tsc --noEmit` clean; `biome check` clean on all 5 touched files.
- No broad gates per brief (`ci:fast`/Veritas left for root).

### Honestly not done (for root)

- Live two-Station proof: NOTVERIFIED here — controller/peer are
  fetch-stubbed single-process doubles. The GLM harness lane owns the
  real two-headless-Stations proof once both merge.
- Route-level re-admission wiring for continue/respond portable paths
  (pre-existing gap, unchanged).
- `receiver-root-review.md` / original scope doc were not present in
  this worktree; constraints were taken from the turn brief text.
