# Verification receipts

A verification receipt is the immutable, content-addressed record a Station
verification lane leaves behind for one run of one exact workspace. It says
"this lane ran, here is the identity of what it ran against, here is how it
ended, and here are the artifacts it produced." It is **evidence about a run**,
not a decision to merge — a passing receipt can inform a decision but only the
canonical completion lane's receipt can stand in for the completion floor.

## Schema version

Current schema version is **3**, pinned by `VERIFICATION_RECEIPT_SCHEMA_VERSION`
in `scripts/lib/verification-receipt.mjs` and by the `"const": 3` constraint in
`schemas/verification-receipt.schema.json`. A receipt records its
`schemaVersion` as its first field; a producer or consumer that sees any other
value must reject it. Bumping the version is a breaking change to every
recorded receipt — version 3 (station#3584) added `terminal.indeterminate`
under `$defs.terminal`'s `additionalProperties: false`, which is not
additively compatible in either direction: a pre-3 schema rejects a receipt
carrying the field, and the version-3 `assertReceiptSemantics` (which requires
`indeterminate` to match its own derivation) rejects a pre-3 receipt that
never wrote it. Both directions are read as a schema-invalid receipt by
`completedReceipt()`, which is benign for a reuse/finished-lease check (it
falls through to real execution) but makes a live join across the version
boundary throw `'owner finished without a valid canonical receipt'` — a
caller sees the CLI's generic exit 2 rather than the exit 1 a real failure
would produce. That window closes once every coordinator on a host has
upgraded past station#3584.

## Producer ownership

Three modules own the receipt contract. They are the only producers; nothing
else should construct receipt JSON.

- `scripts/lib/verification-receipt.mjs` — builds the request identity,
  classifies the terminal outcome, and assembles the immutable receipt shape
  (`createVerificationRequest`, `verificationRequestKey`, `classifyTerminal`,
  `createVerificationReceipt`, `assertReceiptSemantics`).
- `scripts/lib/test-reliability.mjs` — collects the provenance the request is
  keyed against (`collectVerificationProvenance`, `collectWorkspaceProvenance`,
  `collectRepositoryIdentity`, `normalizeGitOrigin`, `digestRepositoryFile`,
  `detectToolchainIdentity`) and writes receipts without following symlinks
  (`writeReceiptSecurely`).
- `scripts/verification-lanes.mjs` — owns lane identity: the intentional lane
  ids, the literal command strings, the resource class, the owned mutable
  outputs, and the manifest digest. The coordinator, the changed-scope
  selector, and every consumer read lane identity from this catalog instead of
  re-deriving it from `process.cwd()` or package scripts.

The receipt extends, rather than replaces, the schema-v2 neutral workspace
helper the pre-push runner already consumes. `run-prepush-tier.mjs` keeps its
own `collectProvenance()` projection; the verification lane catalog consumes
`PREPUSH_TEST_GROUPS` from `scripts/prepush-test-manifest.mjs` and the
`e2eManifest` assignment from `tests/e2e-manifest.mjs` (it does not fork
either) and computes byte-identical manifest digests.

## Request identity and invalidation fields

A receipt is reusable only when its **request key** matches. The key is the
SHA-256 digest of the canonical (sorted-key) JSON of the request object. The
request object is assembled from exactly these fields, and a change to **any**
of them invalidates the key:

| Field | Source | Invalidated by |
| --- | --- | --- |
| `repositoryId` | normalized origin URL (common git dir fallback when no origin) | moving the repo / re-cloning under a different origin |
| `worktree` | real path of this worktree | running in a different linked worktree |
| `headSha` | `git rev-parse HEAD` | a new commit, an amend, or a rebase |
| `workspaceDigest` | tracked diff + untracked regular files | any working-tree change |
| `environmentDigest` | SHA-256 of allowlisted behavior toggles only | changing `STATION_CI_FAST_BASE`, `STATION_E2E_SEED_REGRESSION`, `STATION_FEATURES`, `STATION_SERVICE_ITEST`, or the effective `PRODUCT_LAW_OBSERVATION_TIMEOUT_MS` |
| `laneId` / `command` | lane catalog | selecting a different lane |
| `manifestDigest` | prepush test groups, the E2E spec→bucket assignment, or the command | a test-file list or E2E bucket assignment change |
| `dependencyDigest` | `package-lock.json` at the **repository root** (resolved from the Git toplevel, not `process.cwd()`) | a lockfile change |
| `nodeVersion` | `process.version` | switching the Node runtime |
| `toolchain` | detected package manager, e.g. `npm@<version>` | switching the package manager / its version |
| `toolchainIdentity` | SHA-256 digest of the canonical Node and npm executable identities | replacing or removing either bound executable, even at the same path/version |
| `platform` / `arch` | `process.platform` / `process.arch` | running on a different OS/arch |

`repositoryId` is derived from the **normalized** origin URL
(`normalizeGitOrigin`), so the same repository cloned over SSH, HTTPS, with or
without `.git`, or with embedded credentials derives one identity independent
of where it lives on disk. The common git directory is used only as a fallback
for a local repository with no origin. `collectRepositoryIdentity` resolves
the git root and common git dir correctly even when invoked from a
subdirectory. `collectVerificationProvenance` defaults its lockfile to the
**repository-root** `package-lock.json` (via that resolved toplevel), so a
subdirectory invocation digests the same lockfile as a root invocation rather
than pointing at a `package-lock.json` that does not exist. Likewise,
`collectWorkspaceProvenance` roots every git command and untracked-file read
at the Git top-level (not `process.cwd()`): `git ls-files` from a subdirectory
lists only that subtree with invocation-relative paths, so a coordinator that
does not `cd` to the repo root would otherwise hash a different, smaller file
set and derive a different `workspaceDigest`. Rooting at the top-level makes
`workspaceDigest`, `dependencyDigest`, and the other stable identity fields
identical whether the caller runs from the repository root or from
`scripts/`.

The environment identity is deliberately allowlisted rather than a digest of
the whole shell. It covers only toggles that change verification behavior:
`STATION_CI_FAST_BASE` (the affected-test diff base for bounded `ci:fast`
feedback), `STATION_E2E_SEED_REGRESSION`, `STATION_FEATURES`,
`STATION_SERVICE_ITEST`, and the effective
`PRODUCT_LAW_OBSERVATION_TIMEOUT_MS`. An unset, invalid, or explicit default
product-law timeout normalizes to 30,000ms before hashing; only a changed
effective policy invalidates reuse. That non-secret effective duration is also
recorded in receipt provenance and rendered by the CLI, so a passing receipt
cannot hide a weakened timeout. Runtime-assigned E2E ports/status flags and
disposable home paths are excluded, as are credentials and all other environment
values. Receipts store only the SHA-256 digest for arbitrary environment inputs,
never a raw environment value, so an environment change cannot join or reuse an
execution without exposing secrets.

### The request binds the before and after provenance

Volatile machine telemetry (CPU count, load average, memory) is recorded on the
provenance object for observability but is **deliberately excluded** from the
request key — a saturated box must not make a stable run look drifted. Because
only stable identity fields participate in the key, stability is defined as
"the after provenance re-derives to the same request key as the before
provenance":

- `createVerificationReceipt` re-derives the request key from `before` and
  throws if it does not match `request.key` (a receipt cannot pair request A
  with provenance B).
- `provenance.stable` is then `true` only when `after` re-derives to the same
  key, so a real working-tree change is recorded honestly as a drift rather
  than rounded up.

Because the workspace digest is part of the key, a receipt captured before
execution can never certify a workspace that changed during the run, regardless
of the child exit code.

## Terminal outcome

`terminal.passed` is fail-closed. It is `true` **only** when all of the
following hold: `status === 'completed'`, `exitCode === 0`,
`provenance.stable === true`, cleanup is `passed` or `not_required`,
`survivingOwnedChildren === 0`, and the counts show `executed > 0`,
`passed > 0`, `passed === executed`, `failed === 0`, and
`infrastructureErrors === 0`. Records carry no `skipped` field, so a pass
requires every executed test to have passed — counts like
`{ executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 }` leave one
test unaccounted for and are non-passing. The absent `skipped` field is not a
licence to count a skipped test as failed: a producer records `executed` as the
tests that actually ran, so a skipped-only run reports `executed: 0` and is
refused by the same invariant. Every other combination — including
a completed zero-exit run whose provenance drifted, a run that left owned
children alive, or a run with skipped-only / partial counts — is recorded
honestly as non-passing rather than rounded up.

`terminal.indeterminate` (present and `true` only when set) marks a `false`
verdict whose **only** disagreeing input is `provenance.stable`: `status ===
'completed'`, `exitCode === 0`, cleanup is `passed`/`not_required` with no
surviving owned child, and the counts alone would satisfy `isPassingCounts`.
A failed cleanup or a surviving owned child does **not** qualify, even though
either can co-occur with a clean exit code and clean counts (a child that
exits zero but leaves something un-reapable) — those are real defects, this
repo has a documented history of orphaned processes wedging a host, and
"re-run rather than diagnose" is exactly the wrong advice for one; re-running
only compounds the leak.

`request.key` is derived once from the `before` provenance captured at
coordinator entry; `provenance.stable` is whether a later `after` snapshot
still re-derives that same key, and `workspaceDigest` (the dominant term in
that key) hashes the tracked-file diff plus untracked files. For a
**directly-executed** run, "later" is just its own runtime, so instability
there means the tracked-file tree moved out from under the run while it
executed (station#3584) — a real ambiguity the phase's own output cannot
speak to, not a defect the run reported.

A **joiner** faces the same ambiguity after waiting on another owner to
settle — its own `before` was captured at entry, before a wait that can run
minutes — but it does not reach this label: `publishJoinedReceipt`
(`scripts/lib/verification-coordinator.mjs`) re-checks the joiner's own
provenance after the wait, mirroring `reuseFinishedOwnerReceipt`'s
pre-projection check, and retries as a fresh request (very likely a real
execution, since the prior owner has already vacated) rather than publish a
stale-`before` projection. `indeterminate` is the residual ambiguity that
retry cannot resolve — a directly-executed run drifting during its own
runtime — not the common join outcome; an earlier version of this fix and of
station#3584's diagnosis had that backwards, attributing indeterminate
receipts to "a joiner adopting an owner that never reached a valid terminal
state", which `publishJoinedReceipt`'s validation of the owner's receipt
(`receiptValidator` + `assertReceiptSemantics`, both required before a joiner
ever adopts anything) makes structurally impossible.

`terminal.passed` stays `false` either way — fail-closed and unchanged shape
for a genuine failure — so a consumer that only reads `passed` still refuses
to treat it as a pass; `indeterminate` is the additive signal telling a
caller to **re-run rather than diagnose**. It is surfaced in every rendering
of a terminal result: the bounded CLI/status summary
(`boundedControlResult` in `scripts/run-verification.mjs`) always stamps a
top-level `summary.indeterminate: true` from the authoritative receipt
regardless of which code path produced the result, and the submission
handoff's `submit-status` projection (`scripts/lib/verification-submission.mjs`)
carries it alongside `status`/`passed`. The CLI's exit code is unchanged by
this flag — `verify:static` still exits non-zero for an indeterminate result,
the same as any other non-pass, so a caller that only checks the exit code
still fails closed; only a caller that reads the JSON body sees the
distinction. Both `classifyTerminal` and `assertReceiptSemantics` derive
`indeterminate` from the same `isCleanExceptForProvenance` predicate and
reject a receipt whose recorded flag disagrees with that derivation, in
either direction.

When ci:fast's reporting path itself breaks but the changed-verification
diagnostic still carries well-formed failing executions, the receipt persists
that evidence additively: `terminal.recoveredFailures` (bounded, `file` +
`name` per entry, capped at each execution's own `counts.failed`) and
`terminal.reconcileNote` (the reporting failure's bounded reason). Terminal
status is `failed` in that case; `infrastructure_error` is reserved for runs
with no recoverable failure evidence. Counts remain the canonical failure
tally — `recoveredFailures` is corroborating identity, never an independent
count source.

The terminal status vocabulary is closed. `failed`, `infrastructure_error`,
`canceled`, `timed_out`, `rejected`, `parser_error`, and `provisional` never pass.
`rejected` means the bounded host-wide completion-waiter queue declined the
request before any phase ran; it is explicitly non-evidence. `parser_error`
means the harness ran but could not parse trustworthy counts, and `provisional`
means an interim, not-yet-final result.

Two of those statuses mean the run was **stopped**, not judged: `timed_out` and
`canceled`. No step failed and no test verdict exists, so the bounded summary
names the step that was still running as `inFlightStep` rather than
`failingStep`, and `failingStep` is absent. Every other non-passing status
still reports `failingStep` as before. Read `inFlightStep` as "give this phase
more budget, or shard it further" — not as "this step is broken".

This distinction is load-bearing. Eight consecutive tagged releases reported
`failingStep: test:full:ordinary:raw` alongside a `[vitest-corpus] ordinary:
FAIL` tally when the real terminal status was `timed_out` on a 45-minute phase
deadline. Nothing had failed, which is exactly why no failing test name
appeared anywhere in the receipt — the suite never finished. A reader who
trusted the field's name looked for a broken test that did not exist.

### Schema and runtime semantics compose the pass contract

The JSON Schema and `assertReceiptSemantics` together enforce the fail-closed
truth table. The schema's `if`/`then` clauses structurally require, for any
`passed: true` receipt: `status: completed`, `exitCode: 0`,
`provenance.stable: true`, `cleanup.status` in `passed`/`not_required`,
`survivingOwnedChildren: 0`, `executed >= 1`, `passed >= 1`, `failed === 0`,
and `infrastructureErrors === 0`; and they forbid any non-completed status
from claiming a pass. The published schema is **portable standard JSON Schema
Draft 2020-12** and compiles under Ajv's default options — no `$data` or other
nonstandard extensions are required of any consumer.

Because standard JSON Schema cannot express cross-property integer equality,
the schema does **not** by itself enforce `passed === executed`: a receipt with
`{ executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 }` is
schema-valid. Records carry no `skipped` field, so that count-completeness
equality is enforced only as an **explicit runtime semantic guard** —
`isPassingCounts`, `classifyTerminal`, and `assertReceiptSemantics` all require
`passed === executed` (every executed test must have passed), and the producer
(`createVerificationReceipt`) refuses to classify a passing receipt with
partial counts. `assertReceiptSemantics` additionally enforces the
request/before/after identity binding a schema cannot compute (it cannot hash
provenance). A receipt is a true pass only when it is accepted by **both** the
schema and the runtime guard.

### The request is bound by its full canonical projection, not its key alone

The request key is a SHA-256 of the request object, so a naive "recompute the
key and compare" check is defeated by an attacker who **retains the original
key but rewrites a request field**. Because the key is re-derived from the
unchanged provenance, it still matches, yet a consumer reading
`request.command` (or `manifestDigest`, `dependencyDigest`, `toolchain`, …)
directly trusts the forged value.

To close that, both `createVerificationReceipt` (the producer) and
`assertReceiptSemantics` (the guard) recompute the **full canonical request
projection** from `request.laneId` and the before provenance — the command and
`manifestDigest` from the lane catalog, and `repositoryId`/`worktree`/
`headSha`/`workspaceDigest`/`dependencyDigest`/`nodeVersion`/`toolchain`/
`platform`/`arch` from the provenance — and compare every field against the
recorded request. The recorded `request` must be exactly the request the lane
and provenance would produce; a single tampered field is rejected before any
pass decision, regardless of whether the retained key still matches.

## Artifacts

`artifacts` is an array of `{ path, sha256 }` entries for the mutable outputs
the lane created (for example, the reliability JSON the prepush lane writes).
Artifact paths are restricted to **safe repo-local `.kontourai/` relative
paths**: the schema rejects paths outside that root, absolute paths, Windows
drive paths, backslashes, and any `..` traversal segment, so a receipt cannot
reference a sibling's or system path. The digest must be exactly 64 lowercase
hex characters.

The runtime validates **every artifact equivalently to the schema** before any
pass/acceptance — in both the producer and the semantic guard — so a receipt
loaded from disk or forged by hand cannot carry a path or digest the schema
would reject, even if Ajv never saw it. The path check mirrors the schema's
`.kontourai/`-rooted relative pattern (no absolute, drive, backslash, or
traversal segment) and the digest check mirrors the `^[0-9a-f]{64}$` pattern.

Lookup is by `request.key`: a consumer that wants the receipt for "this exact
workspace on this exact lane" recomputes the request key and finds the matching
receipt. Receipts are **repository-local** evidence rooted under `.kontourai/`;
they are not published and are not merge evidence on their own.

The lane catalog declares each lane's `ownedOutputs`: the truthful, conservative
set of mutable repository paths that lane creates, so a consumer knows which
paths a given lane is allowed to mutate, and so cleanup can verify the process
tree left no owned children behind. An empty `ownedOutputs` means the lane is
genuinely read-only, not "unknown"; build-producing lanes declare their real
build output directories. `test-full` declares `packages/cli/dist/` because its
package-bundle group rebuilds that output. Both the `prepush` lane and
the `verify-static` lane own `packages/connect/dist`: `test:prepush`'s private
adapter begins with `prepare:verify-static`; the public `preverify:static`
lifecycle hook is deliberately a no-op, so it cannot re-enter coordination.
The private static adapter begins with `verify:static:bootstrap`, whose final
step is `prepare:verify-static` (`node scripts/prepare-verify-static.mjs`),
the script that rebuilds every `REQUIRED_STATIC_WORKSPACES` dist (currently
`packages/connect/dist`). The catalog's literal-script tests pin both chains
so a rewiring cannot silently orphan the declared outputs. The `verify-local`
lane also owns `packages/connect/dist`: its private raw adapter explicitly
invokes the private static adapter before the native checks. It additionally
owns `src-desktop/target/`, because both
`verify:desktop-rust` (`cd src-desktop && cargo test`) and the mobile compiler
run Cargo with `src-desktop` as their working directory, where Cargo creates
`target/`; it preserves `dist-server/` and `dist-desktop-runtime/` for the
desktop script's setup output. The `verify-e2e-full`
lane owns the instance-named `dist-server-e2e-*/` and `dist-ui-e2e-*/`
directories its runner creates per invocation (the same
`dist-(server|ui)-e2e-*` prefixes the runner's own sweep reclaims), expressed
as conservative patterns scoped to `e2e-*` so they cannot match another lane's
`dist-server/` or `dist-ui/`. The catalog's validator rejects an
`ownedOutputs` entry that is absolute or traverses outside the repo, mirroring
the artifact-path contract.

## Canonical completion lane

Only one lane can certify the final exact workspace: `full-regression`, whose
literal command is `npm run full:regression`. That command string is the sole
trust-reconcile evidence command and is kept byte-identical to the
`trust-reconcile-manifest` entry in `package.json`. Every other lane
(`ci-fast`, `prepush`, `test-full`, `test-coverage`, `verify-static`,
`verify-local`, `verify-e2e-full`) is diagnostic: its receipt
can inform a decision but cannot substitute for the completion floor. The
catalog's strict validator rejects a catalog with zero or more than one
completion lane, a completion lane whose command drifted, or an `unsafe`
classification.

`npm run full:regression:submit` is a separate, non-evidence handoff surface
for freeing the invoking agent. It returns only an `accepted` record with the
exact request key, handoff path, canonical-receipt path, and the existing
`submit-status <request-key>` command. The detached worker re-derives that request before it can
execute and fails closed if the worktree no longer matches. It only announces a
ready nonce; the submitting parent atomically records `coordinating` with that
nonce before it acknowledges the worker. Joiners accept only that committed
state, and a parent readiness timeout is terminal. `submit-status` accepts
only an exact 64-character lowercase hexadecimal request key and returns
redacted, path-sanitized errors. A submission is not a passing receipt; only
the eventual canonical `npm run full:regression` receipt can certify the
workspace.

## Retention inventory (no deletion)

`node scripts/run-verification.mjs status` and `submit-status` return the same
bounded, identifier-free `retention` inventory. It reports aggregate terminal
handoffs retained and eligible, live `launching`/`coordinating` handoffs, retry
claims, request/output/completion fence counts (including `fenced` and
`recoveryPending` where recorded), ownership-loss records, and scan health.
Corrupt or incomplete records are skipped and counted; paths, request keys,
errors, and output are never included in this aggregate.

The terminal-handoff GC policy is explicit: terminal handoffs are eligible only
after a 7-day TTL and only beyond the
newest 256 terminal records, with per-collection scans bounded to 512 records
and every removal pass bounded to 64 records. `submit` runs this bounded
maintenance pass before claiming a new handoff; it is also available explicitly
as `node scripts/run-verification.mjs handoff-gc`. `status` and
`submit-status` remain read-only and report the aggregate `lastSweep` result.

A sweep removes only complete-inventory terminal handoffs that are both older
than the TTL and outside the newest-record reservation. If the submissions scan
is truncated, it removes zero records and reports a non-actionable sweep. Each
candidate is serialized with the same retry claim used by rejected-handoff
retries, fingerprinted before and after an atomic outer-directory quarantine,
then only that exact quarantine is removed. It never removes launching or
coordinating handoffs, retry claims, request/output/completion fences,
ownership-loss records, or receipt/output evidence. Finished request, output,
and completion leases remain fence observations because their coordinator
lifetime is governed by separate policy. If the submissions scan is truncated,
`terminal.complete` is `false` and `terminal.eligible` is `null`: eligibility
is non-actionable until a complete inventory is available.

## Explicit orphan-artifact sweep

| Artifact class | Retention bound | Protection |
| --- | --- | --- |
| Terminal submission handoffs | 7-day TTL, newest 256 retained, scan 512/remove 64 per pass | launching/coordinating and retry claims are never candidates |
| Orphan output, phase, pending, and quarantine records | 24-hour TTL, scan 256/remove 32 per pass | committed receipt closures and live host leases/handoffs are never candidates |
| Canonical receipts and referenced evidence | immutable while referenced | not cleanup candidates; broader history pruning requires a separate explicit policy |
| Finished coordinator leases | coordinator-owned bounded metadata policy | active, fenced, and recovery-pending leases remain protected |

`node scripts/run-verification.mjs artifact-gc` is the only automatic-artifact
cleanup surface. It is deliberately **not** run by `status`, `submit-status`,
or normal verification. The command examines at most 256 local records and
removes at most 32 records older than 24 hours. A truncated scan processes only
that bounded prefix and reports `truncated: true`; every candidate still
receives the full independent protection checks below. A scan that encounters a
symlink/corrupt record or cannot establish coordination state removes zero
records from that sweep.

Before an old output directory, phase-record directory, pending receipt, or
quarantined receipt is removed, the sweep takes the exact host request-key
artifact-mutation fence as a short exclusive claim. The coordinator acquires
the same fence before local reuse, admission, or artifact/phase publication,
so a verifier cannot write the matching request between GC's final retention
check and deletion. The sweep preserves every valid committed canonical receipt
and the entire matching output/phase closure, plus any key with a host
request/output/completion lease or a nonterminal submission handoff. Each
candidate is moved by an atomic outer rename, then its inode and all retention
fences are checked again immediately before only that quarantine is deleted. A
successor at the canonical path is never removed. Canonical receipts and their
`.commit.json` records are never cleanup candidates; broader history pruning
remains an explicit future policy.

The command prints only aggregate `scanned`, `removed`, `retained`,
`truncated`, and `ambiguous` metrics. It does not expose request keys or raw
verification output.

Use `artifact-gc --dry-run` for a non-mutating bounded candidate report, or
`artifact-gc --explain` for the same report when auditing policy. Each candidate
contains its exact repo-relative path and the reason it is eligible. Both modes
leave every record in place; candidates are snapshot observations and the real
delete mode rechecks all protection and identity fences under its mutation
claim before removal.

## Progressive use and artifact lookup

### Exact CI change classification

Heavy push workflows do not use GitHub `paths-ignore`: native path filters and
the Compare API consider at most 300 changed files, which can misclassify a
large docs change with a runtime file later in the diff. Their lightweight
`ubuntu-latest` classifier checks out full history (`fetch-depth: 0`) and runs
`scripts/classify-ci-change.mjs` over the complete `before..sha` range. The
classifier performs no `npm ci` and acquires no physical-host capacity lease.
Its captured Git filename list is bounded to 16 MiB; a missing before revision,
invalid range, checkout failure, or overflow fails closed instead of reporting
docs-only.

Heavy jobs own lane-specific concurrency groups only after classification. A
docs-only push therefore runs the independent Secret Scan and classifier but
does not enter or cancel fast, full-regression, browser, or container work.
Manual dispatches fail closed to heavy verification. The local deterministic
policy gate is `npm run gate:ci-change-classifier`; its fixtures include more
than 300 docs files both with and without a runtime file beyond position 300.

During implementation, begin with `npm run test:changed -- --base=origin/main
--explain`, then run its named focused proof. A changed receipt is diagnostic:
with `--explain`, exit 0 only records that an explanation was emitted; without
it, exit 0 records a completed focused result. Exit 3 records a
provisional/deferred selection; neither is completion evidence.

The coordinator may return exit 0 for an executed, joined, or reused coordinated
lane. Only the final `npm run full:regression` receipt can certify the exact workspace.

Heavy public lanes share a host-wide weighted lease. Use
`node scripts/run-verification.mjs status` before escalating to inspect queue
and CPU contention. Terminal output is a bounded redacted summary. A bounded
redacted prefix of stdout/stderr and approved text attachments lives under
`.kontourai/verification-output/<request-key>/` and is referenced by digest.

The bounded summary's `firstCausalExcerpt` (station#1871/#2591/#3189) names the
single most actionable diagnostic line found in the captured output, scoped to
the step that actually failed. Station#4249 adds `causalExcerpts` alongside
it: every distinct failure-shaped excerpt genuinely observed in that same
captured, attributed region — not only the first — so a completion-mode run
(the un-chained `typecheck` and `docs:truth:gate` aggregate runners, or any
single lane that itself reports more than one failure) can report every
independent break in one receipt instead of costing one full re-run per
failure. `causalExcerpts[0]` is always exactly `firstCausalExcerpt` when both
are present; both fields are additive and optional, so an older consumer that
reads only `firstCausalExcerpt` is unaffected. Neither field is part of the
schema-validated canonical receipt (`schemas/verification-receipt.schema.json`)
— both live only in the transient bounded summary
(`summarizeVerificationOutput` / `boundedSummaryEnvelope` in
`scripts/lib/verification-reporter.mjs` and
`scripts/lib/verification-terminal-receipt.mjs`) returned by the CLI and the
coordinator, so this addition needed no `schemaVersion` bump and does not
change the receipt's request-identity or pass/fail contract.

`causalExcerpts` is a **lower bound on distinct observed failures, not a
certified complete list**, and it draws from exactly two sources — a reader
needs to be able to tell which one produced a given receipt's entries:

1. **The ordinary case.** Every entry is a failure-shaped excerpt that
   literally appeared as text in the captured, attributed output
   (`summarizeVerificationOutput` in `scripts/lib/verification-reporter.mjs`).
   It never fabricates an entry for a check that a short-circuited fail-fast
   step never reached, and it is silent (an absent field, alongside an absent
   `firstCausalExcerpt`) rather than reporting a false empty list when nothing
   causal was observed at all. What it cannot do is prove completeness: it has
   no manifest of "every check that was supposed to run" to compare against,
   so it cannot positively assert that a check not named here passed, only
   that no failure-shaped text for it was found in what was captured.
2. **The reporting-failure case.** When the reporting pipeline itself throws
   before it can summarize the real output — `reportExecution`'s catch
   branches in `scripts/lib/verification-terminal-receipt.mjs` — both
   `firstCausalExcerpt` and `causalExcerpts` carry a *synthesized* diagnostic
   (`reconcileNote`, built from the caught error's own message) naming that
   reporting failure, not text read from the run's own stdout/stderr.
   `causalExcerpts` is then the trivial one-element list `[reconcileNote]`:
   still true to what is actually known (there is exactly one identified
   cause, the reporting break itself), but it is a claim ABOUT the reporting
   pipeline, not a claim about the underlying command's output.

Case 2 is identifiable in the summary itself: it always also carries a
`reconcileNote` field (the same bounded diagnostic text `causalExcerpts`
repeats as its one element) alongside the `terminal` status
(`infrastructure_error`, or `failed` with `recoveredFailures`/`failedTests`
also present). Case 1 never sets `reconcileNote` — its absence is what tells a
reader `causalExcerpts` came from the run's own captured output rather than
from a reporting-pipeline failure. Read either case together with the
summary's own `truncated` flag — under truncation the retained text is a real
prefix, so every excerpt in it is still genuine, but there may be more beyond
the cut.
If stdout or stderr crosses the capture bound, the receipt is nonpassing and
reports truncation explicitly; retained output is diagnostic evidence, not a
claim that the overflowing stream completed.
Do not invoke `*:raw` scripts directly: they are coordinator implementation
details, not a public verification contract.

## Validation command

Validate a receipt against the schema with the draft 2020-12 Ajv build (the
schema uses `if`/`then`, `const`, and `$defs`):

```sh
npx vitest run scripts/__tests__/verification-receipt.test.ts \
  scripts/__tests__/verification-lanes.test.ts
```

That suite compiles the Ajv schema, validates positive and negative fixtures
(including the full terminal truth table, the request/before/after binding,
counts, cleanup, and artifact-path restrictions), proves the request key is
invalidated by every identity field, and asserts the lane catalog stays strict,
consumes the real prepush and E2E manifests, and declares truthful owned
outputs.

## Relationship to Flow Agents

This is the Station-side producer contract. Flow Agents issue **#1111** is
separate consumer work: it will read verification receipts as Builder evidence
through the trust-reconcile manifest, not by reaching into these modules. Until
that consumer lands, a verification receipt is a recorded artifact that
informs, but does not by itself satisfy, a Builder gate.
