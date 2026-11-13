# Idle weight and request overhead

`npm run perf:station-weight` measures how heavy one isolated Station is at
rest and how much Station adds to the Claude engine's first model request. It
compares the result with a recorded baseline. It exits non-zero when a budget
grows past its headroom, and also when a budget that should have been compared
was not: a gap is never a pass. Run it on a pull request that touches the
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
   pointing at the stub, and a `STATION_WEIGHT_RUN=<nonce>` tag (a random
   128-bit value, distinct from the run id). Nothing
   from the caller's agent session leaks in. The fixture commit runs git
   without any `GIT_*` variable, system config or global config, so a caller
   inside another checkout's hook cannot route it there.
3. Puts the Agent SDK's bundled Claude Code binary (pinned by the lockfile) on
   `PATH` as `claude`. Station reports the engine ready only when `claude` is on
   `PATH`, and this keeps Station and the control on one executable.
4. Runs `station build --instance=<name>`, then times
   `station start --instance=<name> --temp-home --force` on free ports clear
   of 3000 and 3141. `--ready-launches=<n>` takes the median of `n`
   launches, with a stop and an unmeasured build between them. `--clean` is not used: it
   rebuilds, so the timing would mostly measure the build. A start after a
   stop also rebuilds the UI (16–20 s against 5.5 s for the first start),
   hence the build before each relaunch. The build time is reported
   separately.
5. Samples the instance's process tree, sends `hi` to the Claude agent in the
   fixture repository, creates more idle sessions the same way, runs the
   control request, then runs `station stop` and looks for survivors.

Every turn is answered by the stub (`ok`). No real model is called.

## Metrics

| Metric | How it is measured |
| --- | --- |
| `serverReadyMs` | Report only, never compared (see [Ready time](#ready-time)). Median over the launches of: launch of `station start` until the UI listener's `/api/system/readiness` answers `status: ready`. That is the route the launcher itself trusts. It confirms the server's boot identity and needs no credential. |
| `restMemoryBytes` | Summed memory of the instance's tree with no sessions, once two consecutive samples 5 s apart agree within 5% (after at least 30 s, at most 300 s). |
| `idleSessionsMemoryBytes` | The same, after three sessions each created by one stub-answered turn. Each Claude session keeps an engine process alive. |
| `idleCpuPercent` | CPU time the tree used over a 30 s window at rest, as a percentage of one core. The tree is sampled every 250 ms, and each process counts the CPU time it last showed, so a worker that exits inside the window still counts. See [Gaps](#gaps) for what sampling misses. |
| `idleWakeups` | Not measured: see [Gaps](#gaps). |
| `idleContextSwitches` | Linux only: voluntary plus involuntary context switches over the same window, from `/proc`. This is a proxy, not wakeups. |
| `leftoverAfterStopMemoryBytes` | Memory of every process still alive 5 s after `station stop` that belongs to the run: any process seen in the instance's tree during the run, and any process carrying the run's environment, however it detached. Only the kill-eligible ones are then killed; the rest are reported as left running (see [Ownership](#ownership-kill-eligible-and-report-only)). What it cannot find is written beside the value (`leftoverAfterStopMemoryBytes.gap`; see [Gaps](#gaps)). A read of the tree that failed while following it makes the value `NOT_MEASURED`. |
| `request.stationAddedTextBytes` | Text lines, blank lines included, in Station's first turn request that the control request lacks, sized from the text sent. |
| `request.stationAddedToolCount` | Tools Station's request carries beyond the control's, with schemas or named only (deferred). |
| `request.stationAddedToolDefinitionBytes` | JSON size of the added tool definitions, plus the byte growth of any tool both requests carry whose definition Station changed. Tools are compared by whole definition, not by name. |
| `request.sideCallCount` | Other Messages requests during the turn window, such as a title request. |
| `repoRules` | Whether the `CLAUDE.md` and `AGENTS.md` markers reached the first request: yes or no for each. |

**Process tree.** The tree is found three ways, and the union is measured:

- *Identity.* The supervisor and UI fingerprints from the instance record
  (pid plus birth token: pinned `lstart` on macOS, `/proc` start ticks plus
  boot id on Linux), plus every descendant by parent pid. A root whose pid
  now belongs to another process contributes nothing.
- *Identities seen.* The launcher writes the instance record right after it
  spawns the roots, before the instance is ready. The run reads the record
  every 250 ms while `station start` runs, and from the moment the record
  names the roots until after the stop grace it reads the tree by ancestry,
  nominally every 250 ms. Every pid plus birth token any read saw is counted
  as the run's from then on (`seenProcessCount`). This does not depend on
  the environment: a child that detaches, or overwrites its environment (a
  long `process.title` on macOS overwrites the area `ps` and the kernel
  read it from), is still found if it stayed in the tree for one read. The
  reads share the event loop with the run's synchronous reads (memory
  footprints, environment scans), so the real interval can be longer: the
  result records the reads, the longest interval observed between the
  starts of two of them (`follow.maxIntervalMs`), when each root was
  learned (`follow.roots[].learnedAt`, against the record's
  `follow.recordStartedAt`), and which roots the follower's own reads found
  (`follow.rootsFollowed`).
- *Environment.* Every process the instance starts inherits the run's
  `HOME`, `TMPDIR` and `STATION_WEIGHT_RUN` nonce, so a double-forked daemon
  or a child spawned during shutdown is found with no ancestry at all. Only
  whole environment entries count, never the arguments and never text
  inside another variable's value: exactly `STATION_WEIGHT_RUN=<nonce>`, or
  `HOME` or `TMPDIR` whose value lies inside the scratch root. Both sides of
  that path test are resolved first (links followed, `.` and `..`
  applied, a missing tail appended to its longest existing prefix), and
  containment is by whole path segment, so `HOME=<scratch>/../outside` and
  a link under the scratch root that points outside it do not count. On
  Linux the entries are the NUL-separated `/proc/<pid>/environ`. On macOS
  they are read with sysctl `KERN_PROCARGS2`, the kernel's NUL-separated
  copy of the process's arguments and environment, through a small
  `python3 -I` ctypes helper; `ps -E` joins the same entries with spaces, so
  `INNOCENT=before HOME=<scratch>/user` would look like a `HOME` entry. The
  helper reads each process's start time (microseconds) before and after
  the read and drops a process whose start changed or does not match its
  row. It parses the block strictly: its size must lie between 4 bytes and
  `kern.argmax`, `argc` must be 0 or more and no more than the block can
  hold, and the executable path, every argument and every environment entry
  must end with a NUL inside the returned size. A block that fails any of
  these is a read failure: the process is never tagged, and the run lists it
  (`environmentReadFailures` in the result, `ENVIRONMENT UNREADABLE` lines in
  the output). A process whose entries cannot be read is never tagged, and
  if the helper cannot run at all (no `python3`), the run fails rather than
  skipping the check. A process that names the nonce in its arguments is
  excluded, because the nonce is only ever passed through the environment.
  The process must also run as the same effective user and have started
  after the run did, with 2 s of slack for whole-second birth times. The
  control engine shares the environment but has its own
  `CLAUDE_CONFIG_DIR`, which excludes it from the measurement. A run
  records how each pre-stop process was found
  (`beforeStopOwnership`: by the nonce, only by a scratch path, only by
  ancestry).

On Linux each process is read from `/proc` alone: one `stat` read gives its
parent, CPU, birth and RSS, and `status` gives its uid and context switches.
`stat` is read again afterwards, and a process whose start ticks changed in
between is dropped, so a reused pid never pairs one process's birth with
another's parent. An environment read is likewise kept only if the pid still
has the row's start ticks after it. On macOS one `ps` call reads every field
of a process together.

A tree that is empty when sampled is `NOT_MEASURED`, never zero.

A process that leaves the tree before any read saw it there and whose
environment carries no run tag is not found (see [Gaps](#gaps)).

### Ownership: kill-eligible and report-only

Everything above counts toward the measurement. Exactly two kinds of signal
are ever sent, and both are default-deny: a process or group is signalled
only when it is affirmatively shown to qualify.

- **A. A process carrying the run's nonce.** A process whose environment,
  read exactly as above, contains the entry `STATION_WEIGHT_RUN=<nonce>` is
  kill-eligible (SIGKILL after stop, and again when the run ends). The nonce
  is a random 128-bit value, so no process carries it by accident. Only a
  row marked `killEligible: true` is signalled; an omitted or other value
  means not eligible.
- **B. The launcher's own process group, on a timeout.** Each `station`
  command runs as the leader of a new process group (spawned detached, so
  in its own session, through
  [owned-process](../../scripts/lib/owned-process.mjs)). If the command
  outlives its timeout, the run sends SIGKILL to that group, untagged members
  included, but only while Node has not reaped the launcher. A session
  leader cannot change its group, and an unreaped pid cannot be reused, so
  until then the group id names the group this run created. Node records the
  exit status in the same libuv callback that reaps the child, and the
  timeout runs from a timer, so it reads that state accurately. Once the
  launcher has been reaped, the group may have ended and its id been reused,
  and no POSIX call signals a group only if it is still a given one, so the
  group is not signalled: the command fails with that reason, and anything
  it left is found and reported by the leftover accounting. Other callers of
  owned-process keep its existing behavior, which signals the group id even
  after the leader is gone.

Every other process the run counts is *report-only*: a recorded root
without the nonce, one found only by ancestry, only because a read saw it in
the tree, or only by a scratch `HOME` or `TMPDIR`. It counts toward
`leftoverAfterStopMemoryBytes`, so the budget still fails, and is never
signalled. The run lists what it left running with pid, birth and the first
1,000 characters of its command line (`leftRunning` in the result,
`LEFT RUNNING` lines in the output, and `reportOnly` beside the leftover
value). `beforeStopOwnership` records how each process alive before stop was
found, so a run shows whether all of them were kill-eligible under A.

Under A, a process is signalled only if its exact birth still holds when
read immediately before the signal: the microsecond start time
(`p_starttime`) on macOS, read by the same helper process that then calls
`kill`, and the `/proc` start ticks (1/`CLK_TCK` s) on Linux, read right
before `process.kill`. A pid that names another process when the recheck
runs is never signalled, even one born in the same second. The race that
remains: if the process exits after its birth is read and before `kill`
runs, and the kernel gives its pid to a new process in that interval, the
new process is signalled, whatever its birth. Nothing bounds the interval:
the two calls are consecutive and normally microseconds apart, but a
reader the scheduler pauses between them can wait arbitrarily long. POSIX
has no call that signals a pid only while it names one process.

The tests follow the same rules: children a test spawned are killed through
its own `ChildProcess` handles, which Node signals only until it has reaped
them; detached test daemons exit on their own when the test's lease file is
removed; and the end-to-end test ends the daemon it leaks only under rule A.

**Memory basis.** Memory is `phys_footprint` on macOS (from `footprint`,
compressed pages included) and RSS elsewhere. macOS compresses idle pages out
of RSS: on a busy host one process showed 4 MiB RSS and an 87 MiB footprint.
The basis is recorded with each value.

**Control request.** The control is the same executable driven directly
through the Agent SDK `query()`, with the same directory, environment and
model, and with no Station. Lines are compared as a multiset. Only one field
is normalized: the per-request suffix of the version stamp in the
`x-anthropic-billing-header` line (`cc_version=2.1.318.a25` against
`.da9` in recorded runs). Session and device ids travel in `metadata`, which
is not compared. Every other line and every tool definition is compared byte
for byte. If the two runs report different Claude Code versions, the diff is
not measured.

**Sizes.** Sizes are UTF-8 bytes and Unicode code points. No tokenizer is
applied, so the results contain no token counts or estimates.

## Budgets and baseline

A budget fails only when `value > baseline × (1 + ratio) + floor`. Shrinking
always passes. `request.*` budgets use one host-independent baseline and are
compared on every host. The other budgets depend on the host and compare only
against a baseline recorded on a host with the same fingerprint: a hash of
the platform, architecture, hardware model, CPU model and count, memory in
GiB and OS major version. The committed baseline stores only that hash and a
coarse label such as `darwin-arm64`. Two Macs of one platform label do not
share a host baseline.

| Budget | Headroom |
| --- | --- |
| `restMemoryBytes`, `idleSessionsMemoryBytes`, `leftoverAfterStopMemoryBytes` | +25% |
| `idleCpuPercent` | ×2 plus 1 percentage point |
| `request.stationAddedTextBytes`, `request.stationAddedToolCount`, `request.stationAddedToolDefinitionBytes` | +10% |
| `request.sideCallCount` | none: a new side request is a discrete change |

### Exit status

The run exits non-zero when it did not complete, when any budget is over its
headroom, and when any budget is `NOT_MEASURED`: a metric that was not
measured (for example an engine that never became ready), a missing baseline
file, or a host with no baseline of its own. On a host without a baseline,
`--report-only` measures everything, compares nothing, prints
`REPORT_ONLY compared nothing`, and exits 0 only if every budgeted metric was
measured. `--evaluate=<result.json>` applies the baseline (and the same exit
status) to a saved result without measuring again.

### Recording

To record a baseline, run `npm run perf:station-weight -- --record-baseline`
on a clean tree and quiet host, and commit the file. Recording refuses a run
that did not complete, was dirty, or left any budgeted metric unmeasured, so a
gap never deletes a reference. It replaces the request values and this host's
entry, and keeps every other host.

### Ready time

`serverReadyMs` is reported with every run and never compared or recorded.
On one shared host, a median of several launches removes per-launch jitter
but not sustained load. Nine launches in one session (load average 21–24)
took 3.8–6.3 s each, and medians of three consecutive launches took
5.2–6.1 s. Twenty minutes later, at load 14–20 with a concurrent build
slowing the host, three launches took 9.4, 9.8 and 13.5 s, a median of 9.8 s.
A reviewer's single launches ranged 3.6–9.0 s. A +100% ceiling over a 5.2 s
median would fail a clean tree at 9.8 s, and one over 9.8 s would pass
anything under 19.6 s. Neither is a useful gate. Compare `serverReadyMs`
across several runs on a quiet host before claiming a change in launch time.

### Output

Each run writes `result.json` (metrics, per-process detail, request breakdown,
verdicts) and `requests.json` (every request the stub received) under
`.kontourai/station-weight/<sha>/<run-id>/`. Diff two results to compare
revisions. `--out=<dir>`, `--baseline=<file>`, `--settle-ms`,
`--settle-max-ms`, `--cpu-window-ms`, `--sessions`, `--stop-grace-ms` and
`--ready-launches` override the defaults.

## Gaps

- **Wakeups on macOS.** Per-process wakeup counts need `powermetrics` (root)
  or libproc, and `top`'s `IDLEW` did not advance between samples.
- **Windows.** The launcher is a bash script and the tree is read with POSIX
  `ps`, so the whole run reports `not_measured`.
- **Unready engine.** A memory sample that never settles, an engine that never
  reports ready, or a missing bundled binary makes the affected metrics
  `not_measured`, with the reason, and the run exits non-zero.
- **Idle CPU of short-lived processes.** The tree is read every 250 ms, but a
  slow read stretches that: on a loaded host reads were 376–377 ms apart. Not
  counted: the CPU a process uses after its last read before it exits, up to
  the longest span observed between the start of one read and the end of the
  next (`idleCpuPercent.maxReadSpanMs`), and any process that starts and exits
  between two reads. The window follows ancestry and the identities already
  seen, and rescans the environment only at its end, so a process that
  detaches before any read saw it and exits inside the window is missed
  too. The gap, with the observed span, is written beside every CPU
  value (`idleCpuPercent.gap`).
- **Context switches** (Linux) count only processes alive at both ends of
  the window.
- **A process that escapes between two reads without the run's
  environment.** A process that leaves the instance tree before any read saw
  it there, and whose environment carries no run tag as an exact entry, is
  not found after stop. That needs both: a double fork that completes
  between two reads of the tree, or before the run learned the roots from
  the instance record, and a child started with an environment that drops
  the tag, `HOME` and `TMPDIR` (for example `env: {}`), or one that
  overwrites its environment area before the next environment read. The
  reads are nominally 250 ms apart but share the event loop with the run's
  synchronous reads, so the interval is not bounded: each run records the
  longest it observed (`follow.maxIntervalMs`) and writes it into the gap
  text. macOS has no subreaper or cgroup to follow it. A process group or
  session can be left with `setsid`, and its id can be reused once the
  group is gone. The gap is written beside the value
  (`leftoverAfterStopMemoryBytes.gap`).
- **Report-only processes are left running.** A process the run counts but
  may not signal (see [Ownership](#ownership-kill-eligible-and-report-only)),
  an instance root without the nonce included, stays alive after the run. It
  is listed with pid, birth and command line; ending it is the operator's
  call. So is a process whose environment block was malformed: it is never
  kill-eligible, and is listed as unreadable.
- **A same-second pid reuse in the measurement.** A process remembered by
  identity is matched by its table birth token, whole-second `lstart` on
  macOS, so a pid freed and reused within the same second as a remembered
  process would be counted as the run's. It is never signalled on that
  basis.
- **macOS needs `python3`** with `ctypes` on `PATH` (the Command Line Tools
  provide it) to read environments exactly. Without it the run fails.

A gap that leaves a metric without a value makes it `NOT_MEASURED`, never
zero or a pass. Sampled idle CPU and the leftover memory are different: the
value is a lower bound that is still compared, so what the gaps above miss
can let a run pass.

## Limits

- One run is one sample on one host. Launch timing in particular swings with
  host load (`host.loadStart`/`loadEnd` are recorded). Compare several runs
  before claiming a change.
- `npm run perf:station-weight` is not a per-PR hosted check. Its end-to-end
  test, `scripts/__tests__/station-weight.end-to-end.process.test.ts`, is
  process-heavy, so the full-regression workflow runs it on `ubuntu-24.04`
  from main qualification (every push to `main` and every 6 hours). There it
  asserts the mechanics, compares the host-independent request budgets, and
  leaves the host budgets `NOT_MEASURED` because hosted runners have no
  baseline of their own.
- The control isolates what Station adds. It does not measure the engine's own
  prompt, which changes with the bundled Claude Code version.
- The end-to-end test runs the whole check with short windows, injects a
  daemon that detaches during shutdown and asserts it is found, kill-eligible
  under rule A and killed, asserts that following started from the instance record while
  `station start` ran and that the follower's own reads found every
  recorded root, and fails when Station's request additions exceed the
  committed request budgets. `scripts/__tests__/station-weight.process.test.ts` covers the
  process mechanics (identity, leftovers, CPU sampling, launcher capture,
  git isolation and the exit status) in seconds.
