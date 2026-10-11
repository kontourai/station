# Monitoring & Telemetry

Station has three separate measurement paths:

| Path | Owner and destination | What enables it |
| --- | --- | --- |
| Local monitoring events | `MonitoringEmitter` and daily NDJSON files; read by Monitoring and Insights | Runtime event producers; independent of OTel export |
| OTel metrics and traces | OpenTelemetry SDK → configured collector | `OTEL_EXPORTER_OTLP_ENDPOINT`, subject to SDK configuration and persisted installation identity |
| Product-usage telemetry | `UsageTelemetryService` → configured usage endpoint | Endpoint configured, telemetry enabled, and the current disclosure receipt acknowledged |

Product observations use the disclosed v1 envelope: stable retry IDs, producer
times, inventory revision and allowlisted immutable build attribution on every
event. The optional [product receiver](../../packages/telemetry-broker/README.md)
authenticates separate product source keys, durably commits PostgreSQL observations,
and deduplicates retained source/event UUIDs. Its operator queries describe received
observations with unknown delivery coverage; these observations are separate from
canonical personal receipts. Acknowledgements
must name the displayed inventory revision, so stale/older UIs cannot silently
approve newly exported fields. See the [usage inventory](../reference/usage-telemetry.md).

The repository includes an optional Docker example for Collector → Prometheus
→ Grafana metrics and Collector → Jaeger traces. Starting that example is not
proof that Station recorded or delivered a measurement. The local event log is
also separate from the canonical orchestration EventStore.

Configured OTel registers its providers synchronously when the telemetry module
loads, before Station creates its instruments. Installation identity resolves
as an asynchronous resource attribute; export waits for it without delaying
application startup. Hosted persistence admission precedes schema/identity
writes; deployment-mode detection has no metric imports that could create
instruments before provider registration. Failed identity persistence stops the SDK and refuses
export rather than sending an unidentified payload. With no endpoint, the SDK
stays inactive and performs no identity I/O.

The [telemetry regression](../../src-server/__tests__/telemetry.test.ts) records
the actual exported chat counter while identity I/O is held, then observes both
that record and a later record at a loopback OTLP receiver with the persisted
identity hash. A failure control receives no payload, and unsafe hosted homes
remain untouched. This repairs
[#2755](https://github.com/kontourai/station/issues/2755); it does not qualify a
deployed collector, storage backend or dashboard. The tables below remain
declarations and recording call sites, not proof of those destinations.

## Developer diagnostics

Developer → Monitoring provides five views over existing Station measurements:

| View | Source and limits |
| --- | --- |
| Activity | Live monitoring events plus bounded file history. Search and filters apply to loaded rows. The expandable session list reads canonical current session summaries independently of the event window. |
| Tool latency | Reported `station.tool.duration_ms` on filtered tool-result events. p50/p95 use measured durations only; unreported durations and outcomes remain separate. Truncated or failed history makes the result partial. |
| Usage | Existing usage receipt rollup and operator-only Station usage overview. Reported cost, estimates, currency and coverage retain their existing distinctions. |
| Context | Latest statistics for a selected session with an assigned Agent and conversation identity. Engine observations and Station estimates are labeled separately. Missing conversations or unreported measurement sources do not produce a percentage. Occupancy is not token consumption. |
| Routing | Recent consuming and serving inference receipts, using each reader's own bounds. |

Developer → System → Performance polls host CPU and memory diagnostics every
five seconds while mounted. The CPU probe keeps its shared cache and sampling
interval; host memory and Station-process RSS/heap have a separate observation
time in `resources`. The chart retains up to 60 received samples during that
mounted visit, not durable historical performance. System → Services exposes
existing engine and capability readiness reasons. Developer → Logs offers
optional refresh, time bounds and structured records with scan-coverage warnings.
See the [Developer surface](../design/developer-surface.md) for implementation
owners. None of these views requires OTel export to be enabled.

## Profile usage and paired people

The [Profile page](../../src-ui/src/pages/ProfilePage.tsx) puts the current
identity next to usage on the connected Station. These are different scopes:
the identity does not make the Station-wide retained-source summary a personal total.
Lifetime counts combine saved messages with completed external-engine turns.
Daily and model breakdowns include retained file-memory messages and external-engine
observations. UTC days use saved-message timestamps and canonical provider-event
`createdAt` values, not precise consumption dates or the receipt ingestion clock. Completed external-engine turns contribute activity on their
recorded UTC day. Missing or invalid dates, missing models and unknown principal or
provider attribution remain in `unallocated`. Saved messages have no authenticated
principal or provider writer and remain unallocated in those dimensions even if
arbitrary metadata names them. Engine person attribution uses the server-stamped `turn.started`
principal; usage-event principal fields cannot override it. Current app or Agent configuration
never fills historical gaps.
The hero graph shows the last 14 UTC days rather than the last 14 populated rows.

[UsageAggregator](../../src-server/analytics/usage-aggregator.ts) rebuilds the
snapshot on an active read when the previous scan is at least a minute old.
Concurrent readers join that rebuild. Idle Stations retain the existing
30-minute startup timer. The Profile page displays the scan timestamp, failed
refreshes, unavailable engine reads, and skipped message rows. **Rebuild usage**
forces the existing rescan. Clearing the aggregate is not a history deletion;
retained transcripts and receipts rebuild it, so the profile does not offer a
permanent-reset action.

The current summary is rebuilt from retained records. Corrected or deleted facts
can decrease its counters and remove obsolete date, model and Agent buckets. Any
saved summary from before this projection is preserved separately as
`legacySummary` with `evidence: "unverified"`; it contributes nothing to current
figures. Retention therefore limits current coverage.

The shared usage fold applies each provider's token and cost scopes once while
producing record allocations. Per-call measurements use their recorded model.
Initial cumulative thread/process baselines and intervals crossing model changes
remain unallocated by model and principal. A downward cumulative token correction
cannot identify the earlier buckets to subtract from, so its corrected total is
unallocated by date, model and principal. Thread-cumulative Codex tokens survive
process restarts. Claude cost allocations use the same running-total segments as
the session total: a resumed process continues its previous total; a fresh process
or a lower cost figure starts a new segment and retains the previous spend.
These distributions are recorded observations, not an exact consumption split
or a billing statement.

`tokenReports` counts retained measurement contributions, including explicit zero.
A numeric compatibility sum without a corresponding report remains unmeasured.
Optional `reportedCostUsd` and `estimatedCostUsd` keep provider-reported amounts
and saved estimates distinct. No rescan reprices historical records. The receipt
rollup below separately carries currencies, pricing snapshots and missing-source
coverage for bounded comparisons.

A Station-agent relay identifies its saved transcript only through canonical
relay provider, one consistent recorded `agentId`, and the exact thread ID used
by its `/chat` request. Saved messages remain the primary ledger for that join;
`mirroredEngineActivity` separately discloses relay sessions and completed turns
with partial coverage because exact per-turn overlap is unavailable. A matching
conversation ID alone never excludes an unrelated external engine. Ambiguous
Station-agent overlap is held outside current totals as `ambiguousRelayActivity`,
with its activity count and any measured evidence preserved separately.

Station milestones use this current retained-source summary, not a person's
sent-message count. A cost milestone does not unlock from unreported engine or saved-assistant
cost, completed engine turns without cost, unknown exact relay overlap, skipped
message records, or a failed engine read. Message-write and enrichment notifications invalidate the projection; the next
active reader rebuilds it rather than adding replacement usage again. Replacement
retains the original timestamp, including an unknown or invalid timestamp; it
never gives an undated retained record today's date. Its
API result supplies `measurementUnavailableReason` and omits numeric progress;
the UI shows that gap instead of a budget amount or progress bar. A reported
zero cost remains a real measurement. `snapshot.projection` identifies
`retained-source-v1`; `snapshot.dayScope` identifies
`recorded-observations-utc`. These markers do not establish complete historical
coverage. The [public stats DTO](../../packages/contracts/src/usage-stats.ts)
exposes recorded-principal and recorded-provider buckets for authorized consumers.
Recorded-person breakdowns require the bound local operator boundary; a principal
is attribution, never a grant or a claim of personal lifetime totals.

| Ingress | Usage the current implementation can observe | Limits |
| --- | --- | --- |
| Claude engine | Per-turn input/output/cache tokens and provider-reported USD cost | Cost is a running total. A process that resumes its transcript continues that total; a restart without resume, or a lower figure, starts a new total that is added |
| Imported Claude transcripts | Input/output/cache tokens accumulated from assistant records | This importer supplies no provider-reported cost |
| Codex engine and imported rollouts | Session-cumulative input/output and cache-read tokens | No provider-reported cost; cumulative totals are not per-answer deltas |
| Imported OpenCode sessions | Per-turn input, output (reasoning included) and cache read/write tokens, summed from the turn's steps | OpenCode's own cost figure is an estimate from its price catalog, not a provider charge, so it is not imported |
| Bedrock and Ollama adapters | Tokens reported for each model call | Absent usage stays absent; cost estimates need an eligible pricing snapshot |
| Muse serve | Model-call input/output/cache figures, emitted as per-turn usage | Uses the wire `usage` object rather than `cumulative`; child-work usage stays a separate projection |
| Muse stdio | Completed work and other reported lifecycle facts | Its envelope supplies no token-usage event |
| ACP, including ACP-backed engines | Reported context occupancy/window | Occupancy is not consumed tokens; arbitrary-currency ACP costs are not projected |
| Station agent / direct model-provider chat | Saved messages and their recorded usage/estimates | Canonical relay joins use saved messages as primary; overlapping engine activity is separately disclosed |

Attached Claude transcripts retain a bounded record-to-turn ancestry map in the
persisted cursor. Older aggregation cursors recover identities from a bounded
look-behind when their active user boundary is still available. A late
turn-duration record closes its known parent turn
without clearing a newer turn's usage. Unknown or evicted ancestry does not
close the current turn; the next user boundary can still flush its usage.
The bounded per-turn conversation window retains all Claude and Muse usage
observations, including split observations already persisted before this fix.
Codex session-cumulative observations still use the latest snapshot. This
repairs [#581](https://github.com/kontourai/station/issues/581); it does not
expand the window's event or byte limits.

The viewer receipt panel partitions its cache by captured Station authority and
credential-profile filter. A lost scope hides cached rows; 401/403 pauses polling
until retry. Pagination restarts when authority changes. Current cost cards say
**Not reported** when no cost contribution exists, while measured zero stays
numeric. An empty retained history cannot certify a cost-per-message milestone.
Cache-only and total-only engine measurements count in token-reporting coverage.

The receipt panel reads an aggregate separately from its drilldown page. Local
aggregate reads select at most 500 observations; a page selects at most 100.
Reaching the aggregate limit produces partial coverage. Paired transfer applies
replacement and deduplication before its separate 500-receipt limit, preserving
explicit dropped-material coverage instead of failing the entire peer read.

A context-only ACP observation produces no empty token receipt and does not
count as a consumed-usage report. Codex token snapshots retain one identity
across engine-process restarts. A Claude cost snapshot keeps one identity per
running total. A process started with the SDK `resume` option continues the
total its transcript saved, so its figures replace the previous process's.
A restart without resume starts a new total. A figure lower than the one it
would replace also starts a new total; a missing-transcript resume reports
`0`, for example. The session cost and the receipt rollup use the same rule.
`session.started` events recorded before this marker existed read as restarts,
so older resumed sessions can still over-report their cost. The SDK reports
no starting total, so the rule has two blind spots. A reset or a resume whose
transcript saved no total undercounts when its first figure already exceeds the
previous total. A restated total slightly below the last live figure starts a
new total and overcounts.

Durable event sequence resolves equal Station-observation timestamps,
and sparse cumulative updates preserve previously reported components.
Combined counter estimates remain unpriced when their model, price snapshot,
or inherited component evidence does not support one estimate. These receipts
are observations; their latest cumulative snapshot is not a per-day consumption
delta or an exact mixed-model allocation.

These are implementation and captured-wire/fixture boundaries, not a new live
billing reconciliation across every account and model. The scope declarations
live in [the shared usage fold](../../packages/shared/src/usage-fold.ts); the
[receipt fold](../../packages/shared/src/usage-rollup.ts) owns rollup grouping.
The Muse serve fixture replay also exercises per-answer usage visibility.

### Usage with children

The conversation statistics dialog shows **Usage with children**: one total
for the conversation and everything that ran under it, and a breakdown (own
turns, then each subagent and delegated task, nested) with tokens, cost, tool
uses and duration. Each child says in words whether the total counts it. The
read is the [conversation usage tree](../reference/session-api.md#conversation-usage-tree-get-conversationsconversationidusage-tree),
and the per-engine rules live in
[the tree fold](../../packages/shared/src/thread-usage-tree.ts):

| Child | Tokens | Cost | Evidence |
| --- | --- | --- | --- |
| Station-delegated task (this Station) | Added | Added | A delegate is its own session with its own receipts |
| Station-delegated task (paired Station) | Not counted | Not counted | Its usage is recorded on the other Station |
| Claude Code subagent | Not counted | Already in the parent's | The SDK documents `result.usage` as main-loop only and `total_cost_usd` as covering Task subagents. A measured run matched both. A subagent's own `total_tokens` equals its last request's size, not its consumption, in recorded transcripts, so it is shown as "last request", never as tokens used |
| Codex subagent | Added | Not counted | Each child is its own thread; in the recorded collab captures the parent's cumulative total is the sum of its own calls only |
| Muse workflow subagent | Added | Not counted | In the recorded `muse serve` captures the session's cumulative figures exclude the child's usage |
| Any other engine | Not counted | Not counted | Undeclared; never guessed |

"Not counted" makes the total partial, and the dialog lists why. A subagent's
own figure is still shown in the breakdown. The token total is input + output
only, unlike the dialog's own "Total", which adds cache where that is backed;
the breakdown says whether its input figures exclude cached input, says so when
that isn't established for an engine, and says the sum mixes measures only when
two engines are declared to count cached input differently. Costs in different
currencies, and estimates under different price snapshots, are listed side by
side and not added together. The tree covers sessions on this Station only.

Delegated tasks are found from the delegation context Station stamps at
launch, or from a `parentTaskId` the request names. For a Claude Code or Codex
session's `delegate_task` call Station derives the context from the calling
session's own record; for Station's own agent the runtime attests it from the
conversation the tool call ran in. A task launched through a caller-less
station-control process (as a Strands-runtime agent uses) names neither, so it
is not found and not shown as missing. A task you can't read is never named
or figured. When Station derived or attested its link to your conversation
(in hosted mode, a delegate Station couldn't attribute to a bound caller is
the Station operator's), the total is partial and says how many such tasks
there are. When the link was only a request's claim, the task is ignored, so
no one can mark your total partial by naming your conversation. The tree
refreshes every 15 seconds while the dialog is open, and stops after a 404 or
422.

**People paired with this Station** reads the existing paired-device registry
through a captured API/authority scope. Only active interactive devices with an
approved person binding contribute. Account issuer plus subject (or approved
tailnet subject) separates people; devices for the same person are grouped.
Names come from those bindings, not a guessed user-directory alias. The detail
shows their approved devices and last authenticated request, when recorded.
An open primary event stream is shown as connected; absence of a reported stream
is not a claim that every client is offline. A failed registry read hides cached
profiles. HTTP 401/403 pauses registry polling to avoid consuming the auth-failure
rate limit; an explicit retry can reauthorize it. This surface grants no access and shares no personal usage statistics.

### Operator view of this instance

Open **Profile → This Station → View station usage**.
Activity bars rank recorded messages and completed turns; **Tokens & costs** opens
the full measurement table. The authorized local operator can inspect usage by engine or
provider, model, person/principal, and UTC day. **Unknown / unallocated** keeps
missing attribution visible. Identity comes from server-stamped events; saved
message metadata cannot certify a person. Corrections and deletions change
current totals. Ambiguous relay activity is shown separately and excluded from
those totals. Token report counts preserve measured zero; a missing measurement
shows a dash. Reported cost and recorded estimates stay separate.

The instance read requires the runtime-bound home-possession local operator and
is unavailable on hosted deployments or tenant workers. Ordinary analytics and
rescan responses omit the person breakdown. The SDK partitions its cache by
Station and captured authority; an access error hides cached results, and
401/403 pauses polling until retry. The view queries no peer Station.

Measurements currently come from retained conversation history and
orchestration events. Native direct invocations, inference served for peers,
voice/realtime, embeddings, and provider activity outside recorded sessions are
not independently metered here. Their existing lifecycle/routing receipts do not
contain durable token/cost measurements. Fleet-routed measurements saved in a
conversation are counted through that conversation once. Do not add serving and
consumer observations together without shared call correlation. Context
occupancy is not consumed tokens, and some harnesses report activity without
usage. The overview's **Coverage & sources** explains these boundaries;
missing measurements are not zero. Fixture/source verification does not prove a
live provider invoice, every plan, or historical usage recovery.

The Profile page keeps receipts, milestones, diagnostics, and detailed activity
history in expandable sections. **About these totals** explains the summary
without repeating it above every chart. Main usage refresh failures remain visible; each expanded section shows its own
access or read failure.

## Quick Start

```bash
cd monitoring && docker compose up -d
```

| Service    | URL                        | Credentials     |
|------------|----------------------------|-----------------|
| Grafana    | http://localhost:3333      | admin/station   |
| Prometheus | http://localhost:9090      | —               |
| Jaeger     | http://localhost:16686     | —               |
| Collector  | http://localhost:4318      | OTLP HTTP       |

The Grafana dashboard auto-provisions from `monitoring/grafana/dashboards/station.json`. No manual import needed.

## Environment Variables

| Variable                    | Required | Default     | Description                                      |
|-----------------------------|----------|-------------|--------------------------------------------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OTLP HTTP base endpoint. Unset means no OTel SDK initialization; local monitoring remains available. |
| `OTEL_SERVICE_NAME` | No | `station` | OTel service name. |
| `STATION_TELEMETRY_API_KEY` | No | — | Optional `x-api-key` header for OTel export. This is not the product-usage key. |
| `STATION_EVENT_LOG_RETENTION_DAYS` | No | `30` | UTC daily monitoring files retained on disk. |
| `STATION_EVENT_LOG_MAX_BYTES` | No | `268435456` | Maximum retained monitoring-event bytes; the active UTC day's file is protected. |

To enable telemetry against the local stack:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=station
```

<a id="resource-attributes-and-a-breaking-rename-station2484"></a>

## Resource Attributes, and a Breaking Rename (archive#2484)

Station supplies these two resource attributes:

| Attribute | Value |
| --- | --- |
| `service.installation.id` | SHA-256 of a random UUID created once per install and stored at `STATION_HOME/config/otel-installation-id`. Stable for that install, independent of the machine. |
| `os.type` | Platform name. |

**`user.anonymous_id` is removed.** It was `sha256(hostname:username)` truncated to 48 bits — a deterministic function of the OS username, so anyone holding the value and a candidate list of hostname/username pairs could confirm a match. The name claimed a property the value did not have.

If you have dashboards, alerts, saved queries, or cardinality groupings keyed on `user.anonymous_id`, **they will stop receiving it** and must move to `service.installation.id`. The values are unrelated — the new one is random, so historical series cannot be joined to new ones. Treat it as a new dimension rather than a rename in your backend.

It remains a stable **pseudonymous** installation identifier: consistent within your collector, so per-install grouping still works. It is not "anonymous" in a sense implying unlinkability inside a store that also holds other data about that install.

This is not the complete SDK resource inventory. The pinned Node SDK defaults
to environment, process, and host detectors unless its detector configuration
is overridden. Those can add host name/ID, process owner, executable and command
arguments. A random installation ID does not remove those other fields.
Inspect the effective SDK configuration and emitted resource before making a
claim about identity linkage. This audit inspected the pinned implementation;
it did not read real detector values or send them to a collector.

## Local Event History and Retention

Station writes queryable monitoring events as daily NDJSON files under
`<STATION_HOME>/monitoring`. Retention removes closed-day files older than 30
days, then removes the oldest closed-day files to reduce retained history
toward a 256 MiB budget. The active UTC day's file is protected, so the byte
setting is not a hard cap on all monitoring data. Invalid environment values fall back to these
defaults.

These files are operational telemetry, not the canonical orchestration event
store. To preserve a longer audit or diagnostic window, copy the NDJSON files
to an export directory before they leave the configured retention window. Files
that do not use Station's `events-YYYY-MM-DD.ndjson` naming scheme are excluded
from automatic retention.

<a id="a-counter-is-not-a-local-read-path-station1686"></a>

## Local evidence and the historical migration shadow

Without an OTel SDK, metric instruments **discard their writes**. Configured
startup registers providers before creating instruments; an instrument created
by a different entry point before registration can still bind to a no-op meter.
Such discarded observations are not recoverable after the fact. That is fine
for a rate you would only ever read on a dashboard, and it
is *not* fine for a counter some gate is supposed to read as evidence: an
instrument that throws its writes away produces exactly the same silence as a
subsystem that agreed with everything, and the reader cannot tell them apart.

If a metric is load-bearing for a decision, it needs a local record as well.
Station's own server logs are one instance of this: `station.logs.read` counts
read-path *queries*, but the durable local record is the NDJSON store itself
(`<STATION_HOME>/logs/server/`) plus its self-read path — `GET
/api/diagnostics/logs` and the `read_logs` MCP tool (archive#1896 slice 2, see
[docs/reference/config.md#logging](../reference/config.md#logging)) — so the logs
this section's own counters describe are themselves locally readable, not just
counted.

The worked example is the project-resource migration shadow
(archive#1501 slice 3a): alongside `station.project_resource.shadow_comparisons`
it aggregates comparison counts by dimension in a per-home
record at `<STATION_HOME>/project-resource-shadow.json`
(`src-server/services/projects/project-resource-shadow-record.ts`). Read it
with:

```bash
npm run project-shadow:report              # rendered summary
npm run project-shadow:report -- --json    # machine-readable
npm run project-shadow:report -- --gate    # requires intact coverage with no
                                         # divergence or tripwire outcomes
```

The record's shape is what makes it honest: an outcome that has never been
observed is **absent**, never a zero row, and a home with no record at all
answers `NOT OBSERVED` for every question rather than `0`. "The observer ran
and saw agreement" and "the observer never ran" are different answers.

**What a passing `--gate` does not prove (archive#1775).** The gate states its
own limits: it prints a `WHAT THIS PASS DOES NOT PROVE` block alongside a
passing verdict, and `--json` carries the same strings as `gateLimits`. Read
them there rather than here — one of the two is *derived from the record* (the
seams actually observed), so a copy in this document would go stale exactly
when it mattered, and a second, differently-worded copy is how a limit quietly
stops matching the thing it limits.

The short version, for orientation only: coverage is a statement about a
*home's history*, not about the resolver currently on disk. The current runtime already wires `createProjectSessionDirectoryResolver`
and uses it after the legacy shadow comparison. The old one-way-flip discussion
is migration history, not an instruction to perform another cutover. This
record still does not identify the resolver revision that produced each count;
a recovered record is a qualified floor and does not pass the gate.

The write is deliberately `tear-safe` rather than fsync-durable: it happens
on the resolution path. It keeps the same-directory temp file, atomic rename
and retained `.previous`, and omits the fsyncs. Earlier notes reported about
15 ms with fsync and 0.4 ms without; this audit did not repeat those measurements.

Be precise about what that gives up, because an earlier version of this
paragraph was wrong. `rename()` is atomic for concurrent readers either way,
so no reader ever sees a half-written file. What fsync bought was
data-before-metadata ordering across a **power loss**: without it a filesystem
that commits the rename before the temp file's data leaves a primary that
exists and is garbage — not an undercount, but the loss of every accumulated
observation, and (because the writer correctly refuses to overwrite a record
it cannot read) a home that would never record another one.

`tear-safe` is therefore only honest because the reader **recovers**: a
primary that is present but unusable falls back to the retained `.previous`,
exactly as a missing one already did, and the resulting report is marked
`RECOVERED` with its counts declared a floor rather than being passed off as
intact. The residual is losing the observations written since the last
rotation — that much *is* the undercount direction the record already
discloses for cross-process writes. A future-versioned primary deliberately
does **not** recover: it is intact, not corrupt, and falling back would let an
older Station overwrite a newer one's history.

## Stack Architecture

```
Station server
  └─ OTel SDK (src-server/telemetry.ts)
       ├─ Traces  → OTLP HTTP :4318/v1/traces  → Collector → Jaeger
       └─ Metrics → OTLP HTTP :4318/v1/metrics → Collector → Prometheus → Grafana
```

`src-server/index.ts` imports `src-server/telemetry.ts` before runtime/instrument
modules. Provider registration runs before the initializer's first await;
installation identity and export readiness remain asynchronous. A failure
warns and Station continues. Alternate entry points must preserve registration
before instrument creation. The configured SDK includes:
- `HttpInstrumentation` — auto-instruments HTTP requests, rewriting long hexadecimal, colon-bearing, and encoded-colon path segments to `:id` (not every route parameter)
- `AwsInstrumentation` — auto-instruments AWS SDK calls
- A `PeriodicExportingMetricReader` with a 30-second export interval and delta temporality
- No SDK log exporter: Station's durable logger remains a separate local path.
  `OTEL_LOGS_EXPORTER` does not implicitly add an unreviewed export signal.

## Metrics reference

These are the instruments covered by this guide. The generated
[declaration catalog](../reference/metrics.md) lists every instrument declared
in [the definitions](../../src-server/telemetry/metrics.ts); it does not prove
that an instrument records or exports observations. Follow the
recording owners below. Attribute sets are unions across current callers; not
every observation carries every attribute. Several families mix route and
domain operations, so their totals are not counts of one business action.

<a id="counters"></a>
<a id="chat--tokens"></a>

### Counters with recording calls

| Instrument | What the current callers record | Attributes |
| --- | --- | --- |
| `station.chat.requests` | Primary-chat finalization plus separate invocation requests; these are different populations | `agent`, `plugin`, or `op` |
| `station.tokens.input`, `station.tokens.output` | Reported usage at primary-chat finalization; missing values are omitted | `agent`, `plugin` |
| `station.tool.calls` | Tool-call chunks seen by `MetadataHandler`; external-engine bridge calls do not increment this counter | `tool` when reported, `plugin` |
| `station.chat.errors` | Outer chat-route failures; not every streaming failure | `agent`, `plugin` |
| `station.cost.estimated` | Positive primary-chat estimates with supported pricing; not total provider spending | `agent`, `plugin` |
| <a id="plugins"></a>`station.plugin.installs`, `station.plugin.uninstalls`, `station.plugin.updates`, `station.plugin.settings_updates` | Their plugin lifecycle/settings operations | `plugin` |
| <a id="crud-operations"></a>`station.agent.operations` | Agent route and service operations | `op` or `operation`, sometimes `agent` |
| `station.project.operations` | Project route and service operations | `op` or `operation`, sometimes `project`, `outcome`, `source` |
| `station.tool.definitions.operations` | Tool-definition management, separate from tool execution | `op` |
| <a id="providers--infrastructure"></a>`station.provider.operations` | Provider management and adapter outcomes | `op` or `operation`, plus `type`, `provider`, `reason`, `model_options`, `outcome`, `status` where supplied |
| `station.notification.operations` | Notification service/route operations | `op` |
| `station.notification.agent_operations` | Agent notification admission outcomes; no content or Session identity | `result`, `urgency` |
| `station.scheduler.job.runs` | Actual job outcomes **and** management requests; currently not an execution-only count | `job`, `status`, or `op` |
| `station.scheduler.concurrency.deferrals` | Invocation-capacity lifecycle outcomes | `reason`, `disposition` |
| `station.mcp.lifecycle` | MCP connection lifecycle observations | `event`, `server` |
| `station.mcp.negotiation.total` | Negotiation outcomes | `era`, `protocol_version`, `fallback`, `extensions`, `outcome`, and failure-only `error_class` |
| `station.knowledge.operations` | Knowledge operations, including derived-index unavailability | `op` |
| `station.feedback.operations` | Feedback route/service and context operations | `op` or `operation`, plus `rating`, `agent`, `reinforceCount`, `avoidCount`, `durationMs` where supplied |
| `station.approval.operations` | Approval registry operations | `operation` |
| `station.terminal.operations` | Terminal service operations | `operation` |
| `station.acp.operations` | ACP connection configuration create/update/delete, not the full lifecycle of engines connected through ACP | `op` |
| `station.voice.operations` | Voice Session and route operations | `op` |
| `station.template.operations` | Template listing/application | `op` |
| `station.conversation.operations` | Conversation operations | `operation`, with `source`, `outcome`, `agent`, `format` where supplied |
| `station.coding.operations` | Coding file/search/Git/execution operations | `operation` |
| `station.auth.operations` | Auth status, renewal and user search operations | `operation` |
| `station.filetree.operations` | Filesystem route and file-tree/preview service operations | `op` or `operation`, sometimes `outcome` |
| `station.registry.operations` | Registry operations | `operation`, with `outcome`, `source`, `item` where supplied |
| <a id="skills"></a>`station.skill.discoveries` | Discovery passes; the discovered count is an attribute | `count`, `projectSlug` |
| `station.skill.activations` | `skill_read` calls, including failed reads; not proof an Agent executed a skill | `skill` |
| <a id="other"></a>`station.analytics.operations` | Analytics route operations | `op` |
| `station.bedrock.operations` | Model catalog and Bedrock operations | `op` |
| `station.config.operations` | Config and connection operations | `op`, sometimes `id` |
| `station.sse.operations` | Event-stream connection operations | `op` |
| `station.insight.operations` | Insights queries | `op` |
| `station.system.operations` | System status/update/resource-posture operations | `op` |
| `station.uicommand.operations` | UI command operations | `op` |

The scheduler counter's mixed meaning is tracked in
[#2750](https://github.com/kontourai/station/issues/2750).
For the separate concurrency lifecycle, `waiting` adds a parked retry and
`admitted`/`stopped` remove it. `released` and `indeterminate` describe first
attempts, not parked depth. Within one process lifetime, parked depth is
`waiting - admitted - stopped`. An ungraceful exit can leave unmatched waits;
reset/rebase the calculation at restart. `indeterminate` deliberately has no
`job.deferred` SSE counterpart: an uncertain release must not be announced as
a confirmed deferral.

<a id="histograms"></a>

### Histograms with recording calls

| Instrument | What is measured | Attributes | Unit |
| --- | --- | --- | --- |
| `station.chat.duration` | Primary-chat duration | `agent`, `plugin` | ms |
| `station.tool.duration` | Matched call/result elapsed time from MetadataHandler **and** the external-engine bridge | `tool` when reported, `plugin` | ms |
| `station.scheduler.job.duration` | Scheduler execution duration | `job` | ms |
| `station.approval.duration` | Explicit registry settlement time | `action` | ms |
| `station.skill.activation.duration` | `skill_read` duration, including failed reads | `skill` | ms |
| `station.mcp.negotiation.duration` | Negotiation plus discovery duration | Negotiation attributes above | ms |

The cost counter has USD semantics in its producer but no declared instrument
unit. Token counters likewise have no explicit unit property.

<a id="observable-gauges"></a>

### Gauges and unavailable series

`registerObservableGauges` registers callbacks polled during export. Current
runtime wiring supplies these map sizes:

| Instrument | Current meaning |
| --- | --- |
| `station.agents.active` | Loaded entries in `activeAgents`, not currently executing turns |
| `station.mcp.connections` | Entries in `mcpConnectionStatus`, including failed entries, not only healthy connections |

`station.tokens.context` and `station.prompt.operations` are declared, but this
audit found no current production recording calls for them in the repository.
`station.layout.operations` and `station.voice.duration` have no current
declaration. Historical retained series or a dashboard query do not establish
a current producer. The dashboard follow-up is
[#2751](https://github.com/kontourai/station/issues/2751).

<a id="token-field-fallback-pattern"></a>

### Token values and missing observations

The primary-chat finalizer accepts both usage field shapes through nullish
fallback: `promptTokens ?? inputTokens` and `completionTokens ?? outputTokens`.
It records only defined values, preserving a measured zero and leaving missing
usage absent. Do not replace this with `|| ... || 0`, which turns missing
observations into a zero and can override a reported zero. Field spelling is
not a universal way to identify the provider.

### Cost tracking

The primary-chat finalizer is the current producer of the cost counter.
`findModelPricing` resolves supported Bedrock pricing. `estimateCost` is absent
if no components are reported, or any reported token/cache component lacks a
valid count or rate. An estimate covers only reported components; input-only
usage can be priced even when output usage is missing. A valid zero estimate can be retained locally
without a positive counter increment. This is neither an all-engine billing
ledger nor proof of a provider invoice.

See [chat finalization](../../src-server/routes/chat/chat-lifecycle.ts) and
[pricing](../../src-server/utils/pricing.ts) for the actual conditions.

## Grafana Dashboard

The dashboard (`monitoring/grafana/dashboards/station.json`) contains 28 non-row panels plus five section rows. The following numbers are
reading order, not Grafana JSON panel IDs:

| # | Title | Type | Category |
|---|-------|------|----------|
| 1 | Chat Requests | stat | General |
| 2 | Active Agents | stat | General |
| 3 | MCP Connections | stat | General |
| 4 | Errors | stat | General |
| 5 | Estimated Cost | stat | General |
| 6 | Chat p95 | stat | General |
| 7 | Requests Over Time | timeseries | General |
| 8 | Token Consumption | timeseries | General |
| 9 | Requests by Agent | bargauge | General |
| 10 | Tool Calls | bargauge | General |
| 11 | Agent Operations | bargauge | CRUD Operations |
| 12 | Layout Operations | bargauge | CRUD Operations |
| 13 | Prompt Operations | bargauge | CRUD Operations |
| 14 | Project Operations | bargauge | CRUD Operations |
| 15 | Plugin Activity | bargauge | Plugins |
| 16 | Plugin Events Over Time | timeseries | Plugins |
| 17 | Notifications | bargauge | Notifications & Scheduler |
| 18 | Scheduler Jobs | bargauge | Notifications & Scheduler |
| 19 | Scheduler Job Duration | timeseries | Notifications & Scheduler |
| 20 | Provider Operations | bargauge | Providers & MCP |
| 21 | MCP Lifecycle | bargauge | Providers & MCP |
| 22 | Knowledge Operations | bargauge | Providers & MCP |
| 23 | Tool Duration (p95) | timeseries | Performance |
| 24 | Chat Duration Distribution | timeseries | Performance |
| 25 | Context Overhead vs Input Tokens | timeseries | Performance |
| 26 | Error Rate | timeseries | Performance |
| 27 | Cost by Agent | bargauge | Performance |
| 28 | Token Usage | stat | Performance |

Current query limits matter when interpreting those panels:

- Layout, Prompt, and Context queries do not have current recording sources as
  described above. Notifications and Knowledge group by `operation`, but their
  producers use `op`. Other mixed-label families need their populations separated.
- Scheduler and chat request panels include operations beyond completed work.
  Tool-call and tool-duration populations differ. Gauge titles do not change
  the map-cardinality meanings above.
- Chat p95 is calculated per histogram series without aggregating Agent/plugin
  buckets into a global p95. Cost panels show partial estimates.
- `or vector(0)` in the Errors query can render zero when no series was observed.
  That is not evidence that instrumentation ran and observed no errors.

[#2751](https://github.com/kontourai/station/issues/2751) owns the query/producer
reconciliation. The Compose files use `latest` images and do not pin host bind
addresses; Grafana enables an anonymous Viewer and the example admin password.
Treat this as an operator-configured development example, not a qualified
production deployment. This audit did not start Docker or test collector,
Prometheus, Grafana, or Jaeger delivery.

## Distributed Traces (Jaeger)

Traces are exported via OTLP to the Collector, which forwards them to Jaeger over gRPC (port 4317, insecure).

Access traces at **http://localhost:16686**. Select service `station` (or the value of `OTEL_SERVICE_NAME`) from the search dropdown.

The primary-chat stream creates a `station.chat` span with `startSpan`.
That call neither forces it to be a root span nor makes it the active context.
`MetadataHandler` adds tool events only when its monitoring emitter/context
exist and an active span is available; the code does not establish that every
such event belongs to the new chat span. Other engines have their own paths.
A failed primary stream can currently be finalized as OK; an in-memory exporter
probe reproduced that mismatch, tracked in
[#2752](https://github.com/kontourai/station/issues/2752).

The conditional event write looks like this:

```ts
trace.getActiveSpan()?.addEvent('tool-call', {
  ...(chunk.toolName ? { 'tool.name': chunk.toolName } : {}),
  'tool.call_id': chunk.toolCallId,
});
```

The `tracer` export from `src-server/telemetry/metrics.ts` can create custom
spans. Parenting depends on an active or explicitly supplied parent context;
this example does not activate a new context:

```ts
import { tracer } from '../telemetry/metrics.js';

const span = tracer.startSpan('my-operation');
// ... work ...
span.end();
```

## Adding New Metrics

Follow the pattern used in `MetadataHandler` (`src-server/runtime/streaming/handlers/MetadataHandler.ts`):

**1. Define the instrument in `src-server/telemetry/metrics.ts`:**

```ts
export const myCounter = meter.createCounter('station.my.counter', {
  description: 'What this counts',
});
```

**2. Import and record in your handler:**

```ts
import { myCounter } from '../../../telemetry/metrics.js';

myCounter.add(1, { label: 'value' });
```

**3. Add a Grafana panel** by editing `monitoring/grafana/dashboards/station.json` or via the Grafana UI (save JSON back to the file to persist).

Define the observation and its owning caller before choosing a metric name.
Test that caller with a registered in-memory meter, including missing-data and
failure cases. Match the panel's labels and aggregation to those observations;
a declaration or a mocked factory argument does not establish collection.

`MetadataHandler` omits an unreported tool name instead of inventing `unknown`,
adds the plugin attribute, and stores a start only when a call ID exists. On a
matching result it records elapsed time and consumes that entry. The resolved
name/duration also travel into the local result event. Follow the
[handler](../../src-server/runtime/streaming/handlers/MetadataHandler.ts) and its
caller instead of copying a partial snippet that changes those conditions.

The optional SDK shutdown joins Station's shared 1.5-second network-teardown
budget. It is best effort; process exit or that deadline is not proof of
collector delivery.

## Application-Level Monitoring (MonitoringEmitter)

Beyond OTel infrastructure metrics, Station tracks GenAI-specific events through the `MonitoringEmitter` class. This is a separate system from OTel — it captures structured events about agent conversations, tool calls, and health checks.

### Architecture

```
Station-agent stream / OrchestrationMonitoringBridge
  └─ MonitoringEmitter (src-server/monitoring/emitter.ts)
       ├─ EventEmitter (SSE fan-out to /monitoring/events)
       └─ Best-effort asynchronous persistence (events-YYYY-MM-DD.ndjson)
```

Station-agent streams feed the emitter through their streaming pipeline.
External canonical engine events are projected by
[OrchestrationMonitoringBridge](../../src-server/services/orchestration/orchestration-monitoring-bridge.ts),
which excludes Station-agent to avoid a duplicate projection. The bridge does
not own lifetime usage accounting; that has its own canonical usage fold.

The emitter redacts content, emits the live event, and tracks an asynchronous
persistence promise. Persistence rejection is contained; `flush()` waits for
pending attempts but does not turn a failed write into durable evidence. This
is operational history, not an execution receipt or the canonical EventStore.

### Event Schema

Station's flat [event schema](../../src-server/monitoring/schema.ts) uses
OTel-style GenAI names and Station-specific fields. The record is not an OTLP
span encoding. [Shared key constants](../../src-shared/monitoring-keys.ts)
keep producers and readers on the same spelling.

Typed event fields (stored or imported rows can still be incomplete):

| Attribute | Type | Description |
|-----------|------|-------------|
| `timestamp` | string | ISO-8601 |
| `timestamp.ms` | number | Epoch ms for sorting |
| `trace.id` | optional string | Groups related events when reported; absence is not an empty identifier |
| `gen_ai.operation.name` | string | Schema permits `chat`, `invoke_agent`, `execute_tool`, `embeddings`, and `text_completion` |
| `span.kind` | string | `start`, `end`, `event`, `log` |

GenAI attributes (set per operation type):

| Attribute | Set On | Description |
|-----------|--------|-------------|
| `gen_ai.request.model` | agent start/end | Model ID |
| `gen_ai.conversation.id` | when reported | Optional Conversation ID |
| `gen_ai.usage.input_tokens` | agent complete | Input token count |
| `gen_ai.usage.output_tokens` | agent complete | Output token count |
| `gen_ai.tool.name` | tool call/result | Tool name. **Omitted when the producer reported none** (archive#3073) — absence is absence, never a tool named `unknown`. Events written before that change carry the literal string, so the two eras stay distinguishable; `/api/insights` buckets the omitted case as `(unnamed)`. |
| `gen_ai.provider.name` | tool call/result | The engine that ran the tool (archive#3074): `station` for Station's own runtime, the dispatch provider for external engines. Absent on events written before that change, so any engine grouping must handle a pre-change window rather than fill it with a fallback. |
| `gen_ai.request.model` | tool call/result | Session-configured model at dispatch — not observed per call. |
| `station.tool.duration_ms` | tool result | Elapsed milliseconds from call to result, rounded (archive#3077). Recorded on the EVENT because the OTel histogram is a no-op unless an exporter endpoint is configured. Absent when the matching call was never seen. |
| `gen_ai.tool.call.id` | tool call/result | Unique call ID |

Station extensions:

| Attribute | Description |
|-----------|-------------|
| `station.agent.slug` | Agent identifier. **Omitted when the session reported none** (archive#3082) — absence is absence, never an agent named `unknown`. Events written before that change carry the literal, so the eras stay distinguishable; `/api/insights` buckets the omitted case as `(unnamed)`. |
| `station.agent.steps` | Steps taken in agent loop |
| `station.input.chars` | Input character count |
| `station.output.chars` | Output character count |
| `station.user.id` | User identifier. Omitted when the session reported none (archive#3082), same discipline as the agent slug. |
| `station.reasoning.text` | Extended thinking content |

### Emitter Methods

| Method | When | Key Data |
|--------|------|----------|
| `emitAgentStart` | Chat request begins | slug, model, input |
| `emitAgentComplete` | Chat request ends | tokens, steps, finish reason |
| `emitToolCall` | Tool execution starts | tool name, arguments |
| `emitToolResult` | Tool execution ends | tool name, result |
| `emitReasoning` | Extended thinking | reasoning text |
| `emitHealth` | Health check | healthy, checks, integrations |
| `emitRaw` | Custom events | any MonitoringEvent |

### Consuming Events

**Live stream:** `GET /monitoring/events` without a time bound streams current
events. It does not provide the canonical orchestration stream's durable replay
contract. The Monitoring view subscribes through its own context and filters
its projection.

**Historical read:** specifying `start` or `end` selects JSON history from
`<STATION_HOME>/monitoring/events-YYYY-MM-DD.ndjson`. Bounds accept ISO timestamps
or epoch milliseconds; an absent start defaults to zero and an absent end to
now. Invalid bounds fail rather than widening the window. User ownership and
Session/tenant policy are applied before dimension filters and a requested
limit. Results are timestamp-ordered oldest first; a limit keeps the newest
matching rows. `limit` is optional and capped at 5,000 when supplied, so an
uncapped export is not a bounded page. The returned `truncated` flag says
whether the limit dropped matching rows; `data.length` is the returned row
count. The response does not report the total number of matches.

`RuntimeEventLog` caches per-file timestamp bounds with filesystem identity,
not payloads. Appends/replacements invalidate that shortcut. Missing history is
empty; other filesystem errors propagate. A successful read still only describes
records that reached the monitoring files.

### Insights API

`GET /api/insights` returns aggregates, not raw events: tool/Agent/model buckets,
hourly activity and totals. Its default window is 14 days. The route applies
user and Session/tenant checks and optional Agent/tool/engine filters; health
probes are excluded. A tool filter removes non-tool rows too, and an engine
filter cannot recover provider attribution missing from older or differently
shaped events. Empty buckets under a filter are not a claim about all work.

The optional positive `limit` caps ranked bucket lists at 500; totals still
come from the matching scan. File-day skipping reduces old-file reads, while
unparseable date filenames still enter row filtering. Unlike the history
reader's content-derived bounds, this optimization can omit a clock-skewed
exporter's row at a UTC day boundary. It does not scan every retained file on
every request.

Insights logs and skips per-row parsing and per-file read failures, then can
still return `success: true` without a completeness indicator. A successful
aggregate therefore does not prove every relevant file/row was read. This
differs from the history reader's propagation of non-missing-file I/O errors.

For exact query parsing and response fields, read the
[monitoring route](../../src-server/routes/operations/monitoring.ts),
[Insights route](../../src-server/routes/operations/insights.ts), and
[event-log owner](../../src-server/runtime/conversation/runtime-event-log.ts).
Source and fixture checks do not establish real collector delivery, retained
historical completeness, or dashboard correctness.
