# Backend patterns

These are contributor conventions with current source owners, not a claim that
the backend has finished a layered-architecture migration. Read the
[server instructions](../../src-server/AGENTS.md) and
[module map](../architecture/module-map.md) for the affected interface before
extracting code. Document a reusable pattern after tracing its real callers;
do not turn an isolated implementation choice into a universal rule.

## Runtime, route, service and adapter responsibilities

| Responsibility | Current locations | Boundary |
| --- | --- | --- |
| Bootstrap and composition | `src-server/runtime/bootstrap/`, `runtime/routes/` | Select implementations, bind authority and lifetime, mount public entry points |
| HTTP routes | Feature groups under `src-server/routes/` | Parse bounded input, apply request authorization, translate typed outcomes |
| Domain behavior | Feature groups under `src-server/services/` and `domain/` | Own state transitions, ordering, persistence and external-effect semantics |
| Concrete adapters | `adapters/`, `providers/`, feature-owned adapters | Satisfy the declared interface for storage, engine or host behavior |
| Contracts | `packages/contracts/` | Stable cross-package shapes; no hidden runtime authority |

The directory names do not prove a boundary is enforced. Runtime composition
still contains substantial behavior; “keep runtime minimal” is a design goal,
not a statement about its current line count. The
[architecture overview](../architecture.md#service-layout) locates the groups.
Avoid copying old flat paths such as `services/agent-service.ts` or introducing
a new generic service simply to move a method out of a large file.

A useful extraction gives callers an intent-shaped interface and keeps its
ordering and failure invariants local. Compose concrete adapters outside that
interface. Validation belongs at the boundary that receives untrusted input;
services also enforce the domain constraints that cannot safely depend on one
HTTP caller. Do not assume a service is authorized merely because one route
happens to guard it.

## Request admission and responses

A common route shape is a Hono factory receiving narrow dependencies. Follow a
real owner such as [Agent routes](../../src-server/routes/agents/agents.ts) or
[spatial-board routes](../../src-server/routes/spatial-board.ts), rather than
copying an illustrative handler and omitting its surrounding middleware.

For each operation, establish:

1. The current authenticated principal and deployment mode from server-owned
   request context. Loopback, a URL, an object ID or an Agent-supplied principal
   is not authorization.
2. The route-family scope and object-level rule: Project membership, Session
   read/write authority, operator authority or another declared capability.
3. Bounded body/query parsing and schema validation before effects. Reject
   unsupported fields where the owning contract requires a closed shape.
4. The service's state transition, including admission after awaited work when
   authority can change, and the exact persistence/effect boundary.
5. A response that distinguishes refusal, unavailable, accepted, completed and
   indeterminate outcomes. A saved configuration is not necessarily an active
   runtime provider.

The [runtime HTTP composition](../../src-server/runtime/bootstrap/runtime-http.ts)
and [pairing route policy](../../src-server/security/pairing-route-scopes.ts)
provide common admission, but they do not replace object-level checks. Hosted,
local-account, delegated-Agent and operator callers must retain their different
authorities. Follow the [deployment authentication guide](../guides/deployment-authentication.md)
for those distinctions.

Common HTTP admission also checks the client API protocol before credentials
on paired-scope routes and the public pairing request/access-request/exchange.
[`client-protocol-admission.ts`](../../src-server/security/client-protocol-admission.ts)
reads an absent header as protocol 1, returns `400 client_protocol_invalid`
for malformed declarations and `426 client_protocol_unsupported` below the
handshake's minimum. Runtime composition sets CORS first and emits a denial
audit containing the refusal reason and parsed protocol, never the raw header.
Protocol refusals use a separate direct-socket-peer audit limiter (default: 10
per 60 seconds), reusing `RuntimeAuthFailureLimiter` with its 1,024-peer cap.
Exhaustion suppresses only protocol audits; every refusal still returns 400/426.
They neither consult nor consume the authentication budget, so corrected
clients sharing a proxy or NAT can authenticate. The handshake and declared
navigation routes remain exempt;
passing protocol admission grants no scope or object authority. Follow the
[threat model](../security/remote-access-threat-model.md#client-api-protocol-admission-2962)
for the exact coverage and remaining caller gaps before raising the minimum.

For configuration mutations, trace
[configuration activation](../../src-server/routes/system/configuration-activation.ts)
and the injected mutation runner. Do not save an Agent and then invoke a broad
runtime reinitializer merely because an old example did so. Preserve activation
failure/degraded outcomes and the owning synchronization rule.

## Persistence and external effects

Use the existing domain owner rather than manipulating its backing files or
maps in a route. [ConfigLoader](../../src-server/domain/config-loader.ts) owns
configuration loading/watching; feature stores own other product records.
There is no rule that all persistence belongs in ConfigLoader.

For file read/modify/write, follow the
[JSON mutation authority](../architecture/module-map.md#jsonfilemutationauthority)
and the domain's stronger transaction interface when it has one. Ownership,
fresh authoritative reads, staging, commit and recovery belong to the same
operation. A renamed file is not automatically a multi-file transaction or a
cross-process lock. An in-memory cache is not durable completion.

For engines, child processes and providers, model the boundary after which an
effect may have happened. Cancellation or timeout does not necessarily undo it.
Do not retry an indeterminate operation as if the first attempt were known not
to run. The [Session turn boundary](../architecture/module-map.md#sessionturnboundaryauthority)
and [Scheduler ledger](../architecture/module-map.md#schedulerledger-and-builtinscheduler)
are concrete owners of that distinction.

## Type safety

Read the actual contract or installed public package declaration before fixing
a type error. Do not cast to `any` to hide an API mismatch, and do not guess a
third-party object's fields from its name. Type assertions require a separately
established runtime invariant; they do not validate received JSON.

Narrow unions through their discriminant or keep each typed branch local:

```ts
type ReadResult =
  | { state: 'ready'; value: string }
  | { state: 'unavailable'; reason: string };

function describe(result: ReadResult): string {
  if (result.state === 'unavailable') return result.reason;
  return result.value;
}
```

This is a standalone TypeScript example, not a new Station result protocol.
Reuse the owning contract's actual states. Optional chaining is appropriate for
an optional fact; it must not turn a missing required dependency or authority
into a success-shaped empty value.

Framework memory, Agent, model and usage types differ by package/version.
Station's Provider adapters translate them into canonical runtime contracts.
Do not copy old `agent.tools`, `agent.model.modelId`, memory-conversation or
`OperationContext` recipes without checking the current adapter and declaration.
Likewise, token fields are not interchangeable by spelling alone: a fallback
such as `promptTokens || inputTokens || 0` loses zero/unknown distinctions and
can combine incompatible cache-accounting conventions. Follow the owning
adapter's usage mapping and the [usage reference](../reference/usage-telemetry.md).

## Errors and logging

Routes should map known domain refusal types/codes to their documented status
and public message. Do not infer authentication from whether an arbitrary error
message contains `403` or `credential`. Do not return raw internal exceptions,
provider payloads or filesystem paths merely because `error.message` exists.
Unexpected failures need an observable internal diagnostic and a bounded public
failure, using the route family's established error contract.

Use [Station's Logger](../../src-server/utils/logger.ts), not direct Pino,
framework logger imports or production `console.log`. Its message-first API
preserves structured context:

```ts
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'feature-operation' });
function recordAccepted(operationId: string) {
  logger.info('Operation accepted', { operationId, outcome: 'accepted' });
}
```

Here `operationId` is an identifier supplied by the operation owner, not a
credential or arbitrary payload. Choose a log level for the observed outcome:
`error` for failures needing attention, `warn` for handled degradation, `info`
for useful lifecycle facts, and `debug`/`trace` for bounded diagnostic detail.
Log enough to identify the failing operation without copying private prompts or
secrets. Station's stdout redaction and durable-log/read-time policies differ;
see [monitoring](../guides/monitoring.md), rather than assuming every sink is
already redacted.

## Streams, events and approvals

The public foreground chat request and its event stream are separate contracts:
[Session API](../reference/session-api.md) owns acceptance and orchestration
replay. Station-engine private chat also composes
[StreamPipeline](../../src-server/runtime/streaming/StreamPipeline.ts), whose
handlers are async generators. Registration order is execution order, and a
handler may emit zero or more chunks per input. The actual handler sequence is
owned by [stream-orchestrator](../../src-server/runtime/conversation/stream-orchestrator.ts).
Do not construct a second public chat pipeline from an old example.

The pipeline checks abort around output consumption and offers handler
finalization; that alone does not prove cancellation of every upstream effect.
SSE routes own authenticated delivery, cancellation, backpressure and any
replay contract. Use the existing broadcaster where appropriate. Not every SSE
endpoint has orchestration's durable `Last-Event-ID` replay.

[EventBus](../../src-server/services/orchestration/event-bus.ts) is in-process
notification, not a durable log or an acknowledgment that all subscribers
processed a fact. It invokes current listeners synchronously and catches a
throwing listener without removing its subscription, with rate-limited warnings.
Use `SERVER_EVENTS` contracts instead of inventing string conventions. A route's
SSE subscriber still needs its own audience/authority checks; publishing on the
bus is not permission to broadcast private Session state. Some views deliberately
poll, so “never poll” is not a truthful description of current UI behavior.

[ApprovalRegistry](../../src-server/services/approvals/approval-registry.ts)
owns one family of pending tool approvals, including metadata and hosted
Session binding. Its boolean compatibility registration cannot distinguish all
refusal/timeout/cancellation outcomes; use the owning typed outcome where that
distinction affects the caller. The default timeout is one minute unless the
caller supplies another value. Reuse the appropriate approval owner rather
than inventing an ad-hoc prompt, but do not treat this registry as the universal
authority for every product approval. Orchestration requests, device pairing
and plugin host approval have separate state machines and current authorization.

## Observation is not execution evidence

`telemetry.ts` configures OTel and `telemetry/metrics.ts` declares instruments.
A declaration or `.add()` call is not collector receipt or a durable local
record. The [monitoring guide](../guides/monitoring.md) owns current startup,
export and failure limits; the [metric reference](../reference/metrics.md)
locates declarations. Do not duplicate a hand-maintained instrument count or
promise that setting an endpoint makes every precreated instrument export.

For a decision that must survive restart or distinguish “did not happen” from
“was not observed,” use the product owner's durable record as well as telemetry.
The [Project resource shadow record](../../src-server/services/projects/project-resource-shadow-record.ts)
is one example. Dashboards and monitoring events remain observation surfaces,
not the authoritative Session/Scheduler outcome.

## Adapter and extension boundaries

ACP is owned by [AcpAdapter](../../src-server/providers/adapters/acp-adapter.ts)
and its process implementation under `services/acp/`. It translates an external
engine's protocol into canonical orchestration facts. The retired ACPManager
HTTP-chat and argument-autocomplete method list is not the current adapter
contract. Read [the ACP guide](../guides/acp.md) for supported discovery,
passthrough and capability gaps; do not promise automatic support for every
engine feature.

Plugin permission policy lives in
[plugin-permissions.ts](../../src-server/services/plugins/plugin-permissions.ts),
with host review and reconciliation owned by their route/service modules.
Passive, active and trusted permission tiers do not mean installed, approved
and active are the same fact. Content binding and current grants can withhold
recorded permissions, and runtime reconciliation can be incomplete. Follow the
[plugin guide](../guides/plugins.md) for the supported installation/approval path;
do not call an old helper recipe as a substitute for the install transaction.

## Refactoring and verification

Before extraction, name the domain, current public callers, authority source,
persistence/effect boundary and failure behavior. Preserve these while moving
code; size alone is not an interface. Update composition, tests and the owning
module/guide together. Keep shared contracts in `packages/contracts` and use
explicit shared helper subpaths instead of a bare shared-root import.

Run `npm run gate:for -- <paths>` before editing, then selected evidence with
`npm run test:focused -- <files>`. Use one appropriate typecheck lane for changed
TypeScript; do not launch a full background typecheck or weaken compiler flags
to make an extraction appear valid. Tests must reach a real caller and distinguish
failure, refusal and missing prerequisites. Keep synthetic adapter tests,
real-provider checks and deployment evidence separate. See
[testing](../guides/testing.md) for the exact workflow.

## Scheduler composition

The following is the established scheduler-specific contract, retained separately
from the general conventions above. Its internal provider seam is not a plugin
registration API.

### Built-in Scheduler (`services/scheduling/builtin-scheduler.ts`)

The core scheduler composes the internal `ISchedulerProvider` implementation
with a private SQLite `SchedulerLedger` under Station's application home. It
claims an occurrence transactionally before invoking the runtime adapter and
projects claimed and terminal receipts through `RunService`; it does not spawn
an external CLI or persist scheduler state as JSON.

**Core composition API** (not a plugin SDK):
```typescript
scheduler.start()                          // begin ticking every 60 s
scheduler.stop()                           // stop the tick interval
scheduler.listJobs()                       // → SchedulerJob[] (with lastRun/nextRun)
scheduler.addJob(opts)                     // create cron/every/at job
scheduler.editJob(target, opts)            // update job fields
scheduler.removeJob(target)               // delete a job
scheduler.runJob(target)                  // typed manual receipt with runId
scheduler.enableJob(target) / disableJob(target)
scheduler.getJobLogs(target, count?)      // last N log entries
scheduler.getRunOutput(target)            // stdout of last run
scheduler.subscribe(send)                 // SSE subscription; returns unsubscribe fn
```

**Schedule format:** A job carries either a bare `cron` string (5-field UTC, back-compat) or an `@kontourai/ephemeris` `Schedule` (`{kind:'cron',expr,timezone?}` | `{kind:'at',timeMs,deleteAfterRun?}` | `{kind:'every',everyMs}`). Evaluation — including DST-aware timezone projection, catch-up after host-down, and one-shot self-disable — is delegated to ephemeris's pure schedule core.

**When to use:** Runtime composition uses `BuiltinScheduler` through
`SchedulerService`. HTTP, the React-free SDK, CLI, and station-control MCP use
the same `SCHEDULER_OPERATOR_SURFACE` contract. The public manual-run success payload retains
`data.output` for compatibility and adds `data.receipt` with a canonical
`RunSummary.runId`; a possible-effect outcome is `409
scheduler_run_indeterminate` and must not be automatically retried.

---

### Scheduler Service (`services/scheduling/scheduler-service.ts`)

Core-server router over scheduler providers. The built-in scheduler is the
only registration, and there is no scheduler-provider registration API:
plugins must not treat `ISchedulerProvider` as an extension seam. Every
manual run returns a `SchedulerManualRunReceipt`.

**Public API:**
```typescript
service.listProviders()                    // → [{ id, displayName, capabilities, formFields }]
service.listJobs()                         // aggregated from all providers
service.addJob(opts)                       // routes to opts.provider (default: built-in)
service.editJob(target, opts)             // auto-routes to owning provider
service.removeJob(target)
service.runJob(target)
service.enableJob(target) / disableJob(target)
service.getJobLogs(target, count?)
service.getRunOutput(target)
service.readRunFile(path)                  // read a log output file (path-validated)
service.previewSchedule(cron, count?)
service.getStats()                         // → { providers, summary }
service.getStatus()                        // → { providers }
service.subscribe(send)                    // fan-out SSE to all providers; returns unsubscribe fn
service.broadcast(event)                   // push an event to all SSE clients
```

**When to use:** Always use `SchedulerService` (injected via routes) rather than `BuiltinScheduler` directly. Internally composed providers are included in every operation; plugins do not register scheduler providers today.
