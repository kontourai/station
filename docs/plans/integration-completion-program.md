# Integration completion program

Status: implementation in progress under [#4358](https://github.com/kontourai/station/issues/4358). This plan records delivery scope; it does
not establish provider, browser, device, release or deployment qualification.

## Shared capability contracts

Station owns the public operation, capability and result contracts. An engine
adapter or a Station implementation owns execution. UI, SDK and CLI callers
consume the same contract without selecting behavior by engine name.

Each capability identifies its implementation owner, supported operations,
limits and observed availability. Unsupported, temporarily unavailable and
unknown remain different outcomes. Configuration, method presence and version
strings alone do not establish successful execution. A shared interface never
substitutes prompt text for a native control silently.

Goals are the first application: objective, state, usage and budgets are
separate from Task status and workflow acceptance. Provider-owned goals keep
their native scheduling and accounting. A Station-owned implementation must
use existing durable execution and scheduling owners, including admission,
pause, cancellation and recovery. It is unavailable until that behavior exists.
The first Codex slice exposes reads, paused-objective saves, pause and clear.
It does not advertise resume: native autonomous continuation still needs
Station's durable admission and recovery integration. Other adapters without
the Goal interface report unsupported.
Setting or resuming a goal can start work and spend provider allowance; reads
cannot start or resume a session. New controls ship behind a default-off Feature
Preview with authorization at every entry point.

## Delivery sequence

| Workstream | First complete slice | Acceptance and existing owner |
| --- | --- | --- |
| Knowledge and memory | Preserve search health through both MCP profiles, then complete capture-to-recall and correction | Distinguish no match, stale index, withheld sources and unreported health. Extend #4030 and #1228; retain canonical records and explicit scope. |
| Engine controls | Provider-neutral Goals contract, supported adapter, authenticated SDK/UI operations | Exercise real protocol requests, unsupported engines, state/budget preservation, uncertain mutations and restart. Native completion never closes a Task or passes a gate. |
| GitHub Actions | Inspect the exact check's run attempt, jobs and steps from PR review | Bind repository, PR head, run, job and attempt; preserve execution SHA separately. Read failures and truncation remain visible. |
| Run and Preview | Launch an explicit Project command through TerminalSessions and open its admitted ready target | Correct checkout and execution host, one owned process, readiness, stop and reconnect. Use existing browser/pane owners. |
| Browser and devices | Complete common-engine invocation before adding controls; then install/launch/debug | #122 owns bound invocation, #1970 app lifecycle, #1971 diagnostics, #1973 remote qualification and #2760 frame/input admission. |
| Basis and Review | Qualify existing exact-answer, capture, pinned comments and feedback delivery | Reuse #418 and Task Review; inspect before Keep, preserve source/Task identity, recheck authority, expose gaps and retain dissent. |
| Resources | Repair measured demand/read/render bottlenecks | Follow #3818, #3816 and #584; retain baselines and do not replace the runtime without a missed budget. |

## Custody and qualification

At the initial source checkpoint `2a740cb43031655fbb33d549bfb0ba94a09113e3`,
PR #4334 owns Task timeline and device capture, and #4351 owns integration status
and write-back history. Coordinate through their existing interfaces and refresh
live ownership before touching overlapping source. Browser/device tab and host
work in #4095 is already merged; older issue checkpoints are historical.

Use focused behavior tests and independent review per delivery slice. Preserve
pre-fix failures and clean-tree fault controls. Source, fixture, real-engine,
native shell, simulator, physical device and installed-release results remain
separate. A copied artifact, open preview, successful process or engine reply is
not evidence that the complete user journey succeeded.
