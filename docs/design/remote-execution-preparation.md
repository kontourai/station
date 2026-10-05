# Remote execution preparation

> **Reading status: accepted direction; only slice 1 is built.** This record
> holds the owner decisions of 2026-10-03 for
> [#2875](https://github.com/kontourai/station/issues/2875) and the slices
> that implement them. Nothing below is shipped behavior unless the text says
> it **exists** and names the source that establishes it. Current-state
> claims were checked by source inspection against `origin/main` at
> `c2c67c2f25`. For dispatch into an already-prepared directory, which keeps
> its meaning, read the [CLI reference](../reference/cli.md); for attempt
> claims, read [delegation attempt claims](../guides/delegation-attempt-claims.md).

Status: **accepted direction** (owner decisions, 2026-10-03). The issue asked
for a general preparation and result-return contract with Git and non-Git
sources in the first delivery. The owner accepted a narrower first version,
described below. The issue's "Git and non-Git in first delivery" acceptance
is **relaxed**: the first delivery is Git only, and non-Git sources wait for
an owner (see [Deferred](#deferred)).

Issue references: [#106](https://github.com/kontourai/station/issues/106)
(portable Project identity), [#483](https://github.com/kontourai/station/issues/483)
(realizations and bindings), [#484](https://github.com/kontourai/station/issues/484)
(receiver admission) and [#485](https://github.com/kontourai/station/issues/485)
(durable attempts) are live issues in this repository. They are written as
full links because they predate the backlog reset numbering rule in
`AGENTS.md`.

## Problem

`station delegate --station=<name> --cwd=<path>` dispatches into a directory
the target Station can already see. It transfers nothing and checks nothing
about the source: a successful dispatch does not establish which version of
the code the Agent ran against. A person asking "run this on that Station"
often means "run this **at this commit** on that Station", and today they
must arrange and verify that by hand.

This record makes one of those obligations explicit and checkable: the
caller names the exact source version it expects, and the receiving Station
refuses to start work unless its own checkout is at that version.

It is not transfer, synchronization, setup or change application.

## Owner decisions (2026-10-03)

1. **Preparation is a phase of one #485 attempt**, not a new job or
   operation store. The attempt claim the receiver already writes before any
   effect is where preparation outcomes are recorded.
2. **The requirement travels as a new workspace target variant**,
   `project-portable-prepared`, that older receivers reject at their schema,
   plus a handshake capability flag the sender checks first. An optional
   field on the existing `project-portable` variant would be silently
   stripped by an older receiver, which would then execute unchecked.
3. **Git is one adapter.** The contract names a resource and an
   owner-qualified version, `{resourceId, version: {scheme, value}}`, with no
   Git fields. The receiver selects an adapter by the portable resource's
   kind; the Git adapter (`scheme: 'git-commit'`) reads only `HEAD` and
   tracked-file state.
4. **The version race is accepted and disclosed.** The receiver checks the
   version immediately before the session starts. Nothing stops a writer
   from changing the checkout afterwards, so the receipt says "version
   matched when checked", never "protected". A request for protection during
   execution refuses by name. A fully isolated guarantee waits for #484
   portable worktrees.
5. **Result return: yes, scope-gated, in a later parallel slice.** A
   delegating Station may read the receiver's session outputs, including
   file content, **only** for sessions that delegating Station started, and
   only behind an explicit scope the receiver grants. Not in slice 1.
6. **Deferred:** non-Git sources, the remote-reference mode (a named refusal
   only), and receiver setup scripts (the receipt says
   `setup: 'not-performed'`).

## Open decisions and slice 1 defaults

The owner did not decide these. Slice 1 takes the conservative default
shown; each stays open.

| Question | Slice 1 default |
| --- | --- |
| Dirty-tree policy: may an Agent run on a checkout with modified tracked files? | No. Any staged or unstaged change to a tracked file or to a submodule's recorded commit refuses (`execution_preparation_tracked_changes`). Index entries marked assume-unchanged or skip-worktree hide their changes from git, so they refuse as `execution_preparation_tracked_state_unverifiable`; this also refuses sparse checkouts. |
| Untracked files | Allowed. Their **count** is reported in the receipt; their names are not. |
| Transfer of unpublished work (commits the receiver does not have) | Not performed. A receiver without the commit refuses as a version mismatch. |
| Setup authority (dependency install, setup scripts) | None. Preparation runs no project code; the receipt says `setup: 'not-performed'`. Setup, if any, runs inside the Session under its existing approvals. |

## Current owners this extends

| Owner | What it already does | What slice 1 adds |
| --- | --- | --- |
| [Execution target contract](../../packages/contracts/src/execution-target.ts) | `project`, `directory` and `project-portable` workspace variants; the resolution receipt | The `project-portable-prepared` variant and an optional `preparation` receipt on `ExecutionResolutionReceipt` |
| [Delegation owner](../../src-server/tools/station-control-delegation.ts) | Portable admission, no-onward-hop, peer handshake gating, the #485 claim lifecycle | Requirement checks, the version check before session start, the capability gate |
| [Attempt claims](../../src-server/services/orchestration/delegation-attempt-claim-store.ts) | One durable claim per `(caller grant, attemptId)`, written before any effect; refused claims are tombstones | The refusal code on a refused claim, and the matched preparation facts on the admitted record |
| [Receiver admission](../../src-server/services/projects/project-contribution-service.ts) | Offer, binding and association checks, rechecked before each effect | The admitted resource's kind, so the adapter is chosen by kind |
| [Repository reads](../../src-server/services/projects/git-read-repository.ts) | Reads a member-writable checkout with a judged copy of its config, refusing repository-defined programs | Used by the Git adapter unchanged |
| [Capability flags](../../src-server/capabilities/station-capability-flags.ts) | Static protocol facts on the public handshake | `executionPreparation` |

## Contract

The public types live in
[`@kontourai/station-contracts/execution-preparation`](../../packages/contracts/src/execution-preparation.ts).
The receiver check and the closed adapter registry **exist** in
[`execution-preparation.ts`](../../src-server/services/execution-target/execution-preparation.ts),
called from `delegateTask` in the delegation owner.

```ts
// Workspace target variant (execution-target.ts)
{
  kind: 'project-portable-prepared';
  portableProjectId: string;
  resourceId: string;
  preparation: {
    protocol: 'station.execution-preparation/v1';
    mode: string;          // slice 1 supports 'existing-realization'
    version: { scheme: string; value: string }; // slice 1: 'git-commit'
    guarantees: string[];  // slice 1 supports 'version-matched-when-checked'
  };
}
```

`mode`, `version.scheme` and each guarantee are open strings at the route
seam on purpose. The receiver refuses an unknown value with a typed refusal
that names the dimension, instead of a generic validation error that would
tell the caller nothing about what this receiver supports.

| Dimension | Known values | This build |
| --- | --- | --- |
| `mode` | `existing-realization` | Supported: the receiver's own bound checkout, no transfer |
| | `remote-reference` | Known, refused by name: `execution_preparation_remote_reference_unsupported` (deferred) |
| `version.scheme` | `git-commit` | Supported for resources of kind `git`. `value` must be the full object id; an abbreviation never matches |
| guarantee | `version-matched-when-checked` | Supported |
| | `protected-during-execution` | Known, refused by name (decision 4) |

The **preparation receipt** rides the existing execution resolution receipt
(`handle.resolution.preparation`). It carries the mode, resource id,
requested and observed versions, the guarantee met
(`version-matched-when-checked`), when the check ran, the tracked-file state
(`trackedChanges: 'none'`), the untracked-file count and
`setup: 'not-performed'`. It carries no path. The same handle's
`resolution.workspace.cwd` does carry the receiver's absolute execution
directory; that is a pre-existing exposure of every portable dispatch
(#484), not something this receipt adds.

The capability flag `executionPreparation` on the public handshake is a
static protocol fact: "this build understands the variant". It says nothing
about what is offered.

## Receiver flow

The order below is the slice 1 path in `delegateTask`. Every refusal happens
before a session exists or a provider is invoked.

1. **Route seam.** A prepared intent without an `attemptId` refuses
   (`execution_preparation_attempt_required`): preparation is a phase of an
   attempt (decision 1).
2. **Sender gate** (when this Station forwards to a peer). The peer's
   handshake must advertise `portableExecutionOffers`,
   `delegationAttemptClaims` and `executionPreparation`. An older receiver
   refuses at the sender (`execution_preparation_unsupported`) without a
   wire round-trip; if the gate were skipped, the older receiver's schema
   would still refuse the unknown variant.
3. **Claim.** The receiver reserves the #485 claim. The intent digest covers
   the whole target including the requirement, so retrying the same attempt
   with a different version conflicts.
4. **Requirement check.** Protocol, mode and guarantees are checked against
   this build, before admission. These refusals need no repository read.
   The scheme is checked in step 7, because it depends on the admitted
   resource's kind.
5. **Admission and resolution** run exactly as for `project-portable`.
6. **Isolation.** A receiver whose Project resolves to worktree isolation
   refuses (`execution_preparation_isolation_unsupported`): the checked
   checkout would not be the directory the Agent runs in.
7. **Adapter.** The adapter registered for the admitted resource's kind
   reads the checkout. No adapter for the kind refuses
   (`execution_preparation_kind_unsupported`); a scheme the adapter does not
   produce refuses (`execution_preparation_scheme_unsupported`), and so does
   a value the scheme could never observe, such as an abbreviated commit
   (`execution_preparation_version_mismatch`). Both are checked before the
   checkout is read, so a malformed request learns nothing about its state.
   The Git adapter then refuses modified tracked files or submodule commits
   (`execution_preparation_tracked_changes`), assume-unchanged or
   skip-worktree entries (`execution_preparation_tracked_state_unverifiable`)
   and a different `HEAD` (`execution_preparation_version_mismatch`). The
   hardened git runner forces `--ignore-submodules=all` onto `status`, so
   submodule drift is read from the index's gitlinks against `HEAD`'s and
   from `ls-files --modified`, which compares a submodule's checked-out
   commit without running git inside it. An unreadable repository, a
   refused repository config or a repository that kept changing is
   `execution_preparation_unavailable`, not a policy denial.
8. **Bind.** The step 7 receipt is bound to the claim with the admitted
   facts. The claim keeps that first matched check; the handle carries the
   step 9 receipt.
9. **Recheck.** Immediately before the session start, after the admission
   recheck, the adapter runs again. On the reattach path (the reserved
   session already exists, so nothing starts) the same recheck runs before
   the claim advances and before the turn. A change since step 7 refuses
   with the same codes; the claim is still pre-effect.
10. **Execute** through the existing session start and initial turn. The
    handle receipt's `checkedAt` is the step 9 check.

A refused claim records its refusal code and drops any bound preparation
receipt, because a refused attempt never ran. The attempt lookup reports the
code, so a caller that lost the reply learns why the attempt refused. Two
refusals are never on a claim: `execution_preparation_attempt_required`
(there is no attempt) and a sender's `execution_preparation_unsupported`
(nothing was sent). Continuation turns on an already-running prepared task
are not re-verified.

## Race disclosure

Between step 9 and the Agent's first command, and throughout the turn, any
local writer can change the checkout: a person, another session sharing the
checkout, or a scheduled job. The Agent itself may also change it. The
receipt therefore states only that the version matched when checked. The
receiver does not fence writers, does not re-verify after the turn, and does
not claim the Agent's output corresponds to the requested version.

The path to a stronger guarantee is #484 portable worktrees: an owned,
detached checkout at the exact commit that no other session shares.

## Security notes

- The caller names a version, never a path. The checked directory is the
  receiver's admitted resource path, chosen by the receiver's operator offer.
- The Git adapter reads through the repository-read owner, which judges a
  copy of the repository configuration and refuses repository-defined
  programs (filters, fsmonitor and similar) before git runs.
- Refusal copy is fixed per code and carries no path, commit list or binding
  inventory. The peer hop relays only known codes.
- The receipt is evidence for the caller, not a capability. Nothing accepts
  it back as input.

## Slice plan

1. **Slice 1, version-matched execution on an existing checkout (built).** Contract types, the adapter registry with the Git
   `git-commit` adapter, the typed refusals above, refusal codes on the
   claim, and the optional preparation receipt. Evidence: unit tests for each
   refusal and the claim record, plus a two-Station live journey with one
   matched and one mismatched echo-provider turn, with plain-directory and
   portable dispatch as controls.
2. **Result return (parallel).** A receiver-granted scope lets the
   delegating Station read session outputs, including file content, for
   sessions it started (decision 5). Needs a scope token, an ownership join
   from the claim's caller grant to the session, and refusal tests for a
   session another caller started.
3. **CLI and SDK.** A `station delegate` spelling that reads the caller's
   own checkout `HEAD` and sends the requirement. Not decided.
4. **Isolated guarantee.** With #484 portable worktrees: an owned detached
   checkout at the exact commit, so `protected-during-execution` can be met.
5. **Transfer of unpublished work.** Only after the open decision above and
   a hosted-isolation review of a package upload route.

## Deferred

- **Non-Git sources.** `local-only` resources are explicitly non-portable
  ([project identity](../../packages/contracts/src/project-identity.ts)), and
  bindings are `git-checkout` or `local-directory` only. A non-Git adapter
  needs a source owner and an exportable resource kind.
- **Remote reference mode.** Working against an opaque reference without a
  checkout needs an execution admission that is not directory-shaped. Refused
  by name until then.
- **Setup scripts and dependency installation.** Not preparation effects.

## Evidence limits

Current-state claims in this record were checked by source inspection.
Slice 1 behavior is established by
[the adapter tests](../../src-server/services/execution-target/__tests__/execution-preparation.test.ts),
[the receiver-local delegation tests](../../src-server/tools/__tests__/station-control-delegation-preparation.test.ts)
and the `#2875` cases in the
[two-Station live proof](../../tests/portable-receiver-live-proof.spec.ts).
Not verified: a genuinely older receiver build (only the sender gate and the
schema reasoning cover it), SSH-forwarded prepared dispatch (refused by the
portable SSH rule), and writer races beyond the one injected in the unit
suite.
