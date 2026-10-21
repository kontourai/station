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
