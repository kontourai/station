# Testing Guide

## Philosophy

- **Unit tests** for business logic (services, utilities, pure functions)
- **Integration tests** for HTTP routes (Hono `app.request()`)
- **E2E tests** for user journeys (Playwright)

## Conventions

| Type | Framework | Pattern | Location |
|---|---|---|---|
| Unit / Integration | Vitest | `*.test.ts` | `__tests__/` colocated with source |
| E2E | Playwright | `*.spec.ts` | `tests/` at project root |
| Test utilities | — | named exports | `__test-utils__/` colocated with source |

## Running Tests

### Default implementation loop

```bash
npm run test:changed -- --base=origin/main --explain
```

Read the selector's bounded terminal summary, then run its exact focused Vitest
file or named public lane. The full changed paths, reasons, and commands live
in `.kontourai/test-impact/changed-selection.json`; terminal output names only
the selected targets and lanes so it stays useful in an agent transcript.
Failed assertion names and excerpts are retained separately in
`.kontourai/test-impact/changed-diagnostics.json` before Vitest's temporary JSON
report is removed. That diagnostic is count-bounded, byte-bounded, redacted,
and digest-bound by the changed-verification receipt. A failing run explicitly
marks incomplete identities instead of presenting aggregate counts as a
diagnosable bundle, and `incompleteReasons` names every shortfall in words
rather than leaving a bare `complete: false`.

Test outcomes are read from Vitest's own report, never derived by subtraction.
`executed` counts what actually ran (`passed + failed`); a deliberate skip
(`describe.skipIf`) and a `test.todo` are itemised as `skipped` and `todo`
instead of being attributed to failures. That distinction is the point: a
deliberate skip is accounted for, while a *silent* non-execution is not. Any
outcome the report leaves unaccounted for, any overlapping tally, and any test
Vitest reports as still running or queued is a `parser_error`, and a selection
in which every test declined to run escalates to `test-full` rather than
reading clean. A skipped-only run still cannot pass: the receipt requires
`passed === executed` with `executed > 0`. Pair it with the affected `tsc` project and Biome paths. A
changed receipt is diagnostic: with `--explain`, exit 0 only confirms an
explanation was emitted; without it, exit 0 is a completed focused result. Exit 3 is
provisional/deferred and must name the next lane; neither replaces final
completion evidence. Do not repeatedly run broad suites during edits. The
coordinator exposes active leases and capacity through
`node scripts/run-verification.mjs status`, and prints bounded summaries whose
redacted raw output is digest-addressed under `.kontourai/verification-output/`.

Run `npm run ci:fast` for bounded (twelve-minute) per-push feedback after focused
evidence: it runs base-pinned affected Vitest tests followed by fixed bounded
invariants, not the global static/build chain or full corpus. After focused
implementation proof, freeze the worktree and use
`npm run full:regression:submit` to hand completion off. Never use shell
polling, background, or relaunch loops. Do not edit or remove a worktree with a
live handoff; inspect it with
`node scripts/run-verification.mjs submit-status <request-key>`. Synchronous
`npm run full:regression` remains the sole evidence command and final consumer
of the canonical receipt. Its coordinated lane exit 0 may mean executed,
joined, or reused. The full Vitest corpus is phase-attested there, separately
from the fast feedback loop.

The `ci:fast` owner receipt requires a redacted, digest-addressed copy of the
changed-test diagnostic under `.kontourai/verification-output/`. If the stable
diagnostic is missing or unsafe to copy, the receipt fails closed as an
infrastructure error; joined and reused consumers inherit the owner's verified
artifact binding.

### Available escalation lanes

```bash
npm test                          # alias of test:prepush (pre-push floor); not an edit loop, not completion evidence
npm run test:prepush:repeat       # 20 attempts + local pass-rate/timing receipt
npm run test:windows:portable     # Windows portable floor; not full parity (#1420)
npm run test:load-reliability     # dry-only plan for the opt-in local stress lane
npm run test:full                 # resource-profiled complete Vitest corpus (needs install:playwright — see below)
npm run verify:local              # resolve Node 24, pin it for children, run verify:static
npm run verify:static             # lint, ratchets, and typecheck
npm run verify                    # broad diagnostic escalation when explicitly required
npm run test:focused -- <file...> # pinned single-file runs (never ad hoc `npx vitest` — it can resolve a sibling worktree's config; see AGENTS.md)
npm run test:coverage             # with coverage report
npm run install:playwright        # install repo-local Chromium once (E2E specs AND test:full's BannerHost touch-target check)
npm run install:playwright:ci     # install Chromium plus OS dependencies for CI runners
npm run test:e2e:product          # promoted product Playwright suite via ./station temp-home instance
npm run test:e2e:starter-clean-install  # fresh-home Starter journey; inherited telemetry is disabled
npm run test:e2e:smoke-live       # live app smoke via ./station temp-home instance
npm run test:e2e:extended         # non-default extended Playwright bucket
npm run test:e2e:screenshot       # screenshot/visual artifact bucket
npm run test:e2e:screenshot -- --screens=home,agents  # targeted capture — only these SCREENS entries
npm run screenshot:baseline       # write tests/screenshots.baseline.json from a completed gallery run
npm run screenshot:diff           # compare a completed gallery run against the committed baseline
npm run verify:e2e:full           # public coordinated E2E escalation across all buckets plus Android
npm run sync:e2e:latest            # install newest compatible CI Extended E2E projection locally
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright test               # e2e
npm run test:e2e:product -- --spec=tests/foo.spec.ts          # focused spec with the canonical lifecycle
npm run test:e2e:product -- --spec=tests/foo.spec.ts --grep='delegated work'  # focused test name
npm run test:connected-agents         # focused connected-agents server suite
```

### Latest E2E screenshot evidence

Every completed `verify:e2e:full` run atomically replaces the ignored latest E2E projection
at `.kontourai/e2e-latest/`. Start with
`.kontourai/e2e-latest/manifest.json` for its run ID, revision, per-bucket
PASS/FAIL/EMPTY verdicts, and bounded inventory; open
`.kontourai/e2e-latest/index.html` only to inspect an individual screenshot. A failure or empty
screenshot bucket replaces stale green evidence truthfully. CI artifacts cannot
modify a checkout themselves: run `npm run sync:e2e:latest` (or pass
`-- --run-id <id>` / `-- --status <conclusion>`) to download and validate the
latest compatible completed CI Extended artifact. Never paste the directory's
image bytes or broad logs into agent context.

The Windows portable floor is deliberately not named or treated as
`test:full`. It combines the physically proven pre-push tier with the portable
OpenSSH argv, cleanup, and broken-pipe contracts. Full Windows Vitest parity
remains failing closed under issue #1420; do not add exclusions or
`continue-on-error` to relabel that gap green.

Every pull request runs that bounded floor as the stable
`Windows PR portable floor` check. Its workflow is read from the protected base
through `pull_request_target`, checks out the exact candidate repository and
SHA, and executes on an ephemeral GitHub-hosted Windows runner with read-only
permissions and no persisted credentials. Forks run the same proof; they are
not silently converted into a skipped required check. The physical desktop-win
workflow remains a separate post-merge hardware-reference diagnostic and does
not replace the PR gate.

### Targeted screenshot capture and the baseline diff loop (station#4464)

`tests/screenshots.spec.ts`'s `SCREENS` list can be captured as a named
subset instead of the full gallery: set `STATION_E2E_SCREENS` to a
comma-separated list of `SCREENS[].name` values, or pass `--screens=` through
the runner. **These are not interchangeable.** Through
`npm run test:e2e:screenshot`, only `--screens=` works —
`npm run test:e2e:screenshot -- --screens=home,agents`. `run-e2e-suite.mjs`
deliberately clears any ambient `STATION_E2E_SCREENS` on every spawned
Playwright process with an explicit `undefined` (not a conditional spread),
specifically so a stray env var left over in a shell can never silently
partial an unflagged full run — so
`STATION_E2E_SCREENS=home,agents npm run test:e2e:screenshot` is **not**
equivalent; it silently captures the full gallery. `STATION_E2E_SCREENS` is
honored only by a bare, direct `npx playwright test tests/screenshots.spec.ts`
invocation that bypasses the runner entirely (no `run-e2e-suite.mjs` process
in between to clear it) — e.g.
`STATION_E2E_SCREENS=home,agents npx playwright test tests/screenshots.spec.ts`.
An unknown screen name fails the run loudly rather than silently capturing
nothing. `gallery/capture.json` always records the requested subset under
`selection` (`null` for a full run), so a partial gallery can never be read
as full coverage downstream.

`scripts/screenshot-diff.mjs` is the comparator, exposed as two npm scripts.
Comparison is **exact**, not perceptual — no threshold, no hash-distance
tolerance. An earlier perceptual-hash design was rejected: re-run noise on
live-data screens reached far past any real regression signal, because two
always-visible chrome regions (the header connection chip, the sidebar build
stamp) and unmocked live data made even a pixel-identical rebuild read as
"changed". The fix belongs in the capture, not a threshold —
`tests/screenshots.spec.ts` freezes CSS animations, CSS-hides every region
whose content is genuinely environment/timing-dependent rather than a
property of the screen under test (see `hideVolatileChrome`'s doc comment
for the full, occasionally-surprising list — a hidden connection-status chip
still shifted its siblings until it was switched from `visibility: hidden`
to `display: none`), waits out shared loading skeletons, and mocks the
handful of live endpoints (resource posture, sessions, action-operations,
Connections-hub engine detection) that otherwise raced the fixed settle
window — so that two captures of the identical build decode to identical
pixels and exact comparison is strictly simpler, and strictly more
trustworthy, than any threshold.

The screenshot bucket runs under its own `playwright.config.ts` project
(`screenshot`, matched to `tests/screenshots.spec.ts` only — every other spec
still runs under the plain `chromium` project) with deterministic-rendering
Chromium launch flags (`--force-color-profile=srgb`,
`--force-device-scale-factor=1`, `--disable-lcd-text`,
`--font-render-hinting=none`, `--hide-scrollbars`, `--disable-partial-raster`,
`--disable-skia-runtime-opts`, `--use-gl=angle --use-angle=swiftshader`) — a
defensive pin against a future Chromium/host default change, since headless
Chromium on the measured host already rasterizes through software
SwiftShader/Vulkan by default. What had been diagnosed as residual
sub-pixel rasterization jitter (station#4464) turned out, on closer
inspection of the diff images, to be a genuine content race instead: the
Connections hub's shared tab-bar badges (`useIntegrationsQuery` /
`GET /integrations`, `useGlobalKnowledgeStatusQuery` /
`GET /api/knowledge/status`) can still be mid-fetch when any of the five
Connections-hub screens is shot, because TanStack Query's default
`staleTime: 0` re-fetches on every fresh mount rather than trusting an
earlier screen's cached value. `armConnectionsHubBadgeSettle` in
`tests/screenshots.spec.ts` arms a `page.waitForResponse` for both endpoints
before each of those five screens' `page.goto` and awaits it before the
shot. With both fixes in place, repeated full captures compared bit-for-bit
identical across every screen, including `motion-reduced-notification`
(previously the one hand-marked `volatile: true` exception) — its
`volatile` marker has been removed.

Baseline artifacts (both committed):

- `tests/screenshots.baseline.json` — small, diffable manifest: per screen,
  its dimensions and the sha256 of its **decoded RGBA pixel buffer** (not
  the PNG bytes — immune to encoder/compression drift). This is the fast
  path: an unchanged screen never touches its reference image.
- `tests/screenshots.baseline/<name>.png` — the reference image itself,
  read only when a screen's hash disagrees, to compute and localize exactly
  which pixels moved. Committing the full companion PNG set costs ~2.6MB per
  regeneration — accepted as the price of localizing a real regression to
  exact pixels instead of only knowing a screen's hash changed.

- `npm run screenshot:baseline` reads a completed `gallery/capture.json` +
  its PNGs and writes both baseline artifacts. It refuses to write from a
  partial or not-fully-successful capture unless `--allow-partial` is
  passed, in which case it merges in only the screens that were actually
  captured, leaving the rest of the manifest untouched. A genuinely full,
  all-ok run instead **replaces** the manifest outright (dropping any
  screen no longer captured) — except a screen hand-marked `volatile: true`
  (see below), which a replace run carries forward untouched rather than
  overwriting with a freshly computed hash. The manifest carries no
  timestamps or other non-deterministic content: identical pixels always
  produce a byte-identical file.
- `npm run screenshot:diff` recomputes the hash over a current gallery and
  compares each screen against the baseline. A dimension mismatch or a
  sha256 mismatch is `changed`, and localizes the regression: it decodes
  both images, counts the differing pixels, and writes a visual diff PNG
  (changed pixels in red, everything else dimmed for context) to
  `gallery/diffs/<name>.diff.png`, printing that path. `--screens=a,b`
  narrows the comparison to exactly those names — validity is membership in
  the **current capture** (not a union with the baseline: a name the
  baseline knows about but this run never captured is not a valid request),
  and an unknown name fails the run loudly rather than silently resolving
  to an exit-0 "missing" row. A `!ok` capture entry is a **failure**
  (`capture-failed`), never merely informational. An **unscoped** diff over
  a **partial** gallery (`capture.json`'s `selection` is non-null) is
  refused outright — it would otherwise silently compare only the captured
  subset while still printing "OK" as though the whole gallery had been
  checked; pass the matching `--screens=` explicitly instead. The final
  line never says OK unless every screen actually compared was unchanged;
  it prints exact comparison/changed/new/skipped-volatile/capture-failed/
  missing-from-gallery counts either way. Exit 0 only when nothing failed.
- A screen that resists determinism after real effort (mocking, CSS-hiding,
  settle waits) can be hand-marked `volatile: true` (with a `reason`) in
  the committed baseline — a last resort, not a first move. `screenshot:diff`
  then skips it **loudly** (named in the table as `skipped-volatile`),
  never silently folding it into "unchanged" and never failing the run over
  it.

Typical loop: `npm run test:e2e:screenshot -- --screens=<touched screens>`,
then `npm run screenshot:diff -- --screens=<touched screens>` to see whether
the change moved any pixels, without paying for a full 29-screen run or
committing a new baseline until the change is intentional.

### Browser-test admission and maintenance

Playwright is reserved for claims that require a real browser, packaged
UI/runtime boundary, or end-to-end user journey. Put API-only contracts and
mock-response checks in route, service, SDK, or integration tests. Each browser
test must fail when its required target is absent: conditional green exits,
`expect(true)`, diagnostic-only specs, and silent optional locators are not
coverage. Prefer semantic locators, short surface-owned journeys, and bounded
action timeouts. A fixed sleep requires an explicit manifest exception and a
reason the state cannot be observed directly.

When a Playwright surface changes, classify its existing checks as **keep**,
**split**, **move down with replacement**, or **remove as vacuous**. Moving a
claim down is complete only after equivalent lower-layer coverage exists;
deleting a meaningful regression check merely to shorten the suite is not.
Every retained spec stays assigned to exactly one bucket in
`tests/e2e-manifest.mjs`.

Use `npm run verify:local` only when the selector or final native-risk surface
requires it. The
launcher resolves a Node 24 executable, reports its absolute path and version
once, prepends its bin directory to `PATH`, and then runs `verify:static` so
Vitest fixtures and every other child command inherit the same runtime. Set
`STATION_NODE=/absolute/path/to/node` as an explicit trust override when the
supported executable is installed outside the common mise, nvm, fnm, Volta,
Homebrew, and Windows manager locations.

`npm run verify:static` is self-bootstrapping after a fresh
`npm run dependencies:ci`. Once the
Node 24 runtime gate passes, it first compares every exact-pinned
`@kontourai/*` dependency with the version installed in `node_modules` and
fails before builds, lint, typechecks, or tests when they differ. It then cleans
and rebuilds only
`@kontourai/station-connect`, whose published `dist` types are imported by the
root UI typecheck. Do not add a manual `npm run build:connect` prerequisite;
the clean rebuild is part of the gate so stale generated output cannot satisfy
the typecheck accidentally.

Fresh linked worktrees get the pinned dependency set through
`npm run dependencies:ci`, so drift
should not occur there. The shared main checkout is the drift-prone surface:
pulling a package pin does not update its existing `node_modules`. Run
`npm run dependencies:install` there after a pull when the dependency-drift gate or
`station doctor` reports a pinned-versus-installed mismatch.

`npm run dependencies:ci` does **not** provision Playwright browsers. The
runner applies Station's approved patch step explicitly; it does not trust a
root `postinstall` hook. `node_modules/playwright/package.json` declares no
install script of its own. `npm run test:full` and `npm run full:regression`'s
ordinary Vitest corpus include `BannerHost.touch-target.test.tsx`
(station#3453), which launches a real repo-local Chromium to measure
cascade-resolved layout — not an E2E spec, so it is easy to assume it needs
nothing beyond `npm run dependencies:ci`. It does not silently skip when the browser is
missing (this repo's "no conditional green exits" browser-test doctrine
applies to it too): it fails loud, naming the missing precondition and the
fix. Run `npm run install:playwright` once per fresh worktree, before either
lane, to avoid that failure. CI's `full-regression` job in `.github/workflows/
ci.yml` runs it for the same reason.

`npm test` is intentionally the fast blocking tier used by generic pre-push
hooks. Its checked-in manifest covers repository guardrails, public contracts,
authentication/connection boundaries, orchestration state, and core
mobile/onboarding behavior while excluding real-process, installer,
wall-clock, browser, and dogfood-reconcile classes. It writes mode-0600 local
receipts to `.kontourai/test-reliability/prepush-latest.json`; the 20-run lane
uses `prepush-repeat-latest.json` so later single runs do not erase its evidence.
Receipts are atomically replaced with mode 0600 and bind the result to matching
pre/post Git HEAD, bounded dirty-workspace digest, manifest digest, exact file
list, runtime, and worker arguments; workspace drift or launch failure is
reported separately from test failures.
Use `npm run test:prepush:repeat` to measure 20 consecutive attempts. This tier
is diagnostic and does not replace the final `npm run full:regression` receipt.

### Shared Vitest worker policy

Ordinary and focused Vitest invocations inherit the checked-in four-worker
ceiling. `npm run test:full` discovers the complete corpus, validates exact and
disjoint ownership through `scripts/vitest-resource-manifest.mjs`, then runs
five resource groups in order: ordinary isolated files at four workers,
independent process-heavy files at two isolated fork workers, host-global
process-exclusive files at one worker with file parallelism disabled,
shared-output files under the same serial constraint, and dogfood-reconcile
files under their historical serial constraint. Direct child-process use
requires a bounded process group, not global serialization: two workers keep
aggregate load below the ordinary pool while independent temp-dir and
dynamically allocated-port fixtures overlap. A test that owns host-global
leases, fencing, or coordinator capacity belongs in process-exclusive. New
direct child-process users fail the manifest gate until deliberately
classified. Tests that write shared repo paths belong in shared-output and
their paths must be declared by the enclosing verification lane.

Pre-push and coverage remain one-worker evidence lanes. Coverage merging has a
different correctness contract, and pre-push is already short while its
host-wide coordinator weight allows independent worktrees to make progress.
A local `--maxWorkers` option is appropriate for a narrower focused invocation;
do not use it to bypass the resource manifest or increase an authoritative
lane's concurrency.

The opt-in load-reliability lane below remains host-local evidence only. It
does not make the shared default a CI or hosted-CI authority, and it does not
permit weakening the one-worker delivery lanes.

### Fast feedback and canonical completion scheduling

<!-- station:verification-scheduling:start -->
This scheduling contract is rendered from `scripts/verification-lanes.mjs`; do not hand-maintain lane scope, phase weights, or commands here.

| Lane | Command | Trigger | Expected scope | Resource class | Evidence | Invalidated by |
| --- | --- | --- | --- | --- | --- | --- |
| `full-regression` | `npm run full:regression` | pre-merge / final completion | repo-governance + sdk/app builds + static gates + full Vitest corpus | completion gate | completion (trust floor) | command only |
| `ci-fast` | `npm run ci:fast` | per-push / bounded feedback | base-pinned affected Vitest tests + fixed static invariants (≤12m) | static / integration | diagnostic | test-impact manifest |
| `test-changed` | `npm run test:changed` | per-edit local feedback | Vitest related imports + dynamic-boundary edges | changed-scope selector | diagnostic | test-impact manifest |
| `prepush` | `npm run test:prepush` | pre-push / focused floor | prepare:verify-static + prepush test tier | focused floor | diagnostic | prepush test-group manifest |
| `test-full` | `npm run test:full` | diagnostic full corpus | resource-profiled Vitest corpus + dogfood-reconcile | static / integration | diagnostic | command only |
| `test-coverage` | `npm run test:coverage` | explicit coverage / risk | serialized coverage corpus + dogfood-reconcile | static / integration | diagnostic | command only |
| `verify-static` | `npm run verify:static` | diagnostic static gate | node-runtime, naming, UI-contract, platform, workflow ratchets, lint, typecheck | static / integration | diagnostic | command only |
| `verify-local` | `npm run verify:local` | diagnostic native / local | verify:static + desktop Rust + mobile Cargo compile | static / integration | diagnostic | command only |
| `verify-e2e-full` | `npm run verify:e2e:full` | diagnostic full E2E | product, first-run, starter-clean-install, smoke-live, extended, screenshot, Android buckets | full E2E | diagnostic | E2E spec→bucket assignment |

`ci:fast` is diagnostic bounded feedback: it runs the base-pinned affected Vitest selection followed only by fixed runtime, lockfile, workflow, verification-policy, and **typecheck** invariants—not the global static/build chain or the full corpus. The typecheck invariant runs every `typecheck:*` lane through `scripts/typecheck-aggregate.mjs` (station#4273), preceded by `build:connect` because `typecheck:ui` resolves `@kontourai/station-connect` through its `dist`. It was added because the lane was previously uncovered per-PR: a red `main` displayed green on every contributor's checks, twice in 24 hours. Its 20-unit reservation overlaps the 80-unit `test-full-ordinary` phase so feedback can admit while completion work runs.

`full-regression` admits these cataloged phases independently; the outer receipt is completion evidence only after every phase succeeds:
- `repo-governance` — 20-unit host reservation; 5-minute execution deadline.
- `sdk-builds` — 50-unit host reservation; 10-minute execution deadline.
- `verify-static` — 60-unit host reservation; 15-minute execution deadline.
- `test-full-ordinary` — 80-unit host reservation; 12-minute execution deadline.
- `test-full-process-heavy` — 60-unit host reservation; 10-minute execution deadline.
- `test-full-process-exclusive` — 60-unit host reservation; 4-minute execution deadline.
- `test-full-shared-output` — 60-unit host reservation; 4-minute execution deadline.
- `test-full-dogfood-reconcile` — 60-unit host reservation; 5-minute execution deadline.
- `app-builds` — 60-unit host reservation; 10-minute execution deadline.

Checkpoint resume is deliberately narrow: rerun the same unchanged `npm run full:regression` request and retain `.kontourai/verification-phase-records/<request-key>/`. The coordinator reuses only a parseable request-and-phase-bound checkpoint with a completed zero-exit pass, explicit non-truncated/non-invalid-UTF-8 output, and successful or not-required cleanup with zero surviving owned children. Failed, timed-out, truncated, invalid-UTF-8, malformed, mismatched, or cleanup-bad checkpoints rerun; a changed request never resumes them.

`verification:policy:gate` remains a deterministic default readiness check, not required `repo-governance` evidence: it is already a bounded `ci:fast` invariant, while changing required-evidence routing is a separate human-governed `.veritas` decision. The existing repo-map contract test enforces that boundary.
<!-- station:verification-scheduling:end -->

<!-- station:verification-policy:start -->
The "Invalidated by" column names only the lane-specific `manifestDigest`
content; every other field participates in reuse identity for every lane and
invalidates its receipt when any one changes. The full identity
set (defined in `scripts/lib/verification-receipt.mjs`): receipt
`schemaVersion`; and the request projection — `repositoryId`, `worktree`,
`headSha`, `workspaceDigest`, `environmentDigest`, `laneId`, `command`,
`manifestDigest`, `dependencyDigest`, `nodeVersion`, `toolchain`, `platform`,
`arch` (whose SHA-256 over their stable JSON is the derived request `key`).
See `docs/reference/verification-receipts.md` for the field-by-field table.

`ci:fast` is bounded diagnostic feedback, not completion evidence: it has a
twelve-minute coordinator deadline, uses `STATION_CI_FAST_BASE` (default
`origin/main`) in its request identity, runs the affected selection before a
fixed bounded static invariant set. A selector exit 3 is reported as a
diagnostic defer after those invariants, never completion evidence; the
separately phase-attested `full-regression` gate remains required. Its
20-unit scheduler reservation overlaps the 80-unit full test phase, so
completion work yields admission headroom for fast feedback. Broad static
verification and the full Vitest corpus must remain composed only by
`full-regression`, never by `ci:fast`.

When a lane fails, diagnose the failure rather than rerun-to-green: read the
redacted output under `.kontourai/verification-output/<request-key>/`, isolate
the failing test or gate, and fix the cause. A red lane is a
signal to diagnose, not a request to rerun until green; a flaky failure is
reproduced or triaged against an `origin/main` baseline and disclosed, never
hidden by repetition.

Heavy coordinated lanes share one host-wide weighted lease, so do not start a
redundant same-digest run of a lane already in flight: inspect
`node scripts/run-verification.mjs status` and join or reuse the existing lease
instead. The coordinator returns exit 0 for an executed, joined, or reused
lane, so reuse is the expected path, not a workaround.
<!-- station:verification-policy:end -->

Persistent self-hosted CI jobs deliberately omit `setup-node`'s remote npm
cache. The runner service account already retains npm's content-addressed cache;
restoring the same multi-gigabyte archive per job serializes the fleet without
weakening or improving `npm ci`. `npm run gate:workflows` enforces this for
self-hosted jobs while continuing to allow remote caches on ephemeral hosted
runners. Persistent jobs also skip automatic `pull_request` execution and run
only for protected `main` pushes or reviewed manual dispatches; the same gate
requires that boundary and `persist-credentials: false` on their checkouts.
Unreviewed PR code belongs on hosted or genuinely one-job ephemeral runners.

Linux CI, Android, publish, and secret-scan jobs run on GitHub-hosted
images. desktop-win remains for the named Windows hardware-reference
performance lane, the native Windows portable floor, the Windows Vitest
diagnostic, container-smoke Playwright, and recovering a leaked
physical-host capacity lease. If a Linux job is reintroduced on that host, `ci:fast` alone
requests `fast-feedback` and every other leased Linux job requests
`heavy-host`. The fast listener must not carry `kontour-linux`, because GitHub
matches a job when the runner has a *superset* of its requested labels;
retaining that shared label would let an unrelated heavy job occupy the
feedback listener before its lease is admitted. The actionlint policy still
enforces that partition for any persistent Linux job. See
[the private-runner partition guide](private-runner-partition.md) before
changing fleet labels or adding a capacity-leased workflow.

### Opt-in load reliability evidence

`npm run test:load-reliability` is deliberately dry by default. It prints the
resolved resource plan and starts no workers, authoritative suite attempts, or
receipt. It is safe to use as a preview. The only command that starts the
bounded, Node-owned CPU-pressure workers is:

```bash
npm run test:load-reliability -- --run --target-load=50 --workers=64
```

Run that command only in an exclusive local-host window: it can materially
reduce responsiveness and affect other processes or local verification. It
waits for observed one-minute load strictly greater than `target-load`, then
runs exactly three sequential `npm run verify:local` attempts. This is an
opt-in local evidence lane; it is not part of `npm test`, generic pre-push,
`verify:static`, CI, or hosted-CI authority.

The default overall deadline is 90 minutes. Sustained CPU pressure can make a
single full local verification materially slower than its unloaded baseline,
so the deadline covers all three sequential attempts plus cleanup without
turning an otherwise healthy loaded run into a guaranteed timeout.

The tunable limits are hard bounds, not suggestions: `--target-load=50..100`,
`--workers=1..128`, `--warmup-ms=1000..300000`,
`--sample-interval-ms=1000..60000`, and
`--deadline-ms=300000..7200000`; warm-up must be shorter than the overall
deadline. `--output=<path>` accepts only an untracked `.json` receipt strictly
beneath `.kontourai/test-reliability/`; traversal, symlink, directory, tracked,
and other repository targets are rejected before workers start. Do not raise
those bounds ad hoc to obtain a passing result.

The runner checkpoints a mode-0600, atomic receipt at
`.kontourai/test-reliability/load-reliability-latest.json` (or the bounded
`--output` path) throughout the run. Read its `requested` plan, observed
`load.samples` and summary, per-attempt status/duration/load samples,
aggregate `summary.passRate`, `provenance` before/after stability,
`interruption`, `error`, and `cleanup` worker outcomes together. Its final
publication keeps the receipt directory private (mode 0700 on POSIX), holds a
stable no-follow directory handle through the atomic rename, and revalidates
parent identity immediately before commit. Node has no portable directory-FD
relative rename API; the remaining trust boundary is the current OS account
(and Windows ACLs), which must control the repository and receipt parent.
classification is `passed`, `suite_failed`, `infrastructure_error`,
`provenance_drift`, `stress_not_achieved`, `interrupted`, or `cleanup_failed`;
the last preserves the earlier `primaryFailure` when cleanup also fails.
`SIGINT`, `SIGTERM`, failures, and deadlines still enter cleanup, and a partial
receipt is evidence rather than a result to discard.

On macOS, the one-minute `os.loadavg()` value is system-wide, not a measurement
of Station workers alone. It does not establish memory, disk, network, service,
or other contention behavior. A receipt is partial local evidence: retain its
provenance and use repeated, stable measurements to inform a later
evidence-driven gate-tightening decision. It does not automatically tighten a
gate or establish hosted-CI equivalence.

`test:e2e:product`, `test:e2e:smoke-live`, and
`test:e2e:starter-clean-install` allocate non-default ports, start a temporary
`./station` instance, set `PW_BASE_URL`/`STATION_PORT`, run Playwright with
repo-local browsers, and stop the instance in cleanup. The Starter clean-install
suite keeps its fresh home in the runner, disables product and OTLP telemetry
even when the invoking shell configured endpoints, does not seed an
established-user profile, and pins its resource observation healthy so
unrelated host load cannot replace the intended product journey with an honest
deferral. Resource-posture fault tests separately own degraded and critical
admission proof. Use these scripts for verification claims instead of ad hoc
default-port runs.
For focused verification, pass one or more exact `--spec=tests/...spec.ts`
arguments and an optional `--grep=pattern` after `--`. The runner rejects specs
outside the selected manifest bucket, keeps manifest order, uses the same
temporary-instance startup and cleanup, and pins every child command to the
Node executable that validated the parent runner.

Playwright spec ownership is tracked in `tests/e2e-manifest.mjs`. Add every new
`tests/**/*.spec.ts` file to exactly one bucket when it is introduced. The
`npm run verify:static` lane validates manifest ownership without starting
Station. `npm run verify` and CI's Full Playwright Coverage job run
`npm run verify:e2e:full`; use that evidence for any no-shortcuts full-coverage
claim.

The full floor parallelizes at the bucket boundary, not inside Playwright.
Product, extended, Android, and Starter clean-install are startup-heavy resource
groups; first-run is lighter but still boots Station; smoke-live and screenshot
are light. The default weighted capacity allows a startup-heavy bucket to
overlap one light bucket while keeping startup-heavy Station builds apart. Every
bucket still uses one Playwright worker and its own
ports, temporary home, instance build roots, and `test-results/<instance>`
directory. `STATION_E2E_CAPACITY` is bounded and is for measured,
deliberately-provisioned hosts—not an edit-loop speed knob.

`tests/mobile-chat-composer.spec.ts` owns the mobile task-switcher journey:
at 320px and 390px it covers the header trigger, visual-viewport sheet
containment, dismissal/focus return, chat restore, and delegated Sessions
navigation without a connection or credential setup step.

### Task-first Home and root readiness

The `/` route is a deliberate Home surface. Its focused unit lane is:

```bash
npx vitest run src-ui/src/__tests__/resolve-home-surface.test.ts src-ui/src/__tests__/AppHomeRoute.test.tsx src-ui/src/__tests__/HomeView.test.tsx src-ui/src/__tests__/ProjectSidebarNav.test.tsx src-ui/src/__tests__/app-routing.test.ts
```

`tests/root-route-restore.spec.ts` owns slow project/layout loading, failure,
retry, and stale persisted-project behavior without an automatic redirect.
`tests/task-first-home.spec.ts` owns the deterministic returning-task and empty
action hierarchy, concrete agent/model identity, Advanced disclosure, and the
Pixel 7 (`412x915`) off-canvas/overflow/touch-target journey. Keep mocked
fixtures shaped like the real project and orchestration read models; do not
invent a resumable URL for an orchestration row that Station can only open via
Sessions.

### Lane-scoping greps must cover routes AND labels

When a change is judged safe to verify with a narrower Playwright bucket
(e.g. "product bucket only, no smoke-live/extended/screenshot spec
references any changed string"), the grep that backs that decision must
search for both kinds of drift a rename can introduce:

- **Label/copy strings** — the visible text a spec asserts with
  `getByText`/`getByLabel`/`getByRole(..., { name })`.
- **Route paths** — the strings a spec asserts with `toHaveURL`, matched
  against what `getPathForView`/`resolveViewFromPath`
  (`src-ui/src/app-shell/routing.ts`) actually produce, not just the path
  literals visible in the diff.

A grep over changed string literals alone misses a route rename: the old
inbound path can still resolve (kept as an alias in
`resolveViewFromPath`) while the app's own outbound navigation now emits the
new canonical path, so a spec elsewhere asserting the old outbound URL goes
stale silently. This is exactly what happened between #190 and #205: #190's
noun-unification pass renamed `/connections/agents` →
`/connections/agent-apps` and `/connections/providers` → `/connections/models`
plus a "cloud providers" → "cloud services" copy change, and judged the
product bucket clear because no product-bucket spec referenced the changed
strings — but `tests/onboarding-setup-banner.spec.ts` (extended bucket) and
`tests/settings.spec.ts` (extended bucket) both pinned the old routes/copy
and went stale until #205 closed the gap. Before narrowing an e2e
verification lane, grep every bucket for both the changed strings and the
changed route outputs, not just the bucket you are actively touching.

## Durable Verification Lanes

For roadmap work that changes product behavior, prefer adding or extending a named verification lane rather than relying on ad hoc manual checks.

Phase 1 no-AWS startup proof:

```bash
npm run proof:phase1-no-aws-startup
```

This lane launches `./station start --temp-home --clean --force` with a
unique instance and port block, removes AWS environment variables from the
child process, checks `/api/system/status` for a provider-neutral
recommendation, stops the instance, and writes the proof JSON plus server log
under `.omx/artifacts/phase1-no-aws-startup/`. It also snapshots the default
`~/.station` directory before and after the run and fails if the default
home changes.

Recommended lane types:

1. **Hermetic startup smoke**
   - prefer `./station start --temp-home` (or a temporary `STATION_HOME` when you need an explicit path)
   - scrub env vars in the child process instead of changing the developer's shell
   - prove first-run behavior without depending on the current machine state

2. **Adapter registration integration**
   - prove runtime/provider adapters register through the shared registry path
   - prefer temp fixtures or temp plugins

3. **Onboarding e2e**
   - prove setup launcher, doctor guidance, and reaching a chat-capable path

4. **Cross-engine smoke**
   - Station-engine Agent path
   - external-engine Agent path
   - ACP connection path

5. **Platform-control smoke**
   - exercise at least one real `station-control` action end to end

6. **CLI parity integration**
   - prove route-backed product surfaces remain reachable through `station`
   - prefer HTTP-backed vitest command tests for breadth, then add targeted browser or live-app checks only where the CLI contract depends on full runtime behavior

The goal is persistent regression protection. If a test only proves something once and cannot be rerun meaningfully later, it is not enough on its own.

For CLI parity work, prefer:

- one shared HTTP command-contract suite covering multiple CLI families when the requests are mechanically similar
- dedicated route tests when a route family has unusual response shape or lifecycle behavior
- command reference updates in `docs/reference/cli.md` in the same change as the implementation

## Connected Agents Verification

Use these terms consistently when adding connected-agents coverage:

- `Contract test`: provider-native event/request mapping into canonical runtime events
- `Integration test`: Hono route or orchestration service boundary with real collaborators
- `E2E test`: browser-driven flow using route interception or mocked EventSource delivery
- `Smoke test`: real running app via `./station`

Focused automation:

```bash
npm run test:connected-agents
PW_BASE_URL=http://localhost:5274 PLAYWRIGHT_BROWSERS_PATH=0 \
  npx playwright test \
  tests/orchestration-provider-picker.spec.ts \
  tests/orchestration-chat-flow.spec.ts \
  tests/orchestration-recovery.spec.ts
```

**Dependency-install gotcha:** if `npm run test:connected-agents` fails with
`orchestration-service.test.ts` Flow-gated-session tests expecting a
rejection (`/Flow gate verdict: .../`) but the session completes instead,
suspect a stale `node_modules` before suspecting a gate-contract or fixture
regression. `@kontourai/flow`'s gate-expectation schema changed at the
1.3.0 migration (expectations are now `kind: 'trust.bundle'`); an older installed copy silently
rejects the migrated `kind: 'trust.bundle'` definitions as invalid, so the
session never binds to a Flow run and the completion gate fail-opens
exactly like a non-Flow workspace. Fix: `npm run dependencies:ci` (matches every CI workflow),
then rebuild local workspace packages
(`npm run build:sdk && npm run build:connect`) before re-running the suite.
Verify with `node -e "console.log(require('./node_modules/@kontourai/flow/package.json').version)"`
against the version pinned in `package.json`.

Live local gate:

```bash
./station start --instance=connected-agents-smoke --temp-home --clean --force --port=3242 --ui-port=5274
PW_BASE_URL=http://localhost:5274 PLAYWRIGHT_BROWSERS_PATH=0 \
  npx playwright test \
  tests/orchestration-provider-picker.spec.ts \
  tests/orchestration-chat-flow.spec.ts \
  tests/orchestration-recovery.spec.ts
./station stop --instance=connected-agents-smoke
```

Use `--temp-home` for routine local gates. Shared-build actions (`--clean`, `fresh`, `--build`, and self-update) will refuse while sibling instances from the same checkout are still live.

## Shared Test Utilities

`src-server/__test-utils__/` holds two helpers. There is no mock-factory or
request-assertion module — construct fakes with `vi.fn()` inline, which keeps
each test's expectations visible where they are asserted.

### Typed JSON bodies (`src-server/__test-utils__/read-json.ts`)

Under strict fetch types `res.json()` returns `Promise<unknown>`, so `body.foo`
does not type-check. Route tests had accumulated 37 copy-pasted local `json()`
helpers before this was shared. Runtime behaviour is exactly `res.json()`; the
helper only supplies the caller's type.

```ts
import { readJson } from '../../../__test-utils__/read-json.js';

const res = await app.request('/api/runs');
const body = await readJson<{ runs: RunSummary[] }>(res);
expect(body.runs).toHaveLength(1);
```

### SSE streams (`src-server/__test-utils__/sse-helpers.ts`)

Collects events from a Hono `streamSSE` response, bounded by both an event
count and a timeout so a stream that never closes fails fast instead of hanging
the suite.

```ts
import { collectSSE } from '../../../__test-utils__/sse-helpers.js';

const events = await collectSSE(res, { maxEvents: 5, timeoutMs: 2000 });
expect(events.map((e) => e.event)).toContain('run.updated');
```

## Patterns

### Service Test

Services import OpenTelemetry instruments at module load, so mock
`telemetry/metrics.js` **before** importing the subject — hence the top-level
`await import()` rather than a static import. Collaborators are plain `vi.fn()`
objects, so each test's expectations stay visible where they are asserted.

```ts
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  agentOps: { add: vi.fn() },
}));

const { MyService } = await import('../my-service.js');

function createMockConfigLoader() {
  return {
    listAgents: vi.fn().mockResolvedValue([{ slug: 'default' }]),
  };
}

describe('MyService', () => {
  test('creates a thing', async () => {
    const service = new MyService(createMockConfigLoader() as never);
    const result = await service.create({ name: 'test' });
    expect(result.name).toBe('test');
  });
});
```

### Route Integration Test

Routes are exercised through Hono's `app.request()` against the real router.
`readJson<T>()` supplies the response type — under strict fetch types
`res.json()` is `Promise<unknown>`, so `body.data` will not type-check without
it.

```ts
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  myRouteOps: { add: vi.fn() },
}));

const { createMyRoutes } = await import('../my-routes.js');

describe('MyRoutes', () => {
  test('GET / returns list', async () => {
    const service = { list: vi.fn().mockResolvedValue([]) };
    const app = createMyRoutes(service as never);

    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await readJson<{ data: unknown[] }>(res)).toEqual({ data: [] });
  });
});
```

### Hook Test (jsdom)

```ts
// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMyHook } from '../useMyHook.js';

describe('useMyHook', () => {
  test('initial state', () => {
    const { result } = renderHook(() => useMyHook());
    expect(result.current.value).toBe(null);
  });
});
```

## New Feature Checklist

- [ ] Service has unit test in `__tests__/`
- [ ] Route has integration test in `__tests__/`
- [ ] Critical hooks have unit tests
- [ ] User-facing behavior has a regression at the lowest authoritative layer
- [ ] A Playwright test exists only when the claim requires a real browser or packaged runtime
- [ ] Required coverage thresholds and changed-scope selection pass

## Regression Coverage Policy

Every substantive feature or bug fix must carry evidence for the behavior it
changes. More tests are not automatically better: put the claim at the lowest
layer that can fail for the right reason.

### Rules

1. **No unproved behavior change.** Services use unit tests, routes use `app.request()` integration tests, and UI components/hooks use focused component or hook tests. Add Playwright only for a real browser, packaged UI/runtime boundary, or end-to-end journey that lower layers cannot prove.

2. **Write tests first when possible.** For new services and routes, write the test file with expected behavior before implementing. For bug fixes, write a failing test that reproduces the bug, then fix it.

3. **Coverage is a floor, not a test-design metric.** Thresholds are set in `vitest.config.ts`. If `npm run test:coverage` fails, restore the missing behavioral coverage; do not add vacuous assertions merely to move a percentage.

4. **Use shared utilities.** Use `readJson()` from `__test-utils__/read-json.js` for typed response bodies and `collectSSE()` from `__test-utils__/sse-helpers.js` for SSE streams, rather than re-deriving either per file.

5. **Playwright for browser/runtime boundaries.** SSE and HTTP route contracts normally use server integration tests; component state uses Vitest/jsdom. Use Playwright when browser streaming behavior, focus/layout, navigation, or the live packaged boundary is itself the claim.

### What counts as "tested"

| Change Type | Required Test |
|---|---|
| New service | Unit test covering public API |
| New route | Integration test via `app.request()` |
| New UI component/hook | Focused component/hook test; Playwright only for a browser-owned claim |
| Bug fix | Regression test that fails without the fix |
| Refactor | Existing tests still pass (no new tests needed) |

### Connected Agents Checklist

- Adapter changes update the provider contract tests in `src-server/providers/__tests__/`
- Orchestration changes update service, event-store, and route coverage
- UI/state changes update the nearest component/hook regression and any existing browser journey whose claim changed
- Session recovery changes must prove both restore and fail-closed behavior
- Provider-specific prerequisite or option changes must be asserted end-to-end

### SSE Test Helper

For routes that use `streamSSE`, use the `collectSSE` helper:

```ts
import { collectSSE } from '../../__test-utils__/sse-helpers.js';

const res = await app.request('/events');
const events = await collectSSE(res, { maxEvents: 3, timeoutMs: 500 });
expect(events[0].parsed.type).toBe('connected');
```

## CLI / agent live lane (`npm run verify:cli-e2e`)

The UI is e2e-tested against a live server (Playwright), but the **CLI** and the
**managed-agent execution path** (tool install → load → forward-to-model → CLI
chat) had no live coverage — and that's exactly where a run of "green in unit
tests, broken against the real runtime" bugs hid (the builtin-tool schema enum,
the VoltAgent base-tool forwarding gate, the Strands boot crash and render
shape). `scripts/cli-agent-e2e.mjs` closes that gap:

- Boots a **real** server in an isolated temp home via `STATION_HOME` (the
  data-dir env var) — a wrong/missing value silently falls back to `~/.station`.
- Drives the flow against a local **Ollama** model (creds-free).
- Asserts **deterministically**: the builtin tool installs + loads into the
  agent, is **forwarded to the model** in the chat request (inspected directly,
  not dependent on whether a small model chooses to call it), and `station chat`
  connects/streams/exits 0.
- **Skips cleanly (exit 0)** when Ollama or `dist-server` is absent, so it's safe
  to run anywhere; it only adds signal when a local model is present.

Run it locally before pushing runtime/CLI/tool changes (it needs a built server
and `ollama serve` with a tool-capable model pulled). It is intentionally a
local lane, not part of the quota-limited CI gate.

### Provider-boundary note

AWS SDK and other provider wrappers use route/service integration tests with an
injected or mocked provider boundary for deterministic contracts. Keep real
provider execution in an explicit opt-in live lane; a browser interception is
not evidence that the server-side SDK integration works.
