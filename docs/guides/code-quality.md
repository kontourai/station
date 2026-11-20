# Code Quality & Push Workflow

This guide states contributor requirements and explains the checks that support
them. A gate's existence, a timing estimate or a source rule is not proof that
all product behavior is covered. Use the actual command result and its revision
when reporting evidence; dated incidents below explain why rules were added.

## Repo git hooks

Station ships its own hooks in `.githooks/`, version-controlled so they travel
with the branch and every worktree behaves the same. Bootstrap a root checkout
through the dependency lifecycle runner:

```bash
npm run dependencies:ci       # fresh, lockfile-exact checkout
npm run dependencies:install  # refresh an existing developer checkout
```

Both commands use pinned pnpm with dependency lifecycle scripts disabled,
then apply the reviewed lifecycle allowlist, patch configuration and Git-hook
setup. `npm run` is the script interface, not an instruction to run raw npm
installs. To repair hook setup alone:

```bash
npm run hooks:install    # git config core.hooksPath .githooks
```

`npm run gate:for [-- <paths...>]` prints which of the scoped checks below a
change surface feeds, using the hook's scope deciders. Run it before editing;
its output selects evidence and prints guidance but does not execute those
checks or grant permission to publish. For `.tsx`/`.css` under `src-ui/src` or
a pane package it also names the gallery screens whose module graph loads the
path and the commands to capture just those
([gallery product assertions](testing.md#gallery-product-assertions)).

The pre-push hook runs these checks, in this order. Costs in this table are
historical measurements, not deadlines or guarantees on the current host. The hook file,
`.githooks/pre-push`, is the source of truth if this table drifts:

| Check | Cost | Refuses |
| --- | --- | --- |
| `node scripts/prepush-main-conflict.mjs` | instant | nothing: it warns, naming the files, when the pushed commit does not merge cleanly into the `origin/main` this checkout last fetched, because CI's `PR source admission` then runs no source check. That `main` may be stale, so it never refuses, and it is silent when `origin/main` is unknown |
| `npm run lint:check` | ~4s | a lint, formatting, or organize-imports error |
| `npm run proof:repo-governance` | ~4s | a governance-proof violation. Until 2026-09-14 this proof was composed only by `full:regression:raw`, which no pull-request, push or merge-queue trigger reaches, so two violations landed on `main` while the Nightly that owned them was itself red |
| `node scripts/check-prepush-push-range.mjs` | 1–5 s measured on a loaded host (load 18–29), no heavy-check slot | on the pushed commit, never the working tree: trailing whitespace or a conflict marker in the lines it adds since its merge base with `origin/main` (the merge queue's `git diff --check`, with the pushed commit's `.gitattributes`), or a raw `mkdtemp` in a test file above its baseline (#2421). It also *warns*, never refuses, about a new export no other module seems to name (`path: export NAME is not named in any other file`): a heuristic for the one unused-export case CI kept failing, which differs from CI's code-health gate, so it prints the gate's command (`node scripts/code-health-gate.mjs --base=<merge base>`) as the judge. When the pushed range merges commits the local `origin/main` does not contain (`origin/main` is behind, or a branch not yet on `main` was merged), whitespace and the ratchet are still judged and new exports are not checked. A step that cannot reach a verdict (no merge base, a diff too large to read, a crash) warns and lets the push through |
| `node scripts/check-prepush-docs-freshness.mjs` | 5–9 s measured on a loaded host | a recorded documentation review that `docs:freshness:check` reports stale, only when the pushed commit is the checked-out commit, the working tree has no uncommitted change and no untracked file under `docs/learn/review-ledger/`, and the branch has recorded a review (a pushed range adds or changes a file there): a note outdated by a later edit of a cited source, or a cited page missed. CI's `docs:truth:gate` refuses the same case in `docs:foundations:test`. Otherwise it warns and says why: no review recorded yet (so notes are not forced before the change is final), or uncommitted or untracked ledger changes. It does not check at all, and says so, when the pushed commit is not checked out, when there is no merge base, when the pushed range merges commits the local `origin/main` does not contain, or when the check crashes, is killed or times out. `STATION_DOCS_FRESHNESS=advisory git push` (the check's own mode variable) turns its stale entries into an advisory warning, so work in progress can be pushed; CI still runs the check and fails until the reviews are recorded. The list is capped at 30 entries; it prints the `docs:review:record` remedy |
| `node scripts/check-prepush-orchestration-transfer.mjs` | scoped; requires a verified baseline at the merge base when orchestration transport inputs change | missing, stale, incomplete, or over-budget two-baseline-plus-candidate transfer evidence |
| `node scripts/check-prepush-static-gates.mjs` | ~7s before the windowsHide ratchet (~4s) joined, and only when the push changes something these gates read | a UI-contract ratchet or content-gate violation (#3208), or a new child-process launch without `windowsHide` |
| `node scripts/check-prepush-sdk-barrel.mjs` | ~6s, and only when the push changes the SDK's own sources | an SDK export missing from the public barrel (#3629) |
| `node scripts/commit-message-gate.mjs --prepush-stdin` | instant | a commit subject in the push range that breaks the conventional grammar the forthcoming deploy-ledger changelog (station#4572) will generate from |

Repository-wide Veritas readiness and all typecheck lanes belong to hosted
`fast-checks-statics`, via `FAST_STATIC_COMMANDS` in
`scripts/run-ci-fast.mjs`. The `fast-checks` aggregate rejects any
non-success statics result, and the required `Source verification policy`
context reconciles that aggregate. Local pushes retain cheap lint/governance,
whitespace, test temp-dir, documentation-freshness and commit checks plus
scoped transfer, static and SDK checks; the new-export check only warns.

Of the steps this hook gained in 2026-11, three can refuse a push, each only
on a finding in the pushed commit, reported with a dedicated exit status (40):
trailing whitespace or a conflict marker, a raw `mkdtemp` in a test file, and
a stale recorded review on a clean checkout of the pushed commit. The
new-export check and the main-conflict check only warn, and so does every
step that cannot reach a verdict: the hook treats any other non-zero status
from those steps (a crash, a module that will not load, a kill, a timeout) as
a warning and continues, because `--no-verify` is not allowed here. Together
they added about 9–12 s to a push on a loaded host (push range 1–5 s,
documentation freshness 5–9 s). CI's full unused-export
verdict is not run on a push (a fallow audit costs 25-50s and queues for a
heavy-check slot); `npm run gate:for` prints the command that reproduces it,
`node scripts/code-health-gate.mjs --base=$(git merge-base origin/main HEAD)`.

**Why the push-range checks moved here.** Of 87 failed pull-request CI runs
between 2026-11-13 and 2026-11-15 (732 runs in all), 16 were the code-health
gate's unused-export blocker, up to 16 the raw-`mkdtemp` ratchet and 3 the
whitespace check, and at least 4 of the 10 `docs:truth:gate` failures were
review notes outdated by a later edit of a cited source, which
`docs:freshness:check` reports (the hook refuses that on a clean checkout of
the pushed commit once the branch records reviews, and warns otherwise). Each cost a push and a CI round trip. The 16
unused-export failures were nine distinct exports, every one new and named by
no other file, which is the case the push-range check now warns about from
Git in a second or two; four rounds of verification each found a different
way it refused code the gate accepts, so it never refuses. Running the gate itself on each push was tried and removed: it
doubled a source push's own work and, queued behind other worktrees' heavy
checks, turned pushes into minutes.

Biome 2.6 keeps Markdown and YAML formatting disabled in `biome.json`,
preserving their existing documentation and fixture formatting. The new
`noComponentHookFactories` and `usePlaywrightValidDescribeCallback` rules
are warnings during adoption. Their diagnostics include test-local React
harnesses, module-initialized component factories, Zod `.describe()` calls
and ordinary helpers named `describe`; review them before changing code.
Existing error-level lint rules remain enforced.
The accessibility ratchet recognizes the `recommended` and `all` group presets;
an explicit preset takes precedence over the deprecated `recommended` boolean.
When Biome ends without its `Checked N files` summary, the ratchet fails rather
than report a clean tree, and names how Biome ended (its exit status or signal)
with the last 20 lines it wrote.

The hook runs the transfer, static and SDK checks through
`node scripts/heavy-check-slot.mjs <label> <script>`. Each one first waits for a
[host heavy-check slot](testing.md#host-heavy-check-slots), so pushes from
several worktrees on one host queue instead of running together. If that wait
runs out, the push fails and the message names the holder.

Before the first check the hook resolves the bounded host-pressure liveness
scale once and exports it to every step (see the
[testing guide](testing.md#host-pressure-liveness-scale-3302)); it never changes
a budget or assertion.

A push that only adds clean merges of `origin/main` onto the tip the remote
already holds skips the push-range, documentation-freshness, transfer,
static-gate and SDK-barrel rows; the other four still run, and every row runs for a conflict
resolution, an edited merge or any new commit of the author's
([testing guide](testing.md#pre-push-orchestration-transfer-gate)).

The transfer check has a finite capture **liveness timeout**, which only bounds
a hung subprocess; it is not a performance score or a product budget. It
measures against a baseline at the merge base of `origin/main` and the
candidate, and finds a verified one by itself; when none exists, its refusal
prints the one command that prepares it (see the
[testing guide](testing.md#pre-push-orchestration-transfer-gate)):

```bash
npm run transfer:gate -- --prepare-baseline \
  --baseline-root ../station-worktrees/4294-transfer-baseline-<merge-base-sha> \
  --base <merge-base-sha> \
  && (cd ../station-worktrees/4294-transfer-baseline-<merge-base-sha> \
      && npm run dependencies:ci && npm run dependencies:verify)
npm run transfer:gate      # or push; STATION_TRANSFER_BASELINE_ROOT overrides the discovery
```

The capture reports are diagnostic transfer evidence, not completion evidence.
Nothing slower belongs here. `ci:fast` remains the bounded fifteen-minute feedback
lane. Local `full:regression` and the hosted exact-source qualification receipt
remain completion authorities; see [the release process](releasing.md). The hook holds
only the subset that is cheap enough to run on every push *and* whose failure
would otherwise land on `main` and stop every other lane.

**Why lint moved here.** It already existed inside `verify:static`, which
runs after the whole Vitest corpus — so it failed on whoever gated next rather
than on whoever caused the break, and each discovery cost a full gate cycle.
On 2026-08-17 `main` sat red for hours on one unformatted parameter list, with
two lanes independently applying the identical three-second fix because
neither could merge without carrying it (#3141).

**Why the UI bundle build left.** It used to run here too (#3033), which meant
`build:ui` ran three times per change: at push, in `fast-checks`, and on the
merge-queue candidate. With headroom ceilings
([#1703](https://github.com/kontourai/station/issues/1703)) the CI
enforcement is sufficient: `fast-checks-statics` builds the candidate and fails over
the ceiling, and the merge queue does the same on latest `main` plus the
change. A separate, non-required `ui-bundle-delta` job reports each
same-repository pull request's entry-bundle delta against its merge base,
in parallel with `fast-checks` and exiting zero once started, so growth
stays attributed to the change that added it. It does not run in the merge
queue, and under `STATION_PR_HEAVY_CHECKS=when-armed` it waits for arming.

### What the entry-bundle ceiling is for

The entry bundle contributes to cold-load download, parse and execution cost.
Actual waiting also depends on caches, connection speed, device and other work;
bundle bytes alone are not a latency measurement. The ceiling makes growth
visible while reuse and lazy loading are still practical choices.

The ceiling makes that cost visible at the moment an addition is made, while
reuse is still cheap to choose. When it reds, the question to ask first is not
*may I raise this* but *what does a user get for these bytes* — and then the
DRY questions, which are the ones that shrink the tree instead of relocating
it:

- Does a primitive for this already ship? (See
  [State primitives](../../src-ui/src/components/state/index.ts) and
  [Shell skeletons](../design/shell-skeletons.md) — both exist because bespoke
  duplicates accumulated.)
- Does the first paint need this surface, or can it lazy-load?
- Is there a dead sibling next to the live one to delete in the same change?

Raising is legitimate and it is the **last** step, after those. Raise to the
next round number (JS in steps of 10000, CSS 1000) that restores the headroom
(8 KB JS, 2 KB CSS). The lane that crosses the ceiling pays for growth since
the last raise, so say in the commit message what grew and what the bytes buy
— the next reader can only tell a considered raise from a reflexive one by
what you wrote down, and a reflexive one teaches every later lane that the
number is paperwork. `scripts/ui-bundle-budget.mjs` prints the same three
steps when it fails.

The ceilings are round numbers with headroom, not the tree's exact size
([#1703](https://github.com/kontourai/station/issues/1703)). The merge queue
builds latest `main` plus each queued pull request, so an exact ceiling failed
whichever entry built next on bytes a sibling had just merged. Headroom does
not hide growth: every build prints the measurement against the ceiling.

The delta report (`scripts/ui-bundle-delta-report.mjs`) scopes itself before
installing anything, so a pull request that touches no UI build input ends
in seconds. It measures only when the change touches something the UI build
reads: `src-ui/`, `src-shared/`,
the `packages/{sdk,connect,contracts}/src/` sources the Vite aliases resolve,
`vite.config.ts`, either manifest (a dependency bump moves the bundle without
touching a source file), `patches/`, or the budget script and its ceiling.
It builds both trees in observe mode, so an over-ceiling tree still yields a
number. When it cannot measure, it says so and why in a notice rather than
skipping silently. To measure your share locally, run
`STATION_UI_BUNDLE_DELTA_BASE=origin/main node scripts/ui-bundle-delta-report.mjs`
in your worktree: it installs and builds your branch there and the merge base
in a temporary worktree with its own `node_modules`, both in observe mode. Locally the
branch side is your working tree as it stands, uncommitted edits included.

A conflict on `scripts/ui-bundle-budget.json` is resolved by hand: keep the
higher of each field. There is deliberately no escape hatch for the ceiling
itself; a bypass would reproduce the unowned-raise loop #3033 exists to close.
Diagnose and fix the failing gate; do not bypass the pre-push hooks.

### Composition freshness belongs to the merge queue

The local hook intentionally does not require a branch to contain the current
`origin/main`. GitHub's required merge queue synthesizes the candidate from the
latest protected base and runs `fast-checks`, CodeQL, dependency review, and
the Windows portable floor, plus the stable iOS verification context, on that
exact merge-group SHA. A contributor can therefore push one reviewed branch
identity while `main` keeps moving; the server-side queue, not repeated local
merges and test runs, owns composition freshness.


## Code-health prevention

`ci:fast` runs [the code-health gate](../../scripts/code-health-gate.mjs) against
its explicit upstream base. Run it directly while implementing:

```bash
node scripts/code-health-gate.mjs --base=origin/main
```

The gate waits for a [host heavy-check slot](testing.md#host-heavy-check-slots)
however it is started, so concurrent runs from several worktrees run one after
the other.

The installed analyzer compares new findings with inherited findings. Newly
introduced unused exports and types block delivery; resolve their actual caller
or entrypoint/public-API contract before changing code or configuration. Class
members, dependencies, complexity, and clone candidates remain advisory because
their correctness depends on external interfaces, runtime loading, or design
intent. A high score based on estimated coverage does not establish a test gap.

Review new advisory findings in each PR and record a fix or an evidence-backed
reason to retain them. Do not extract pass-through wrappers to reduce a score.
The gate reads all three analyzer baselines from the immutable upstream commit,
so candidate rebaselining cannot hide its new findings. Missing or incomplete
analysis fails the gate. Required CI logs the result, writes a job summary, and
retains the full report in its fast-feedback artifact under `.kontourai/code-health/`.
Configured public APIs and entrypoints remain explicit analysis limits.

Track confirmed defects separately from advisory review, and distinguish new
findings from fixes and inherited debt. Freeze each repair batch for validation
and landing; later discoveries belong to a subsequent batch. These gates reduce
specific regressions; they cannot guarantee that new code has no defects.

### Memory budget

Each fallow child the gate and the audit runners start
([`runFallowAnalysis`](../../scripts/run-fallow-audit.mjs)) runs inside a
memory budget, so an analysis that outgrows it fails the gate rather than the
Station engine that started it (#5111). Peak resident memory of one fallow
process on this repository (about 11,000 source files), measured on 2026-11-17
with fallow 3.42:

| Run | 2 threads | 1 thread |
| --- | --- | --- |
| Gate audit (`--gate new-only`), base and head both uncached | 5.5 GiB | 2.9 GiB |
| Gate audit, head cached, base not cached (67–233 changed files) | 5.3 GiB | 3.7 GiB |
| Gate audit, both cached | 2.7 GiB | 2.7 GiB |
| Gate audit, 907 changed files, base not cached | killed at a 6 GiB cap | 3.8 GiB |
| Head only (`--gate all`), uncached | 2.9 GiB | 2.9 GiB |
| Whole tree (`npm run audit:code-health`): `health`, `dead-code`, `dupes`, uncached | 2.7, 1.4, 0.9 GiB | 2.7, 1.4, 0.9 GiB |

Changed-file count matters little (67 to 907 files moved the one-thread peak
from 3.7 to 3.8 GiB), and duplication is not the driver: an audit
with only its dupes analysis peaked lower than one with only health or dead
code. What doubles the peak is the base snapshot's analysis, which
`--gate new-only` needs to tell new findings from inherited ones. With two
threads fallow analyses the base and the head at the same time; with one, in
turn. Fallow caches a base's analysis under `.fallow/cache/`, so the cold case
is the first audit against a new merge base: a fresh worktree, or after
`main` moves.

So off CI every fallow child runs with `--threads 1`. Reports are identical to
the two-thread ones apart from their run id; a cold audit takes about 1.7
times as long (114 s measured on a loaded host), so the per-command watchdog is
240 s. The changed-file scope and every sub-analysis stay as they were:
skipping the base pass (`--gate all`) or dropping an analysis would change the
verdict.

The budget is `STATION_FALLOW_MEMORY_MAX_MIB`, default 5120 MiB: the largest
measured single-thread peak (3.8 GiB) with about 1.2 GiB of headroom for
repository growth and the scope's page cache, which the kernel reclaims
before it kills anything. On Linux with a systemd user manager, the
child runs in its own transient user scope (`systemd-run --user --scope`,
`MemoryMax` set to the budget, no swap, `OOMPolicy=continue`). That scope sits
under the user manager, outside the caller's own scope, so the caller is no
longer charged for the analyzer. When the kernel kills the analyzer at the
budget, the gate exits 2 with `code-health gate needs more than N MiB; fallow
audit was OOM-killed at its memory budget`. A run that finishes logs the
scope's memory peak to stderr; that peak counts reclaimable file cache (the
base checkout and the files read), so it can sit at the budget with no kill. A budget below
1024 MiB, or one that is not a whole number, is refused before anything runs.

Where no capped scope can start (macOS, Windows, Linux without a user manager),
the child runs uncapped and the runner prints a warning naming why. Hosted CI
(`GITHUB_ACTIONS=true`) runs uncapped, silently and with two threads, as
before: each runner is a single tenant. The raw `npm run fallow*` package
scripts run the analyzer directly, without the budget.

### Dead-code ceiling

The baselines above list inherited findings by name, so a finding that moves
or is renamed can look new. The dead-code ceiling holds counts instead.
[`scripts/fallow-dead-code-ceiling.json`](../../scripts/fallow-dead-code-ceiling.json)
records how many findings `fallow dead-code` reports in each category and in
total. It records no file paths, symbols or line numbers.

```bash
npm run fallow:ceiling
```

The command analyzes the whole tree, which takes about 25 seconds. A category
fails (exit 1) only when its count exceeds the recorded count plus headroom of
`max(3, ceil(5% of the recorded count))`. The headroom absorbs findings that
pull requests add independently and that land together in one merge-queue
batch, so the next pull request is not failed for growth it did not cause. A
category the ceiling has never recorded is held at zero plus headroom. Moving
or editing code that keeps its findings never fails the check. A lower count
is printed with a reminder to record it. If the analysis cannot run or its
report has no counts, the command exits 2 and prints `NOT_VERIFIED`. It never
reports a pass in that case.

The ceiling is advisory until it is promoted through the
[proof-family promotion workflow](../strategy/veritas/proof-family-promotion-workflow.md).

To update the baselines and the ceiling, run one command on a clean, current
`main`, or after merging `main` into your branch:

```bash
npm run fallow:baseline
```

It rewrites the three analyzer baselines in `fallow-baselines/` and then the
ceiling. Commit the four files together, in their own commit, and state in the
pull request why the counts changed. Raising a ceiling to admit new dead code
needs the same justification as any other new finding.

Regenerate after every fallow upgrade. The command accepts only the report
kind and schema version it was written for. It refuses, with `NOT_VERIFIED`,
a report whose counts disagree with its findings, whose total is not the sum
of its categories, or that lacks a category the ceiling records. A category
that fallow renames or adds is held at zero plus 3, so it can fail a run whose
total did not change until the ceiling is regenerated.

## Local CI pipeline

Use `npm run gate:for -- <paths>` before editing and run its focused checks.
Push through the normal scoped gates; required hosted PR checks own broad
integration feedback, and the merge queue verifies the latest-main composition.
The [testing guide](testing.md#what-counts-as-tested) owns local diagnosis,
the full schedule and promotion-completion requirements.

The push hook clears repository-local Git routing variables before launching
checks, while preserving global/system configuration. This lets a check inspect
its intended subdirectory or temporary repository instead of inheriting the
pushed repository's index and Git directory. A failed check still rejects the push.

In hosted CI, `fast-checks` (reconciled by the required `Source verification
policy` context; the ruleset lists required contexts) aggregates the affected-test plan, zero to four planned
shards, and `fast-checks-statics`. It checks both job outcomes and receipts
bound to the plan and source revision. Local `ci:fast` still runs its whole
bounded lane; `STATION_CI_FAST_SCOPE=statics` is the hosted split's explicit
scope, not a substitute for local affected-test evidence.

Documentation checks run on every fast-checks path. The fixed checks include
CLI parity, source references, links, public-content hygiene, generated issue
lifecycle content and contract examples. Veritas readiness also selects the
full `docs:truth:gate` as required evidence, including recorded review
freshness for source-only changes: a stale record blocks when the change's own
diff touches it ([keep reviews fresh](documentation-review-ledger.md#keep-reviews-fresh)).
The separate **Repository source scans** job remains non-required and only
reports freshness. Merge-queue static verification also includes the
documentation truth gate, where freshness is advisory. These checks catch stale
recorded inputs and structural defects; they cannot establish prose accuracy or
discover every missing dependency. Follow the
[maintenance guide](documentation.md) to review the affected claims.

## Biome Lint

Start with a scoped read-only check:

```bash
node scripts/run-biome.mjs check <affected-paths>
```

Use `--write` for supported safe fixes, then inspect the diff and rerun the
read-only check. `--unsafe` explicitly enables potentially unsafe fixes; it is
not a synonym for safe autofix. Do not accept dependency-array, API or behavior
changes solely because a formatter proposed them.

Common gotchas:
- `noUnusedImports` — JSX-transform and type imports depend on the owning tsconfig; inspect that configuration and actual runtime usage before removing an import.
- `useExhaustiveDependencies` — verify deps are correct before accepting auto-fix.
- `noUnusedVariables` / `noUnusedFunctionParameters` — prefix with `_` if intentionally unused.

## Route Typing

The schema-middleware route family uses helpers exported from
`src-server/routes/schemas/schemas.ts`:
- `getBody(c)` instead of `c.get('body')` — avoids Hono's `unknown` return type
- `param(c, 'name')` instead of `c.req.param('name')` — returns `string` (throws 400 if missing)

Use those helpers when the route's schema middleware owns that body/parameter
contract. Existing routes also parse bounded requests and parameters directly;
this is not universal adoption. Do not replace an owner's validation or typed
refusal with a helper name alone. Follow its real route and caller tests.

## Clean Core

Keep private organization assumptions out of general product behavior: employee
identifiers, customer endpoints and internal tool names must not become
unconfigurable defaults. Named engine adapters, public product endpoints and
explicit integration contracts legitimately identify their owners; isolate
those dependencies at their configured boundary rather than claiming the core
contains no vendor names. Inspect the diff for private data and accidental
coupling. A default implementation still needs its declared prerequisites;
“works for every user out of the box” is not a verification result.

## Smell: a default that decides

Not all fallbacks are equal. The dangerous shape is a default that turns **"I
don't know"** into a confident, plausible, usually-permissive value **at a
decision point**.

The question to answer, every time you write or review one:

> Does this default participate in a **decision**, or only in **display**?

A display default degrades legibly — a slightly wrong label, visible to whoever
looks. A decision default launders absence into permission, and permission is
exactly the thing nobody can see is wrong.

Real instances, all found the hard way:

- `prerequisites ?? []` — "nothing required is missing" → **ready**. A candidate
  we could not verify counted as verified.
- `settings.enabled ?? true` — "no setting" → **enabled**, so a connection the
  user had switched off still reported chat-ready.
- `notification.actions ?? []` — an action-less approval that still suppressed
  the composer, leaving a session with no way to respond at all.
- `query.data?.items ?? []` — a *fetch failure* renders identically to "nothing
  needs your attention."
- `adapter.metadata.runtimeId ?? adapter.provider` — a well-formed key that
  matched nothing, because the real key is `${provider}-runtime`.

Contrast the harmless ones: `?? UNKNOWN_EXTERNAL_ENGINE_MATRIX` defaults to
something *named* as unknown; `?? 'Active'` is a label. Both stay honest.

Optional chaining compounds it. In
`deps.getAppConfig?.()?.agentConnections?.[id]?.enabled ?? true` there are four
places to become `undefined` before the default — a renamed field, a missing
dep, the wrong key — and every one yields the same answer as *the user didn't
disable it*. The expression cannot tell **not disabled** from **couldn't look**.

**The test.** Inject the unknown case — remove the method, drop the key, fail
the fetch — and check the result is distinguishable from the permissive case.
If it isn't, the default is deciding on evidence it does not have.

**The fix is usually to refuse rather than guess.** This codebase already has
the idiom:

```ts
// A candidate we cannot actually verify must never count as ready.
if (typeof adapter.getPrerequisites !== 'function') continue;
```

Skip, throw, or surface the uncertainty. Reserve `??` for cases where absence
genuinely has a correct meaning, and say so in a comment when it does.

## Smell: guards that defend the recoverable thing

Sibling to the above. That one asks whether a default *decides*; this one asks
whether a safety check defends **the state that cannot be got back**.

The question, for any code that deletes, overwrites, truncates, or expires:

> Which state here is irrecoverable, and does a guard defend **that** — or only
> the state that was easiest to check?

The failure is not a missing guard. It is a *plausible set* of guards, each
individually sensible, that collectively defend data which was never at risk.
Nobody reviewing the list notices, because every entry on it is defensible.

**The instance that produced this section** (station#3205). A tool that removes
finished git worktrees guarded on: not the primary checkout, not the current
worktree, branch fully merged, no unpushed commits, no modified tracked files,
nothing touched recently. Six guards, all reasonable, all tested.

But `git worktree remove` **never deletes the branch**, so committed work always
survives removal regardless of any of them. It also *refuses outright* on a
worktree containing modified or untracked files — and `--force`, which the tool
passed, is precisely what converts that refusal into deletion. So uncommitted
state was the entire loss surface, and of that, untracked files — the only bytes
that exist in exactly one place on earth — were **deliberately excluded**, with
a comment justifying it and a test named `untracked files are reported but never
keep a worktree alive`.

Five of six guards defended data that was already safe in git. The sixth
category was the one that could not be recovered, and it was the one waved
through. An independent review proved it end to end: git refused, `--force`
deleted a hand-written source file, nothing recoverable.

(That is the *reviewed* version, not the shipped one — the tool now keeps any
worktree holding an untracked file git is not ignoring, and no longer passes
`--force`. The point worth keeping is that the original guard list looked
complete to its author and to its tests.)

**How to run the check.**

1. Name the irrecoverable state explicitly — the bytes with no second copy.
   Not "user data", not "their work": *which* bytes, and where else they exist.
2. Ask what the platform already does for you. `git worktree remove` refuses;
   `rm` does not; a `DELETE` with a foreign key may refuse; a soft delete does
   not. A guard that duplicates a refusal you then suppress is worse than no
   guard, because it reads as protection.
3. Treat **suppression flags as the guard's real subject**. `--force`,
   `{ force: true }`, `ON DELETE CASCADE`, `--no-verify` — whatever silences the
   platform's own objection is where the danger concentrates. Justify it
   separately from the feature.
4. Prove the rejection path executes. Every guard in that tool was asserted only
   in prose; eight injections against the I/O layer — including "the primary
   checkout becomes removable" and three error handlers flipped to fail *open* —
   were caught by exactly zero of sixteen passing tests, because the tests only
   ever exercised the pure decision function.

**Fail closed on what you could not determine.** An unreadable directory, a ref
that will not resolve, a probe that errored: each must keep the thing, not clear
it. A `catch` that returns a clean zero has decided on evidence it does not have
— the same defect as a default that decides, wearing safety gear.

## Push & Monitor

Push only the branch and remote authorized for the task, after its required
local checks. A configured remote is not publication permission. Do not bypass
pre-push checks. Follow
[Landing a pull request](development.md#landing-a-pull-request) for the merge
queue and [AGENTS.md](../../AGENTS.md) for handoff rules; do not manually merge
or arm another lane's pull request.
For the merge queue, arm and confirm once, then stop polling it; the pull
request is done only when it reads `MERGED`. When checking
CI, inspect the actual job and failure before deciding what to rerun; silence is
not success. Follow the task's required verification through its real outcome.
Focused checks remain diagnostic; the hosted exact-revision completion receipt
has its separate scope in [testing](testing.md).
