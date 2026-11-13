# Idle weight and request overhead

`npm run perf:station-weight` measures how heavy one isolated Station is at
rest and how much Station adds to the Claude engine's first model request. It
compares the result with a recorded baseline and exits non-zero only when a
budget grows past its headroom. Run it on a pull request that touches the
server, engine launch, or anything Station injects into a session.

The [runner](../../scripts/bench/station-weight.mjs) owns the lifecycle, the
[stub endpoint](../../scripts/bench/station-weight-stub.mjs) stands in for the
model, the [request analysis](../../scripts/bench/station-weight-request.mjs)
decomposes what reached it, and the
[budgets](../../scripts/bench/station-weight-budgets.mjs) compare against the
[baseline](../../scripts/bench/station-weight-baseline.json).

## What a run does

1. Requires a clean tree (`--allow-dirty` is diagnostic only and recorded).
2. Starts a loopback stub for the Anthropic Messages API, writes a fixture Git
   repository whose `CLAUDE.md` and `AGENTS.md` each carry a unique marker,
   and builds an allowlisted environment: scratch `HOME`, `TMPDIR`,
   `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, telemetry off, `ANTHROPIC_BASE_URL`
   pointing at the stub. Nothing from the caller's agent session leaks in.
3. Puts the Agent SDK's bundled Claude Code binary (pinned by the lockfile) on
   `PATH` as `claude`. Station reports the engine ready only when `claude` is on
   `PATH`, and this keeps Station and the control on one executable.
4. Runs `station build --instance=<name>`, then times
   `station start --instance=<name> --temp-home --force` on free ports clear
   of 3000 and 3141. `--clean` is not used: it rebuilds, so the timing would
   mostly measure the build. The build time is reported separately.
5. Samples the instance's process tree, sends `hi` to the Claude agent in the
   fixture repository, creates more idle sessions the same way, runs the
   control request, then runs `station stop` and looks for survivors.

Every turn is answered by the stub (`ok`). No real model is called.

## Metrics

| Metric | How it is measured |
| --- | --- |
| `serverReadyMs` | Launch of `station start` until the UI listener's `/api/system/readiness` answers `status: ready`. That is the route the launcher itself trusts. It confirms the server's boot identity and needs no credential. |
| `restMemoryBytes` | Summed memory of the instance's tree with no sessions, once two consecutive samples 5 s apart agree within 5% (after at least 30 s, at most 300 s). |
| `idleSessionsMemoryBytes` | The same, after three sessions each created by one stub-answered turn. Each Claude session keeps an engine process alive. |
| `idleCpuPercent` | CPU time the tree used over a 30 s window at rest, as a percentage of one core. |
| `idleWakeups` | Not measured: see [Gaps](#gaps). |
| `idleContextSwitches` | Linux only: voluntary plus involuntary context switches over the same window, from `/proc`. This is a proxy, not wakeups. |
| `leftoverAfterStopMemoryBytes` | Memory of any process from the pre-stop tree still alive 5 s after `station stop`. |
| `request.stationAddedTextBytes` | Text lines in Station's first turn request that the control request lacks. |
| `request.stationAddedToolCount` | Tools Station's request carries beyond the control's, with schemas or named only (deferred). |
| `request.stationAddedToolDefinitionBytes` | JSON size of the added tool schemas. |
| `request.sideCallCount` | Other Messages requests during the turn window, such as a title request. |
| `repoRules` | Whether the `CLAUDE.md` and `AGENTS.md` markers reached the first request: yes or no for each. |

**Process tree.** The tree is found by ownership: the supervisor and UI pids
from the instance record, plus every descendant by parent pid. A survivor
must match both pid and start time, so a reused pid is not counted.

**Memory basis.** Memory is `phys_footprint` on macOS (from `footprint`,
compressed pages included) and RSS elsewhere. macOS compresses idle pages out
of RSS: on a busy host one process showed 4 MiB RSS and an 87 MiB footprint.
The basis is recorded with each value.

**Control request.** The control is the same executable driven directly
through the Agent SDK `query()`, with the same directory, environment and
model, and with no Station. Lines are compared as a multiset after
normalizing session ids and the per-request suffix of the version stamp. If
the two runs report different Claude Code versions, the diff is not measured.

**Sizes.** Sizes are UTF-8 bytes and Unicode code points. No tokenizer is
applied, so the results contain no token counts or estimates.

## Budgets and baseline

A budget fails only when `value > baseline × (1 + ratio) + floor`. Shrinking
always passes. `request.*` budgets use one host-independent baseline. The
other budgets compare only against a baseline recorded on the same host class
(`<platform>-<arch>`). Without one, the verdict is `NOT_MEASURED`.

| Budget | Headroom |
| --- | --- |
| `serverReadyMs` | +100% (clean runs on one loaded host ranged 3.6–8.6 s) |
| `restMemoryBytes`, `idleSessionsMemoryBytes`, `leftoverAfterStopMemoryBytes` | +25% |
| `idleCpuPercent` | ×2 plus 1 percentage point |
| `request.stationAddedTextBytes`, `request.stationAddedToolCount`, `request.stationAddedToolDefinitionBytes` | +10% |
| `request.sideCallCount` | none: a new side request is a discrete change |

To record a baseline, run `npm run perf:station-weight -- --record-baseline`
on a clean tree and quiet host, and commit the file. Recording replaces only
the run's host class and the request values, and keeps the other host classes.

Each run writes `result.json` (metrics, per-process detail, request breakdown,
verdicts) and `requests.json` (every request the stub received) under
`.kontourai/station-weight/<sha>/<run-id>/`. Diff two results to compare
revisions. `--out=<dir>`, `--baseline=<file>`, `--settle-ms`,
`--settle-max-ms`, `--cpu-window-ms`, `--sessions` and `--stop-grace-ms`
override the defaults.

## Gaps

- **Wakeups on macOS.** Per-process wakeup counts need `powermetrics` (root)
  or libproc, and `top`'s `IDLEW` did not advance between samples.
- **Windows.** The launcher is a bash script and the tree is read with POSIX
  `ps`, so the whole run reports `not_measured`.
- **Unready engine.** A memory sample that never settles, an engine that never
  reports ready, or a missing bundled binary makes the affected metrics
  `not_measured`, with the reason.

None of these is ever zero or a pass.

## Limits

- One run is one sample on one host. Launch timing in particular swings with
  host load (`host.loadStart`/`loadEnd` are recorded). Compare several runs
  before claiming a change.
- The check is not wired into hosted CI. Request budgets are host-independent,
  but no Linux run has qualified them, and hosted runners have no host-class
  baseline for the idle budgets.
- The control isolates what Station adds. It does not measure the engine's own
  prompt, which changes with the bundled Claude Code version.
- `scripts/__tests__/station-weight.process.test.ts` runs the whole check with
  short windows and fails when Station's request additions exceed the
  committed request budgets.
