# Continuity and existing-client follow-through

Status: active implementation plan; unfinished acceptance is not qualified.

This is the single ongoing branch `feat/continuity-epic-followthrough`, owned by
the continuity/Happier thread `7d385283-8974-4eeb-8f3b-8ba915efc58a`.
Its initial base is published master #3991 at
`d96f54887837be058c5e5119b8028daab0befea1`. That master is open and unmerged.
Merge subsequent published master changes and final main normally before
publication. Preserve the superseded original branches, unfinished index and
evidence. Open one PR only after this branch's agreed work is complete.

## Work already supplied by the master or earlier main

- #3499 supplies native identity verification and Conversation/Session lineage.
- #3518 supplies opt-in account recovery ordering, including nullable Codex
  quota handling. Its source is not proof of real two-account acceptance.
- #3177 supplies the existing fork/seed budget mechanism. Inspect its callers
  and remaining acceptance rather than building another seed engine.
- The master-owned Monument framing repair is a separate change; do not copy
  unpublished master work or change its `prepareText` ownership here.
- #3489's reset-credit investigation is complete. No automatic spending or
  live credit consumption is authorized by this plan.

## Remaining work and primary acceptance owners

### Reliable context delivery: #3487 and #3570

Pin the authorized seed before dispatch and project delivery separately from
the accepted-start boundary. Preserve `nativeReturnSourceEventId`, full native
identity checks, single native ownership, and deliberate empty-context behavior.
Only completion of the exact seed-bearing provider Session/turn may advance the
accepted-through projection. Failed or ambiguous delivery must cause a truthful
refusal or reconciliation path rather than silently skipping context.

Use the existing EventStore and Monument ownership boundaries; do not introduce
a second conversation store or copy the kernel's existing decisions. Pin
canonical order/cutoff, authorized source Sessions, seed digest and omission
facts. Per-Session sequence numbers are not interchangeable. A truncated seed
cannot acknowledge omitted history as delivered.

Extend the existing handoff qualification owner to cover first return failure
followed by an ordinary send, a second complete A→B→A cycle, budget overflow,
and restart between reservation and start. Observe adapter delivery or an
explicit refusal. Demonstrate the pre-fix regression before claiming repair.
Provider completion does not prove long-term provider transcript retention.

### Fork and bounded-history integration: #47 and #3164

Trace the already implemented seed through actual Claude/Codex/fallback fork
callers. Investigate the suspected seed-not-delivered and copied-row visibility
gaps without treating those hypotheses as reproduced defects. Repair confirmed
caller gaps in the same branch. Preserve independent branches, branch-point
provenance, budget/omission disclosure, and access checks. Qualify fork then
diverge and subsequent handoff using the production history projection.

### Account recovery qualification: #3488

Use two independently authorized eligible accounts on the same engine. Verify
distinct identities without exposing credentials, read fresh comparable quota
windows, exercise production selection/refusal, and observe the credential
actually applied to the provider Session/turn. Copies of one credential, two
models, static profiles, and selection helper assertions are not substitutes.

The prior device-login timeouts and single-account provider observations remain
separate retained evidence. Do not retry login blindly, copy tokens between
accounts, purchase allowance, or infer renewal/subscription lifecycle from a
plan name. Native lifecycle unavailability limits that claim and is not an
additional prerequisite for the reset-deadline slice. Live sign-in is a human
prerequisite when the second account's credentials are absent.
The owner explicitly deferred that sign-in while source work continues. Do not
start another device authorization or infer distinct-account proof meanwhile.

### Existing-client adoption: bounded #3274 follow-through

Build on the recorded independent Codex MCP client proof: scoped authorized
conversation read, useful Board mutation, wrong-Project refusal and revocation.
Coordinate with existing grant-interface owner thread
`7fd67b33-6260-4693-a69e-2f4a2c42214c` before changing setup or lease interfaces.
Preserve #3422's published grant source and the #3483/#162 authority owners.

Complete a usable setup recipe and only the missing public setup seam justified
by that real consumer. Keep connection, tool authority and execution takeover
distinct. Never export the Station-wide internal credential or claim a ready
remote OAuth endpoint, general ACP serving, A2A support, or marketplace delivery
from this bounded recipe. Preserve tool-specific authority, Project scope,
expiry, client mutation approval, and revocation behavior.

## Execution and delivery

1. Record overlap/custody and inspect the exact current source before edits.
2. Establish this branch's own managed dependency graph under fresh resource
   guards; never copy another lane's modules or use its reserved baseline.
3. Run pre-edit routing and focused owner tests. Keep failure injection,
   source review, local tests, live providers and hosted evidence separate.
4. Review affected canonical documentation and record only the claims actually
   checked. Do not turn unknown quota, delivery, lifecycle or authority into PASS.
5. Merge later master/main normally, qualify the exact combined candidate, and
   open the single PR once the work is complete. No intermediate PR or push to
   the retired originals is part of this plan.

The baseline currently reserved by the plugin owner is outside this lane.
No live provider call, browser run, heavyweight allocation or publication is
implied by recording this plan. Required account/provider evidence remains
NOT_VERIFIED until its actual receipt exists.

## First implementation increment

The scripted native-return qualification adapter can now fail the seed-bearing
turn before processing its context. Before the repair, its ordinary follow-up
was accepted; the new refusal assertion failed while the six existing cases
passed. The repaired continuation policy refuses that follow-up using the exact
handoff's observed terminal status. The four focused handoff, route, native
ownership and continuation-eligibility owners pass 28 tests. Server-test types
pass after building this worktree's required Connect export.

This is a bounded failure-path repair, not completion of #3570. Durable seed
pinning, accepted-through projection, omission/reservation-restart coverage,
fork integration, live account qualification and the external-client recipe
remain unfinished. No live provider or hosted result is implied.

## External-client setup increment

Verified all twelve source-body bindings in the bounded onboarding handoff
against initial published base `d96f5488`; none of those bodies had changed in
this branch before this increment. The implementation adds independently
revocable header leases through existing MCP transport and caller policy,
public personal-host operator routes, and `mcp-clients authorize/create/revoke`.
It requires file-proven device authority, explicit access administration,
recorded actor/Project identity, a selected starter tool set and a bounded TTL.
It preserves browser-bound assurance/approval and does not rotate runtime or
other client credentials. The CLI stores private configuration without printing
the bearer and does not automatically retry uncertain issuance.

The API/CLI tests and types are local evidence only. The original private-lab
consumer receipt remains separate; the new public setup still needs a fresh
real operator/client journey. POSIX private-file creation is the current CLI
scope; Windows creation refuses rather than claiming ACL qualification.
At the initial master base, the full pairing-route scanner also reports an
unrelated undeclared `POST /api/telemetry/panes` leaf. The new lease leaves have
explicit stronger scope rules; do not edit or waive the inherited master leaf
in this lane. Merge its owner's subsequent published repair normally.

The existing grant owner's v2 review approves the bounded external-client
issuer source/policy model with limits; it does not approve live onboarding.
Scoped custody clearance is not approval. The issuer uses the maintained
credential-by-ID scope check
for revocation/narrowing/account standing, without retaining its bearer, and
current Project identity is rechecked on each new-client request/call. This
review does not authorize a live token, login, provider call or deployment.

The sealed v2 review receipt has SHA-256
`1e95ae95d764ab82af038c5c2c8acb8a7e1d9f7151a2eabe34a76158a23a1a8c`.
Current issuer, caller and MCP route bytes match its snapshots. The token file
has a later comment-only change; the CLI adds unconfirmed-revoke error handling.
Those later deltas are outside that independent approval. The receipt does not
approve the full branch or establish #162 completion. Canonical setup docs now
state historical Session eligibility, file-proof authority versus the additional
scope gate, and per-request versus whole-command timeout limits.

## Current local evidence and unfinished gates

The external-client HTTP owner passes 22 tests, including issuer authority
withdrawn while the setup body is pending. Bypassing live issuer checks in a
finite fault injection produces two intended failures; exact restoration
returns all 22 to passing. The CLI owner passes 14 tests with one explicit
Windows-only skip on this POSIX host. Its private files now use the maintained
temporary-directory tracker, and the raw-temp-directory ratchet passes.
The documented client launcher carries only explicitly selected environment
settings and the scoped lease, excluding inherited Station credentials and
provider API keys. None of these results is a real client onboarding receipt.

The earlier handoff qualification increment passed eight cases, including a second
complete A→B→A→B→A cycle and persisted history after restart. Disabling native
return beyond three lineage Sessions makes only the new case fail on missing
matched native identity; exact restoration returns all eight to passing.
This does not cover restart between reservation and dispatch or immutable seed
pinning. Fork seed delivery/copied-history integration remains under caller
investigation, not established as repaired.

The next native-return increment pins exact catch-up bytes, their digest,
Session-local cutoffs and omission facts in the existing handoff reservation.
Status projects delivery from the correlated invocation/turn; complete text
ranges are acknowledged only with matched identity, observed completion and no
omission/shortening. Retries retain the pin and recheck authority; unpinned legacy
reservations refuse. A source high-water check inside the reservation transaction
refuses intervening appends before successor creation. The owner now passes ten
cases; three focused owners pass 26 tests, including budget disclosure, no full
acknowledgement after failure/truncation, and delivery receipts reloaded from disk.
Bypassing the snapshot fence produces one intended failure/nine passes; exact
restoration returns ten passes. The receipt is
`/private/tmp/station-continuity-context-snapshot-mutation-receipt-20261021.json`.
This increment does not complete generic context-boundary/fork pinning, a
per-native-identity aggregate accepted-through view, or reservation-to-start
restart qualification. No live provider result is implied.

The subsequent scripted reservation-to-start restart case passes: the first
attempt persists a pin and stops before creating the provider Session; the
store/service is reopened and the same handoff key resumes with the stored
digest and matched native identity. The qualification owner now passes eleven
cases. Ignoring persisted pending native ownership makes only that new case
fail; exact restoration returns eleven passes. Its local receipt is
`/private/tmp/station-continuity-reservation-restart-mutation-receipt-20261021.json`.
The fixture binding reader now handles reserved-but-unmaterialized successors
from persisted predecessor/target facts, and scripted provider turn IDs retain
their offset across restart. This is not an installed-provider restart receipt.

The external-client increment's readiness attempt failed documentation truth
because affected source/document claims still need review. Governance and lint
passed; an optional raw-temp-directory warning from that attempt was repaired
and checked separately. Readiness is not passing, and no PR or publication is
authorized by these local results. Two-account identity/quota/selection/applied
credential evidence and the fresh public onboarding journey remain unverified.


### Fork source checkpoint, 2026-10-21

The saved fork context now has an immutable owner-scoped reservation and digest
in the existing EventStore. First send carries the selected copied context to
scripted Codex and Claude adapters; canonical reads retain the copied parent
messages alongside subsequent runtime messages. A completion witness binds the
literal seed to its prepared invocation, authoritative terminal event and, where
required, native identity. A failed first seed refuses an ordinary follow-up.
No provider Session is fabricated for an unstarted fork.

Local evidence: four fork qualification cases pass; the combined fork/handoff/
execution-target run passed 75 tests before the fourth fork case was added. The
corrected orchestration owner suite plus all four fork cases passed 606 tests.
Server-test typechecking passed before final formatting. Governance passes after
replacing outward fork exception text with a fixed refusal. The lifecycle
contract owner passed 112 tests. These are scripted local results.

Readiness is not passing: the last full attempt reported lint and documentation
freshness failures, plus optional connected-agent and policy diagnostics. The
connected-agent diagnostic included three old handoff fixture expectations now
corrected and verified in the 606-test run, Codex project-configuration confinement
refusals, and a large projection timeout. The latter failures remain unresolved;
no production confinement check or performance bound was relaxed. New source and
test files still require a committed checkpoint for tracked-file policy checks.

Still unfinished: authorized pre-start fork reopening and deletion, generic
context-boundary recovery, final source review/docs/readiness and upstream
integration. Real onboarding and two-account identity/quota/selection/credential
application remain NOT_VERIFIED. Brian explicitly deferred second-account sign-in;
no fresh login or provider call was started. The branch remains unpublished.


The next source increment adds `fork-ready` opening without a provider Session,
SDK wire validation, shared dock writability and explicit busy state. Deletion
of an unstarted fork now tombstones the seed inside the lifecycle guard before
file cleanup. Delete-then-send failed before the repair and passes afterwards;
pre-start opening likewise failed before the repair. Six HTTP/service fork cases
pass, including deleted lookup/open returning 404 and unrelated-owner refusal.
The SDK/dock/fork selection passes 46 tests and the recovery-notice owner passes
seven. UI typechecking now reports only the unused private
`restartCredentialProfileRecoverySession` forwarder, verified unchanged from the
published d96f base. This is an unresolved typecheck failure, not a waiver.
No login/provider call, publication or readiness claim is added by this increment.
