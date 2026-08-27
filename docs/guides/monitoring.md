# Monitoring & Telemetry

Station ships a full observability stack: OTel Collector → Prometheus → Grafana for metrics, and Jaeger for distributed traces. Telemetry is a **no-op** when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set — no configuration is required for local development.

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No     | —           | OTLP HTTP endpoint. Telemetry is disabled if unset. |
| `OTEL_SERVICE_NAME`         | No       | `station`  | Service name reported in traces and metrics.     |
| `STATION_EVENT_LOG_RETENTION_DAYS` | No | `30` | UTC daily monitoring files retained on disk. |
| `STATION_EVENT_LOG_MAX_BYTES` | No | `268435456` | Maximum retained monitoring-event bytes; the active UTC day's file is protected. |

To enable telemetry against the local stack:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_SERVICE_NAME=station
```

## Resource Attributes, and a Breaking Rename (station#2484)

Every exported metric and trace carries two resource attributes:

| Attribute | Value |
| --- | --- |
| `service.installation.id` | SHA-256 of a random UUID created once per install and stored at `STATION_HOME/config/otel-installation-id`. Stable for that install, independent of the machine. |
| `os.type` | Platform name. |

**`user.anonymous_id` is removed.** It was `sha256(hostname:username)` truncated to 48 bits — a deterministic function of the OS username, so anyone holding the value and a candidate list of hostname/username pairs could confirm a match. The name claimed a property the value did not have.

If you have dashboards, alerts, saved queries, or cardinality groupings keyed on `user.anonymous_id`, **they will stop receiving it** and must move to `service.installation.id`. The values are unrelated — the new one is random, so historical series cannot be joined to new ones. Treat it as a new dimension rather than a rename in your backend.

It remains a stable **pseudonymous** installation identifier: consistent within your collector, so per-install grouping still works. It is not "anonymous" in a sense implying unlinkability inside a store that also holds other data about that install.

## Local Event History and Retention

Station writes queryable monitoring events as daily NDJSON files under
`<STATION_HOME>/monitoring`. On startup it removes closed-day files older than 30
days, then removes the oldest closed-day files until retained history is at or
below 256 MiB. The active UTC day's file is protected so Station never deletes
the file it is appending to. Invalid environment values fall back to these
defaults.

These files are operational telemetry, not the canonical orchestration event
store. To preserve a longer audit or diagnostic window, copy the NDJSON files
to an export directory before they leave the configured retention window. Files
that do not use Station's `events-YYYY-MM-DD.ndjson` naming scheme are excluded
from automatic retention.

## A Counter Is Not a Local Read Path (station#1686)

Because the SDK only starts when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, every
instrument in `src-server/telemetry/metrics.ts` **discards its writes** on an
ordinary install. Nothing is buffered, so nothing is recoverable after the
fact. That is fine for a rate you would only ever read on a dashboard, and it
is *not* fine for a counter some gate is supposed to read as evidence: an
instrument that throws its writes away produces exactly the same silence as a
subsystem that agreed with everything, and the reader cannot tell them apart.

If a metric is load-bearing for a decision, it needs a local record as well.
Station's own server logs are one instance of this: `station.logs.read` counts
read-path *queries*, but the durable local record is the NDJSON store itself
(`<STATION_HOME>/logs/server/`) plus its self-read path — `GET
/api/diagnostics/logs` and the `read_logs` MCP tool (station#1896 slice 2, see
[docs/reference/config.md#logging](../reference/config.md#logging)) — so the logs
this section's own counters describe are themselves locally readable, not just
counted.

The worked example is the project-resource migration shadow
(station#1501 slice 3a): alongside `station.project_resource.shadow_comparisons`
it appends every comparison, with the same dimensions, to a durable per-home
record at `<STATION_HOME>/project-resource-shadow.json`
(`src-server/services/projects/project-resource-shadow-record.ts`). Read it
with:

```bash
npm run project-shadow:report              # rendered summary
npm run project-shadow:report -- --json    # machine-readable
npm run project-shadow:report -- --gate    # exits non-zero unless slice 3c's
                                           # populations are all observed
```

The record's shape is what makes it honest: an outcome that has never been
observed is **absent**, never a zero row, and a home with no record at all
answers `NOT OBSERVED` for every question rather than `0`. "The observer ran
and saw agreement" and "the observer never ran" are different answers.

**What a passing `--gate` does not prove (station#1775).** The gate states its
own limits: it prints a `WHAT THIS PASS DOES NOT PROVE` block alongside a
passing verdict, and `--json` carries the same strings as `gateLimits`. Read
them there rather than here — one of the two is *derived from the record* (the
seams actually observed), so a copy in this document would go stale exactly
when it mattered, and a second, differently-worded copy is how a limit quietly
stops matching the thing it limits.

The short version, for orientation only: coverage is a statement about a
*home's history*, not about the resolver currently on disk. Do not cite a pass
as sufficient authority for slice 3c's one-way flip without either #1775
deriving the provenance or the gap being accepted explicitly.

The write is deliberately `tear-safe` rather than fsync-durable: it happens
once per session start on the event loop, where four fsyncs cost ~15ms. It
keeps the same-directory temp file, the atomic rename and the retained
`.previous`, and drops only the fsyncs (~0.4ms).

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

The SDK bootstraps in `src-server/telemetry.ts` and **must be imported before all other modules**. It registers:
- `HttpInstrumentation` — auto-instruments HTTP requests, normalising path params to `:id`
- `AwsInstrumentation` — auto-instruments AWS SDK calls
- A `PeriodicExportingMetricReader` that flushes every 30 seconds

## Metrics Reference

All instruments are defined in `src-server/telemetry/metrics.ts` and are safe to import even when no SDK is configured.

### Counters

#### Chat & Tokens

| Metric                      | Description                                              | Labels         |
|-----------------------------|----------------------------------------------------------|----------------|
| `station.chat.requests`    | Total chat requests                                      | `agent`        |
| `station.tokens.input`     | Input tokens consumed                                    | `agent`        |
| `station.tokens.output`    | Output tokens consumed                                   | `agent`        |
| `station.tokens.context`   | Fixed context tokens per request (system prompt + MCP tools) | `agent`   |
| `station.tool.calls`       | Tool INVOCATIONS by an agent (definition CRUD moved to `station.tool.definitions.operations`, station#3077) | `tool` (omitted when unreported, station#3073) |
| `station.chat.errors`      | Total chat errors                                        | `agent`        |
| `station.cost.estimated`   | Estimated cost in USD (cumulative)                       | `agent`        |

#### Plugins

| Metric                        | Description              | Labels   |
|-------------------------------|--------------------------|----------|
| `station.plugin.installs`    | Plugin install events    | —        |
| `station.plugin.uninstalls`  | Plugin uninstall events  | —        |
| `station.plugin.updates`     | Plugin update events     | —        |
| `station.plugin.settings_updates` | Plugin settings update events | —   |

#### CRUD Operations

| Metric                        | Description              | Labels      |
|-------------------------------|--------------------------|-------------|
| `station.agent.operations`   | Agent CRUD operations    | `operation` |
| `station.layout.operations`  | Layout CRUD operations   | `operation` |
| `station.project.operations` | Project CRUD operations  | `operation` |
| `station.prompt.operations`  | Prompt CRUD operations   | `operation` |
| `station.tool.definitions.operations` | Tool DEFINITION management — add/remove/list/reconnect. Split out of `station.tool.calls` (station#3077), which counted these alongside actual tool invocations. | `op` |

#### Providers & Infrastructure

| Metric                             | Description                              | Labels      |
|------------------------------------|------------------------------------------|-------------|
| `station.provider.operations`     | Provider register/remove/health events   | `op`        |
| `station.notification.operations` | Notification schedule/deliver/dismiss    | `op`        |
| `station.scheduler.job.runs`      | Scheduler job executions                 | —           |
| `station.mcp.lifecycle`           | MCP connection lifecycle events          | `event`     |
| `station.mcp.negotiation.total`   | Modern/legacy negotiation outcomes        | `era`, `protocol_version`, `fallback`, `extensions`, `outcome`, `error_class` |
| `station.mcp.negotiation.duration`| Negotiation plus initial discovery latency| same as negotiation outcome |
| `station.knowledge.operations`    | Knowledge query/index operations         | `op`        |
| `station.feedback.operations`     | Feedback submission events               | `op`        |
| `station.approval.operations`     | Tool approval request/approve/deny       | `op`        |
| `station.terminal.operations`     | Terminal session lifecycle events        | `op`        |
| `station.acp.operations`          | ACP connection lifecycle events          | `op`        |
| `station.voice.operations`        | Voice session lifecycle events           | `op`        |
| `station.template.operations`     | Template list/apply events               | `op`        |
| `station.conversation.operations` | Conversation lifecycle events            | `operation` |
| `station.coding.operations`       | Coding session events                    | `op`        |
| `station.auth.operations`         | Auth lifecycle events                    | `op`        |
| `station.filetree.operations`     | File tree browse events                  | `op`        |
| `station.registry.operations`     | Registry install/uninstall events        | `op`        |

#### Skills

| Metric                          | Description              | Labels |
|---------------------------------|--------------------------|--------|
| `station.skill.discoveries`    | Skill discovery events   | —      |
| `station.skill.activations`    | Skill activation events  | —      |

#### Other

| Metric                          | Description                    | Labels |
|---------------------------------|--------------------------------|--------|
| `station.analytics.operations` | Analytics query events         | `op`   |
| `station.bedrock.operations`   | Bedrock model catalog events   | `op`   |
| `station.config.operations`    | App config read/write events   | `op`   |
| `station.sse.operations`       | SSE connection events          | `op`   |
| `station.insight.operations`   | Insight query events           | `op`   |
| `station.system.operations`    | System status/verify events    | `op`   |
| `station.uicommand.operations` | UI command execution events    | `op`   |

### Histograms

| Metric                              | Unit | Description                            | Labels  |
|-------------------------------------|------|----------------------------------------|---------|
| `station.chat.duration`            | ms   | Chat request duration                  | `agent` |
| `station.tool.duration`            | ms   | Tool execution duration                | `tool`  |
| `station.scheduler.job.duration`   | ms   | Scheduler job execution duration       | —       |
| `station.approval.duration`        | ms   | Time from approval request to decision | —       |
| `station.voice.duration`           | ms   | Voice session duration                 | —       |
| `station.skill.activation.duration`| ms   | Skill activation duration              | —       |

### Observable Gauges

Registered via `registerObservableGauges()` in the runtime — callbacks are polled on each export cycle.

| Metric                    | Description                    |
|---------------------------|--------------------------------|
| `station.agents.active`  | Number of active agents        |
| `station.mcp.connections`| Number of MCP connections      |

### Token Field Fallback Pattern

The AI SDK uses different field names across providers. The runtime normalises this with a fallback:

```ts
tokensInput.add(usage.promptTokens || usage.inputTokens || 0, { agent: slug });
```

`promptTokens` is the Anthropic/OpenAI field; `inputTokens` is used by Bedrock and the Strands adapter. Always apply both fallbacks when reading usage from a model response.

### Cost Tracking

Cost is tracked as a cumulative USD counter (`station.cost.estimated`). The runtime computes cost from token counts and model pricing, then calls:

```ts
costEstimated.add(cost, { agent: slug });
```

The Grafana dashboard shows both total estimated cost (stat panel) and cost broken down by agent (bar gauge).

## Grafana Dashboard

The dashboard (`monitoring/grafana/dashboards/station.json`) contains 28 panels:

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

## Distributed Traces (Jaeger)

Traces are exported via OTLP to the Collector, which forwards them to Jaeger over gRPC (port 4317, insecure).

Access traces at **http://localhost:16686**. Select service `station` (or the value of `OTEL_SERVICE_NAME`) from the search dropdown.

Each chat request creates a root span. Tool calls and tool results are added as span events:

```ts
trace.getActiveSpan()?.addEvent('tool-call', {
  'tool.name': chunk.toolName,
  'tool.call_id': chunk.toolCallId,
});
```

The `tracer` export from `src-server/telemetry/metrics.ts` can be used to create custom child spans:

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
import { myCounter } from '../../telemetry/metrics.js';

// Inside your handler logic:
myCounter.add(1, { label: 'value' });
```

**3. Add a Grafana panel** by editing `monitoring/grafana/dashboards/station.json` or via the Grafana UI (save JSON back to the file to persist).

The full pattern from `MetadataHandler`:

```ts
import { toolCalls as otelToolCalls, toolDuration as otelToolDuration } from '../../../telemetry/metrics.js';

// On tool-call chunk:
otelToolCalls.add(1, { tool: chunk.toolName || 'unknown' });
this.toolStartTimes.set(chunk.toolCallId, { start: performance.now(), tool: chunk.toolName });

// On tool-result chunk:
const entry = this.toolStartTimes.get(chunk.toolCallId);
if (entry) {
  otelToolDuration.record(performance.now() - entry.start, { tool: entry.tool });
}
```

## Application-Level Monitoring (MonitoringEmitter)

Beyond OTel infrastructure metrics, Station tracks GenAI-specific events through the `MonitoringEmitter` class. This is a separate system from OTel — it captures structured events about agent conversations, tool calls, and health checks.

### Architecture

```
StreamOrchestrator / ACPBridge
  └─ MonitoringEmitter (src-server/monitoring/emitter.ts)
       ├─ EventBus (SSE fan-out to /monitoring/events)
       └─ Disk persistence (events-YYYY-MM-DD.ndjson)
```

The emitter is injected into the streaming pipeline and ACP bridge. It captures events at key lifecycle points without coupling to any specific transport.

### Event Schema

Events follow the [OTel GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) with Station extensions. Defined in `src-server/monitoring/schema.ts`.

Core attributes (every event):

| Attribute | Type | Description |
|-----------|------|-------------|
| `timestamp` | string | ISO-8601 |
| `timestamp.ms` | number | Epoch ms for sorting |
| `trace.id` | string | Groups related events |
| `gen_ai.operation.name` | string | `chat`, `invoke_agent`, `execute_tool` |
| `span.kind` | string | `start`, `end`, `event`, `log` |

GenAI attributes (set per operation type):

| Attribute | Set On | Description |
|-----------|--------|-------------|
| `gen_ai.request.model` | agent start/end | Model ID |
| `gen_ai.conversation.id` | all agent events | Conversation ID |
| `gen_ai.usage.input_tokens` | agent complete | Input token count |
| `gen_ai.usage.output_tokens` | agent complete | Output token count |
| `gen_ai.tool.name` | tool call/result | Tool name. **Omitted when the producer reported none** (station#3073) — absence is absence, never a tool named `unknown`. Events written before that change carry the literal string, so the two eras stay distinguishable; `/api/insights` buckets the omitted case as `(unnamed)`. |
| `gen_ai.provider.name` | tool call/result | The engine that ran the tool (station#3074): `station` for Station's own runtime, the dispatch provider for external engines. Absent on events written before that change, so any engine grouping must handle a pre-change window rather than fill it with a fallback. |
| `gen_ai.request.model` | tool call/result | Session-configured model at dispatch — not observed per call. |
| `station.tool.duration_ms` | tool result | Elapsed milliseconds from call to result, rounded (station#3077). Recorded on the EVENT because the OTel histogram is a no-op unless an exporter endpoint is configured. Absent when the matching call was never seen. |
| `gen_ai.tool.call.id` | tool call/result | Unique call ID |

Station extensions:

| Attribute | Description |
|-----------|-------------|
| `station.agent.slug` | Agent identifier. **Omitted when the session reported none** (station#3082) — absence is absence, never an agent named `unknown`. Events written before that change carry the literal, so the eras stay distinguishable; `/api/insights` buckets the omitted case as `(unnamed)`. |
| `station.agent.steps` | Steps taken in agent loop |
| `station.input.chars` | Input character count |
| `station.output.chars` | Output character count |
| `station.user.id` | User identifier. Omitted when the session reported none (station#3082), same discipline as the agent slug. |
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

**SSE stream**: `GET /monitoring/events` — real-time event stream for the Monitoring view.

**Disk**: Events persist to `<STATION_HOME>/monitoring/events-YYYY-MM-DD.ndjson` (one JSON object per line). Historical events are queryable via `GET /monitoring/events?start=<iso-or-ms>&end=<iso-or-ms>`.

**UI**: The Monitoring view (`MonitoringContext.tsx`) subscribes to the SSE stream and displays events in real-time with filtering by agent, operation type, and time range.

### Insights API

`GET /api/insights` aggregates event data from the monitoring directory for the Insights Dashboard.

- Reads all `events-*.ndjson` files from `<STATION_HOME>/monitoring/`
- Returns parsed events for analytics and feedback analysis
- Used by the `InsightsDashboard` component alongside the feedback tab
