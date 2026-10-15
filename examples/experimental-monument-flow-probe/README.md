# Parked Flow Agents continuation probe

Experimental, disposable evidence for [#3574](https://github.com/kontourai/station/issues/3574), part of [#3558](https://github.com/kontourai/station/issues/3558). **Recommendation: stay Tier 1.** This bounded model uses public Monument commands, but does not implement the Flow Agents continuation driver or qualify a real second consumer. No Flow Agents change ships here. Independent review and verification remain with the parent lane.

## Reproduce

Use Node 24 and Station's managed dependencies from the repository root:

```sh
npm run dependencies:ci
git diff --exit-code d57abb035ac3ad638cdf5615f4edbca051ac6e99 -- packages/monument
npm run test:focused -- examples/experimental-monument-flow-probe/probe.test.mjs
```

The kernel is pinned to Station commit `d57abb035ac3ad638cdf5615f4edbca051ac6e99`, package tree `79a414cac04356191febbf620adc639b23a510e6`. The diff command must succeed before interpreting the run as this probe's pinned result; it checks working-tree bytes too. Check out this PR's exact head to reproduce the consumer. This uses workspace package exports, not an npm tarball or a published version. Publication qualification belongs to #3677.

The JavaScript prototype adds no workspace, dependencies, package scripts, compiler exceptions, production exports, or provider hooks. The existing root focused runner discovers `.test.mjs`. Its four consumer cases use real temporary SQLite files, close/reopen them, and remove them afterward. Process liveness is the exported deterministic fake, not an OS process observation. `openProbeStorage` opens the public SQLite adapter; the exported conformance suite runs **all** its cases against this same opening path. It qualifies reuse of the existing adapter, not a new independently implemented storage engine. No Station module is imported. The only package imports are `@kontourai/monument`, `/sqlite`, `/testing`, and the existing Vitest runner.

## Source custody

Flow Agents was inspected read-only at `8bac9925007a0cee5015a87defb52d7bb5b994c5`. Its checkout was clean, 130 commits behind its tracked remote; `git diff HEAD origin/main -- src/continuation-driver.ts src/continuation-persistence.ts` showed no changes in those two files. This is not a claim of latest remote or released Flow Agents qualification. Review links below pin that inspected revision. The issue calls the second file `continuation-persistence.ts`; there is no need to guess a different persistence owner.

Kernel sources and API were inspected at the pin above: [commands](https://github.com/kontourai/station/blob/d57abb035ac3ad638cdf5615f4edbca051ac6e99/packages/monument/src/commands.ts), [records](https://github.com/kontourai/station/blob/d57abb035ac3ad638cdf5615f4edbca051ac6e99/packages/monument/src/records.ts), [transaction port](https://github.com/kontourai/station/blob/d57abb035ac3ad638cdf5615f4edbca051ac6e99/packages/monument/src/port.ts), [reconciliation](https://github.com/kontourai/station/blob/d57abb035ac3ad638cdf5615f4edbca051ac6e99/packages/monument/src/decisions/turn-boundary.ts#L317), and [public test support](https://github.com/kontourai/station/blob/d57abb035ac3ad638cdf5615f4edbca051ac6e99/packages/monument/src/testing/index.ts).

## Fit and gap

Every concept below has one disposition. A partial fit is classified as **needs kernel change** if claiming full mapping would omit a durability requirement. These are recommendations for a later contract discussion, not changes requested of the concurrent boundary writer.

| Actual continuation concept | Disposition | Public command fit and limit |
| --- | --- | --- |
| Prepared turn and invocation fence | **Mapped** | `turnBoundary.create(prepared)` then awaited `turnBoundary.transition(invoking)` before execution. Failed commit prevents the callback; dead prepared owner is removed by reconciliation. This maps the phase only: the request payload and mission state are not stored by this command. |
| Started turn without post-turn measurement | **Needs kernel change** | Reconciliation retains `indeterminate` after a dead invoking owner, preventing replay. Flow instead synchronizes canonical progress, measures it, clears active state, and records recovery. Kernel records have no progress snapshot or measured phase. A host must retain that reconciliation policy and durable measurement; blindly deleting an indeterminate row would be unsafe. |
| Turn journal, mission state, event/state reconciliation | **Needs kernel change** | Boundary records give in-flight phase and owner, but there is no append/read event journal, mission budget/count, definition identity or request payload in the command port. `CommitParticipant` can join custom host tables to a transaction; writing those tables would preserve a substantial consumer-owned persistence implementation. It does not provide the missing portable journal command. |
| Measured accepted-turn capture, durable callback/audit recovery | **Needs kernel change** | `requestKeys.claim` with a capture digest, then `complete` stores serialized capture and replays it. This is not atomic with boundary acceptance; the fourth consumer case demonstrates the split. There is no immutable capture/CAS plus phase transition, accepted-turn listing, or callback/audit checkpoint. A crash after claim but before complete stays unresolved. |
| Accepted-turn equality and coverage | **Needs kernel change** | The third case replays equal bytes and refuses changed result bytes at one key. Flow uses deep equality and validates bidirectional coverage between terminal events and accepted captures. Request-key TTL/quota eviction differs from the bounded lifetime journal, JSON property order affects this prototype's digest, and no list/coverage command exists. Do not replace the accepted journal with these request keys. |
| Mission-wide driver lock lease | **Needs kernel change** | Kernel owner identities and liveness are reusable; a turn boundary is not a driver-wide exclusive lease spanning recovery, capture, parking and subsequent turns. Do not use an untracked dedup claim to stand in for the lock or reclaim a begun effect. A generic owner-fenced mission lease or a retained host lock is needed. |
| Owner liveness observation | **Mapped** | `ownerLivenessFromProbe` and `planTurnBoundaryReconcile` consume host process observations; unavailable remains unknown, birth mismatch proves replacement. Flow's current lock uses PID plus token and a PID existence check. A production host must supply real process birth observation or explicitly use unverified identity; the prototype only uses test processes. |
| Park/resume barrier durability | **Needs kernel change** | The capture can serialize a wait result, but that is not a mission's durable `pending_barrier`, waiting state, or resumed journal event. No kernel barrier checkpoint exists. A host table/participant could keep it; the probe deliberately does not invent one. |
| PID/deadline barrier readiness and canonical overrides | **Stays in Flow Agents** | Waiting on process exit or time, synchronizing canonical Flow disposition, and recognizing completion while parked remain runtime policy. Kernel liveness of an effect owner is not a barrier-readiness decision. |
| Warm/fresh thread resume and canonical handoff | **Stays in Flow Agents** | Context strategy chooses new versus resume on mission start and configured policy. It is routing above the storage port. No thread-resume command should be fabricated. |
| Gate progress, authority issuance/cleanup, validation and bounded I/O | **Stays in Flow Agents** | Definition digests, gate measurements, signing capability, acceptance callbacks, limits, symlink defenses, and adapter timeouts are consumer/runtime concerns. Generic atomic durability primitives could support them, but do not establish those contracts themselves. |

Flow source references supporting the rows:

- [State, barriers, context and journal contracts, lines 15–155](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-driver.ts#L15).
- [Canonical barrier resolution and recovery, lines 240–266](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-driver.ts#L240).
- [Execution and context strategy, lines 290–355](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-driver.ts#L290).
- [Measured capture, callbacks, park/resume and progress, lines 397–466](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-driver.ts#L397).
- [Prepared/started/measured recovery, lines 632–676](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-driver.ts#L632).
- [File store, bounded logs and exact capture, lines 15–108](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-persistence.ts#L15), [accepted coverage, lines 154–166](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-persistence.ts#L154), [lock and state/event reconciliation, lines 168–225](https://github.com/kontourai/flow-agents/blob/8bac9925007a0cee5015a87defb52d7bb5b994c5/src/continuation-persistence.ts#L168).

## What Flow Agents could delete

**REASONED, conditional:** after a separately reviewed integration, the custom prepared/started crash-phase fence could delegate to boundary commands and owner observations. The host would still synchronize canonical progress before deciding the mission's next action. Replacing the PID-only lock logic would require an actual mission lease design. No current Flow code deletion is justified by this prototype alone.

The file-state reader/writer, mission events, bounded accepted-turn log, equality/coverage reconciliation, barriers, authority audit, gate progress, and context strategy all remain necessary. Moving them into bespoke SQLite tables through `CommitParticipant` would change persistence technology but would not prove that the kernel owns their rules. Adding an experimental wrapper to provider code would likewise not establish Tier 2.

## Behavioral evidence and limits

**EXECUTED:** the focused suite passed 49 cases (45 exported conformance cases plus four consumer cases); initial green duration was 1.12 seconds on Node 24/macOS arm64. The consumer cases establish:

1. Failure of the invoking commit leaves the external callback uncalled; after simulated crash and owner death the prepared turn can proceed under a new owner.
2. A started turn becomes indeterminate after owner death. Both a new prepare and a stale invoke are refused; the effect count stays one.
3. Equal serialized capture replays after reopen and a changed result conflicts.
4. Capture completion can commit while boundary acceptance fails under a stale owner. Replay then returns the capture while recovery still reports an indeterminate turn. This is an observed gap, not successful measured recovery.

Authoring rationale: the shared suite owns storage invariants. These four cases own the new consumer's callback ordering, restart policy, capture interpretation, and partial-commit behavior. The credible regression is executing before the invoking fence commits, which the first case must detect. No production seam is added. Mutation evidence is recorded below after a clean committed baseline.

**NOT_VERIFIED:** running the actual Flow driver, real CLI/provider invocation, signed acceptance callback/audit delivery, mission lease concurrency, physical process death, power-loss durability, migration from existing JSONL files, provider resume fidelity, published tarball consumption, hosted checks, and independent review. Simulated close/reopen is not a killed process. Successful conformance for SQLite reuse does not fill the command gaps above.

Tier 2 should be reconsidered only after the driver can retain its prepared/started/measured semantics and accepted capture/event coverage through a reviewed public durability contract, with restart evidence at each partial commit and a real non-Station integration. Tier 1 remains useful now under the epic's experimental-package conditions.

### Mutation receipt

At clean commit `e4eb7bb07d3`, the full focused command above passed 49/49 (1.13 s). Injecting `const outcome = execute()` before the invoking transaction and returning that outcome made the same command exit 1: the failed-commit case observed one effect instead of zero, and the stale-retry case observed two instead of one (47 passed, 2 failed, 1.79 s). Restoring `adapter.mjs` byte-for-byte produced an empty Git diff and 49/49 passed again. This detects the consumer ordering regression without modifying kernel or Flow Agents source. The injected implementation is not committed.
