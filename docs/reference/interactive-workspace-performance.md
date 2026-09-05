# Interactive workspace performance contract

`scripts/interactive-workspace-performance.mjs` is Station's single
performance-contract Module. Its synthetic adapter is smoke-only and executes
every named workload in a temporary isolated root. Reference mode invokes the
distinct `station-playwright-production-v1` adapter, which validates an
attached production bundle then calls a versioned product-owned in-page bridge.
The checker calculates percentiles, verifies generated provenance, and emits a
machine-readable report. The product bridge measures the shipped Task editor,
two-context live room, project FilePreview/DiffPanel, retained reconnect paths,
the Work Board seam, and separately scheduled actual one-hour observations.
The Work Board fixture opens the first-party Project Pane and registers its
driver only after the mounted surface can perform real query and interaction
work. A missing mounted Pane or physical reference environment is deliberately
reported as `NOT_VERIFIED`.

Accepted document publication completes its ordered, currently authorized
subscriber projection and yields an event-loop turn before synchronous revision
ledger validation begins. The HTTP settlement still awaits evidence linking;
seeing the working document does not prove that its evidence link is complete.
This scheduling rule preserves validation and improves delivery priority. It
does not bound the CPU cost of a growing ledger or establish the physical
latency budget without a reference run.

Every fixture report carries a versioned `foregroundWork` journal beside its
percentiles and verdict. It retains at most 64 incidents and accepts only closed
phase (`input`, `authoritative-apply`, `layout`, `render`, `pane-restoration`)
and UI-category vocabulary; document text, paths, identifiers, provider output,
and arbitrary labels never enter it. Browser builds attribute supported Long
Task/event-loop stalls to the deepest active foreground ownership interval and
record only durations at or above 50 ms; elapsed async or timer time is never
an incident. Unsupported Long Task collection and native foreground-executor
collection are each reported as `NOT_VERIFIED` rather than inferred.

## Fixtures and budgets

`scripts/fixtures/interactive-workspace/performance-contract.json` names fixed
fixtures: `workspace-edit-sequence-v1`, `accepted-operation-apply-v1`,
`two-participant-same-region-v1`, `plain-text-100k-lines-v1`,
`retained-operations-10k-v1`, `one-hour-production-collaboration-v1`,
`work-board-200-pins-v1`, and `work-board-one-hour-v1`. The 200-pin board
fixture deterministically seeds unique references for every `WorkReference`
kind, then measures the mounted first-party Pane's cache-bypassing restore,
grouped owner resolution, and keyboard-resize/pointer-move commits. Resolution
states are observed from the production owners; the fixture does not invent
unavailable or ambiguous owner outcomes.

| Seam | Initial p95 budget | Additional bound |
| --- | --- | --- |
| Local input/apply | input-to-model-commit <=16 ms | no interaction task >50 ms |
| Remote apply | accepted server-ingress-to-render commit <=16 ms | excludes transport from the budget and reports transport, server acceptance, state apply, and render separately |
| Synthetic collaboration | same-region visibility <=150 ms | reports the same component timings separately |
| 100k-line open | warm editable <=1 s; cold editable <=2 s | cold builds a fresh 100k-line corpus; warm discards five iterations |
| 10k-operation reconnect | retained replay and render <=2 s | beyond-window snapshot fallback is a separately attested branch, not part of the retained replay budget |
| One-hour collaboration | visibility <=150 ms | zero growth in retained UI nodes, listeners, and per-operation bookkeeping |
| Work Board, 200 pins | warm restore <=1 s; cold restore <=2 s | grouped resolution plus keyboard/pointer move/resize p95 <=16 ms and max task <=50 ms |
| Work Board, one hour | interaction p95 <=16 ms and max task <=50 ms | zero growth in board DOM nodes, listeners, pending interaction bookkeeping, and query/cache entries |

The reference environment identifies a dedicated Windows workstation
host, production build mode, warm/cold rules, and exactly 100 measured samples
after five warm-up samples. Each timing exposes nearest-rank `p50Ms`,
`p95Ms`, `p99Ms`, and `maxMs`; the 100k open and 10k reconnect limits
also enforce absolute `maxMs` bounds. Every fixture includes `failures` and
`degraded` counts; any degraded result fails the initial zero-degraded budget.

## Commands and truth boundary

`npm run performance:workspace:smoke` executes the synthetic fixtures for
deterministic PR feedback. It is explicitly scaled/non-reference (one-hour
fixtures simulate one minute), not a physical-reference-hardware claim. It
checks fixture shape and hostile budget breaches, not Work Board pointer or
one-hour acceptance.

`npm run performance:workspace:reference -- --output .kontourai/performance/interactive-workspace.json`
executes the real-browser adapter and evaluates only its in-run observations.
The scheduled Windows lane first builds the production server/UI bundles, then
the adapter attaches to `STATION_PERFORMANCE_UI_URL` and verifies its fetched
production HTML hash and in-page build commit against the local built
`dist-ui/index.html` receipt. CPU/RAM/OS
and revision are read at runtime; GPU/display are read through Windows system
commands. An absent target, Playwright runtime, bundle receipt, GPU, or display
is `NOT_VERIFIED`, never a synthetic or environment-variable PASS.

The reference UI build alone sets
`VITE_STATION_INTERACTIVE_WORKSPACE_PERFORMANCE=1`; ordinary production builds
tree-shake the installer. `STATION_PERFORMANCE_UI_URL` must name an
authenticated real Task workspace and include
`station-performance-reference=interactive-workspace-v3`. Both gates are
required before the versioned global is installed. The target URL must contain
no userinfo, fragment credential, or extra query data. The adapter also requires
exactly one runner-owned auth source: a canonical bounded Playwright
`STATION_PERFORMANCE_STORAGE_STATE` file (owner-private on POSIX) or a bounded
`STATION_PERFORMANCE_AUTHORIZATION` bearer value. It verifies the authenticated
Task discovery response before calling the bridge; absent auth is
`NOT_VERIFIED`.

The attached Station process separately sets
`STATION_PERFORMANCE_REFERENCE=1`. Only then, and only for an authenticated
batch carrying the exact diagnostic request header, its real Task-room batch
route returns a content-free typed receipt with server ingress and acceptance
epochs. The local-input fixture consumes marks emitted at the actual Task input
handler and its revision/text-bound React layout commit, then waits for the real
parsed worktree-diff surface layout commit. Remote-apply uses the same product
input/commit marks, the real Save action and opaque server plan/batch, and the
server receipt; browser fetch invocation or RTT is never labeled server
ingress. Missing or cross-epoch receipts make only that fixture
`NOT_VERIFIED`. The bridge returns raw marks only; the adapter passes the
checked-in v3 fixture/action definitions and the checker derives all metrics.
For remote apply, the components distinguish authoritative-document apply from
apply-to-layout commit; they are not mislabeled as one generic state-apply
delay. Authenticated document notifications keep exact order in a priority lane
that may pass queued presence/cursor projections but still rechecks current
authority immediately before the serialized wire write. A parsed accepted
snapshot/delta is applied directly to the mounted Task editor and normalized
into the authoritative document query in the same ingress turn; a gap,
duplicate, or malformed envelope still forces the no-cache document read.

The reference workflow now provisions its own temporary Station home, exact
checkout build, six dedicated Project/Task documents, and two independently
paired browser authorities. Every implemented fixture receives a fresh
authenticated browser context and its own Task/surface; the adapter closes that
context before proceeding, so a terminal stream or backlog in one fixture
cannot contaminate the next. The collaboration fixture drives shipped
leave/join/announce and cursor controls from the peer while the owner records
server-identity-bound participant and cursor layout commits. The file fixture
rebuilds the deterministic 199,999-byte, 100,000-line corpus for every cold
phase, fetches it through the project-bound FilePreview, scrolls that real
surface, and renders the real DiffPanel. The reconnect fixture seeds exactly
10,000 canonical accepted operations through the non-HTTP E2E IPC and real
working-state SQLite adapter: one isolated Task replays a retained `delta`,
while a second Task receives operation 10,001 and proves the distinct `gap`
then snapshot-render branch. No raw path, operation payload, or content enters
the bridge receipts.

The ordinary reference job remains intentionally shorter than one hour and
therefore reports one-hour fixtures as `NOT_VERIFIED`. The scheduled Windows
lanes perform five warmups and 100 real samples across an unscaled hour.
`work-board-one-hour-v1` captures start/end board DOM nodes, mounted interaction
handler surfaces, pending interaction bookkeeping, and board query/cache entries.
A deterministic fake clock is allowed only in bookkeeping unit tests, never this
acceptance lane. `logicalDurationMs` is exactly 3,600,000,
`observedDurationMs` is at least 3,600,000, and `scaled` is false; display loss,
unavailable/cancelled physical hardware, missing pointer seam, runner
interruption, malformed counts, or a short observation is `NOT_VERIFIED`, never
a pass. The
versioned bridge returns one raw measurement record for each measured iteration
it actually owns. Its checked-in phase/action sequence defines distinct,
causally ordered marks: input event to model commit; remote ingress, transport
arrival, server acceptance, state apply, and render commit; participant/cursor
visibility; warm/cold file-open, scroll, and diff render; and reconnect/replay/
render or the independent beyond-window fallback branch. The record rejects an action that starts before its
predecessor finishes, unknown marks, and any action or mark not owned by a
metric/component derivation.

The checked-in per-fixture derivation map is the only source for metric and
component samples; optional aggregate arrays are accepted only when they are
numerically identical to the checker-derived values. This keeps the trust
boundary clear: the build-receipt-matched product bridge supplies raw marks and
the checker owns derivation and budgets. The checker rejects arbitrary page
data: it validates bridge version and source, fixture IDs, exact sample counts,
raw action attestations, checked-in corpus digest, fallback/growth/duration
evidence, and the production bundle receipt. A one-hour reference fixture must
report an actually observed hour; the virtual one-minute run is smoke-only.

The validator requires exact sampling/component counts, fresh generated-in-run
provenance, action-derived fixture corpus identity/checksum, matching revision,
required hardware/OS/build metadata, fallback evidence, and long-session
duration. Missing, stale, or mismatched reference evidence is `NOT_VERIFIED`,
never `PASS`. Reference artifacts remain fresh for at most 60 minutes: this
covers the scheduled lane's bounded 55-minute reference test plus handoff and
upload headroom, without accepting an earlier run as current evidence.

## Decision rule

Each seam yields `keep` when it meets the provisional budget and `optimize`
when it fails. `replace` is never automatic: a rewrite proposal must name the
missed budget and show a representative prototype closing it. Missing reference
hardware or an unavailable pane bridge yields `NOT_VERIFIED`, not a rewrite
implication. The Work Board browser/reference test is an acceptance resource;
the bridge registration unit test and PR smoke are scoped static/diagnostic
evidence only.

The PR smoke is wired into the existing fast-checks job. The scheduled reference
workflow remains separate and reports `NOT_VERIFIED` rather than treating
arbitrary CI hardware as reference evidence.
