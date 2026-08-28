# Backend Patterns

> **For AI Agents**: If you encounter a pattern not documented here, add it after implementing. This file is the source of truth for backend conventions.

## Architecture Overview

```
src-server/
├── runtime/             # Agent runtime integration
│   ├── streaming/       # Streaming handlers
│   └── station-runtime.ts  # Core runtime (should be minimal)
├── routes/              # HTTP route handlers (34 files)
│   ├── acp.ts
│   ├── agent-tools.ts
│   ├── agents.ts
│   ├── analytics.ts
│   ├── auth.ts
│   ├── bedrock.ts
│   ├── branding.ts
│   ├── chat.ts
│   ├── coding.ts
│   ├── config.ts
│   ├── conversations.ts
│   ├── events.ts
│   ├── feedback.ts
│   ├── fs.ts
│   ├── insights.ts
│   ├── invoke.ts
│   ├── knowledge.ts
│   ├── layouts.ts
│   ├── models.ts
│   ├── monitoring.ts
│   ├── notifications.ts
│   ├── plugins.ts
│   ├── projects.ts
│   ├── prompts.ts
│   ├── providers.ts
│   ├── registry.ts
│   ├── scheduler.ts
│   ├── schemas.ts
│   ├── system.ts
│   ├── telemetry-events.ts
│   ├── templates.ts
│   ├── tools.ts
│   ├── ui-commands.ts
│   └── voice.ts
├── services/            # Business logic services (28 files)
│   ├── acp-bridge.ts
│   ├── acp-probe.ts
│   ├── acp-process.ts
│   ├── agent-service.ts
│   ├── approval-registry.ts
│   ├── builtin-scheduler.ts
│   ├── cron.ts
│   ├── event-bus.ts
│   ├── feedback-service.ts
│   ├── file-tree-service.ts
│   ├── json-store.ts
│   ├── knowledge-service.ts
│   ├── layout-service.ts
│   ├── llm-router.ts
│   ├── mcp-service.ts
│   ├── notification-service.ts
│   ├── plugin-permissions.ts
│   ├── process-utils.ts
│   ├── project-service.ts
│   ├── prompt-scanner.ts
│   ├── prompt-service.ts
│   ├── provider-service.ts
│   ├── scheduler-service.ts
│   ├── skill-service.ts
│   ├── sse-broadcaster.ts
│   ├── template-service.ts
│   ├── terminal-service.ts
│   └── terminal-ws-server.ts
├── adapters/            # Storage adapters
├── providers/           # LLM providers (Bedrock, Ollama, OpenAI-compat)
├── monitoring/          # MonitoringEmitter and event schema
├── telemetry/           # OTel metrics instruments
├── domain/              # Types and config loading
├── analytics/           # Usage tracking
├── voice/               # Voice session service and S2S providers
└── utils/               # Utility functions
```

## Refactoring Principles

The backend has been refactored from a monolithic `station-runtime.ts` (~1,800 lines) to a layered architecture. Follow these principles:

### 1. Routes Handle HTTP Only

Routes should:
- Parse request parameters
- Call service methods
- Format HTTP responses
- Handle HTTP-specific errors

Routes should NOT:
- Contain business logic
- Access storage directly
- Manage state

### 2. Services Contain Business Logic

Services should:
- Implement business rules
- Coordinate between adapters
- Handle domain-specific errors
- Be injected into routes

### 3. Runtime Stays Minimal

`station-runtime.ts` should only contain:
- Agent initialization
- Service instantiation
- Route mounting
- Core streaming pipeline

## Route Organization

### Route File Structure

Each route file exports a factory function:

```typescript
// routes/agents.ts
import { Hono } from 'hono';
import type { AgentService } from '../services/agent-service.js';
import { agentOps } from '../telemetry/metrics.js';

export function createAgentRoutes(
  agentService: AgentService,
  reinitialize: () => Promise<void>,
  getVoltAgent: () => any,
) {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const voltAgent = getVoltAgent();
      if (!voltAgent) {
        return c.json({ success: false, error: 'VoltAgent not initialized' }, 500);
      }
      const coreAgents = await voltAgent.getAgents();
      const enrichedAgents = await agentService.getEnrichedAgents(coreAgents);
      return c.json({ success: true, data: enrichedAgents });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.post('/', async (c) => {
    try {
      const body = await c.req.json();
      const agent = await agentService.createAgent(body);
      agentOps.add(1, { operation: 'create' });
      await reinitialize();
      return c.json({ success: true, agent });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  return app;
}
```

### Route Mounting

Mount routes in `station-runtime.ts`:

```typescript
// In setupRoutes() or configureApp()
const agentRoutes = createAgentRoutes({
  agentService: this.agentService,
  logger: this.logger,
});
app.route('/agents', agentRoutes);

const toolRoutes = createToolRoutes({
  configLoader: this.configLoader,
  mcpService: this.mcpService,
  logger: this.logger,
});
app.route('/tools', toolRoutes);
```

### Route Grouping

Group related endpoints in the same file:

```typescript
// routes/layouts.ts - workflow routes only
export function createWorkflowRoutes(deps) { /* workflow operations */ }
```

## Service Layer

### Service Structure

```typescript
// services/agent-service.ts
export class AgentService {
  constructor(
    private configLoader: ConfigLoader,
    private activeAgents: Map<string, Agent>,
    private agentMetadataMap: Map<string, any>,
    private agentSpecs: Map<string, AgentSpec>,
    private logger: Logger
  ) {}

  async listAgents(): Promise<AgentSummary[]> {
    const metadataList = await this.configLoader.listAgents();
    return metadataList.map(m => ({
      slug: m.slug,
      name: m.name,
      description: m.description,
      icon: m.icon,
      isActive: this.activeAgents.has(m.slug),
    }));
  }

  async createAgent(spec: Partial<AgentSpec>): Promise<AgentSpec> {
    // Validation
    if (!spec.name) throw new Error('Agent name is required');
    
    // Business logic
    const slug = this.generateSlug(spec.name);
    const fullSpec = this.buildAgentSpec(spec, slug);
    
    // Persistence
    await this.configLoader.saveAgent(slug, fullSpec);
    
    return fullSpec;
  }

  async deleteAgent(slug: string): Promise<void> {
    // Check dependencies
    const dependentLayouts = await this.configLoader.getLayoutsUsingAgent(slug);
    if (dependentLayouts.length > 0) {
      throw new Error(`Cannot delete: used by layouts: ${dependentLayouts.join(', ')}`);
    }
    
    // Cleanup runtime state
    this.activeAgents.delete(slug);
    this.agentMetadataMap.delete(slug);
    this.agentSpecs.delete(slug);
    
    // Persistence
    await this.configLoader.deleteAgent(slug);
  }
}
```

### Service Responsibilities

| Layer | Responsibilities |
|-------|-----------------|
| Routes | HTTP parsing, response formatting, HTTP errors |
| Services | Business logic, validation, coordination, domain errors |
| Adapters | Storage operations, external API calls |
| ConfigLoader | File system operations, config parsing |

## Type Safety

### Core Principle: No Shortcuts

**Do not take shortcuts with TypeScript typing.** When fixing type errors:

1. **Understand the actual type** - Check `node_modules/*/dist/*.d.ts` for the real type definition
2. **Use correct APIs** - Don't use `as any` to silence errors without understanding why they occur
3. **Type assertions are last resort** - Only use when you've verified the runtime behavior is correct and the type system can't express it
4. **Add explicit types to parameters** - Never leave implicit `any` types on function parameters

```typescript
// ❌ Wrong - silencing without understanding
const result = await something() as any;
result.property;  // No idea if this exists

// ✅ Correct - understand the type first
// Check: grep -r "interface Result" node_modules/pkg/dist --include="*.d.ts"
const result: ActualResultType = await something();
result.knownProperty;
```

### Usage Types

AI SDK types differ from what you might expect. Always check the actual type definitions:

```typescript
// OperationContext uses Map, not object properties
// ❌ Wrong
context.metadata.toolCallCount = 1;

// ✅ Correct
context.context.set('toolCallCount', 1);
const count = context.context.get('toolCallCount') as number;
```

```typescript
// Conversation doesn't have messages - fetch separately
// ❌ Wrong
const messages = conversation.messages;

// ✅ Correct
const conversation = await memory.getConversation(id);
const messages = await memory.getMessages(userId, conversationId);
```

```typescript
// CreateConversationInput requires metadata
// ❌ Wrong - missing required field
await memory.createConversation({
  id, resourceId, userId, title
});

// ✅ Correct
await memory.createConversation({
  id, resourceId, userId, title,
  metadata: {},
});
```

### AI SDK UsageInfo vs LanguageModelV2Usage

Two different types with different property names:

| Type | Input Tokens | Output Tokens |
|------|--------------|---------------|
| AI SDK `UsageInfo` | `promptTokens` | `completionTokens` |
| AI SDK `LanguageModelV2Usage` | `inputTokens` | `outputTokens` |

Check which type you're working with before accessing properties.

### Type Narrowing for Union Types

```typescript
// ❌ Wrong - union type not narrowed
const result = schemaJson
  ? await agent.generateObject(prompt, schema, options)
  : await agent.generateText(prompt, options);
const response = result.object || result.text;  // Error!

// ✅ Correct - use type assertion after conditional
const response = schemaJson 
  ? (result as any).object 
  : (result as any).text;
```

### Optional Chaining

Always check for undefined before accessing:

```typescript
// ❌ Wrong - might be undefined
const model = await this.modelCatalog.resolveModelId(id);

// ✅ Correct
if (this.modelCatalog) {
  const model = await this.modelCatalog.resolveModelId(id);
}
```

### Agent Property Access

The `Agent` class doesn't expose all properties you might expect:

```typescript
// ❌ Wrong - Agent doesn't have .tools property
const tools = agent.tools;

// ✅ Correct - use cached tools from runtime
const tools = this.agentTools.get(slug) || [];
```

```typescript
// ❌ Wrong - model might be a DynamicValue
const modelId = agent.model.modelId;

// ✅ Correct - type narrow first
const agentModel = agent.model as { modelId?: string } | undefined;
const modelId = agentModel?.modelId;
```

## Error Handling

### Route Error Pattern

```typescript
app.post('/endpoint', async (c) => {
  try {
    const result = await service.doSomething();
    return c.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('Operation failed', { error });
    
    // Check for specific error types
    const isAuthError = error.message?.includes('403') ||
                        error.message?.includes('credential');
    const statusCode = isAuthError ? 401 : 500;
    
    return c.json({ success: false, error: error.message }, statusCode);
  }
});
```

### Service Error Pattern

```typescript
async doSomething(): Promise<Result> {
  // Validation errors - throw with clear message
  if (!input.required) {
    throw new Error('Required field missing');
  }
  
  // Business rule violations
  if (await this.wouldViolateConstraint(input)) {
    throw new Error('Cannot perform: constraint violated');
  }
  
  // Let unexpected errors bubble up
  return await this.adapter.save(input);
}
```

## Streaming

### Stream Handler Pattern

Handlers process a stream using the async generator pattern:

```typescript
export class MyHandler implements StreamHandler {
  name = 'my-handler';

  async *process(input: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
    for await (const chunk of input) {
      if (chunk.type === 'my-type') {
        yield { ...chunk, processed: true };
      } else {
        yield chunk;  // Pass through unchanged
      }
    }
  }

  async finalize() {
    return { /* final state */ };
  }
}
```

### Pipeline Usage

```typescript
const pipeline = new StreamPipeline(abortSignal);
pipeline
  .use(new ReasoningHandler({ enableThinking: true }))
  .use(new TextDeltaHandler())
  .use(new ToolCallHandler())
  .use(new MetadataHandler(monitoringEvents, contextData))
  .use(new CompletionHandler());

for await (const chunk of pipeline.run(stream)) {
  await writer.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

const results = await pipeline.finalize();
```

## Logging

### Use Pino Logger

```typescript
this.logger.info('Operation started', { agentSlug, conversationId });
this.logger.error('Operation failed', { error, context });
this.logger.debug('Debug info', { details });
this.logger.warn('Unexpected state', { state });
```

### Log Levels

| Level | Use For |
|-------|---------|
| `error` | Failures that need attention |
| `warn` | Unexpected but handled situations |
| `info` | Important operations (start/end, key events) |
| `debug` | Detailed debugging info |

### Structured Context

Always include relevant context:

```typescript
this.logger.info('[Chat Endpoint] Processing request', {
  slug,
  conversationId,
  hasInput: !!input,
  modelOverride: !!modelOverride,
});
```

## Migration Checklist

When extracting code from `station-runtime.ts`:

1. **Identify the domain** - agents, tools, layouts, monitoring, etc.
2. **Create route file** - `routes/<domain>.ts`
3. **Create service if needed** - `services/<domain>-service.ts`
4. **Extract route handlers** - Move HTTP handling to route file
5. **Extract business logic** - Move to service
6. **Update runtime** - Import and mount routes
7. **Run type check** - `npx tsc --noEmit --skipLibCheck`
8. **Test endpoints** - Verify functionality unchanged

## Common Pitfalls

1. **Assuming agent properties exist** - Check type definitions
2. **Wrong usage property names** - `promptTokens` vs `inputTokens`
3. **Missing null checks** - Use optional chaining
4. **HTTP logic in services** - Keep in routes only
5. **Business logic in routes** - Extract to services
6. **Missing metadata in CreateConversationInput** - Required field
7. **Accessing agent.tools directly** - Use cached tools map
8. **Not narrowing union types** - Use type assertions after conditionals

## Telemetry & Metrics

### Architecture

```
App (OTel SDK) → Collector (:4318) → Prometheus (:8889) → Grafana (:3333)
                                   → Jaeger (:4317)
```

The OTel SDK bootstraps in `src-server/telemetry.ts` (must be imported before all other modules). Metric instruments are defined in `src-server/telemetry/metrics.ts`. Both are no-ops when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set.

**A no-op counter is not evidence (archive#1686).** On an install without a
collector every `.add()` is discarded, unbuffered and unrecoverable, so a
counter a gate is supposed to read produces the same silence as the outcome it
was meant to rule out. If a metric is load-bearing for a decision, give it a
durable local record alongside the instrument — see "A Counter Is Not a Local
Read Path" in [../guides/monitoring.md](../guides/monitoring.md) and
`src-server/services/projects/project-resource-shadow-record.ts` for the worked
example.

### Recording Metrics

Import instruments from `telemetry/metrics.js` and call `.add()` or `.record()`:

```typescript
import { chatRequests, tokensInput } from '../telemetry/metrics.js';

chatRequests.add(1, { agent: slug });
tokensInput.add(usage.promptTokens || usage.inputTokens || 0, { agent: slug });
```

### Token Field Fallback Pattern

The AI SDK returns different field names depending on the provider. Bedrock uses `inputTokens`/`outputTokens`, while the AI SDK public API uses `promptTokens`/`completionTokens`. Always use the fallback chain:

```typescript
usage.promptTokens || usage.inputTokens || 0    // input tokens
usage.completionTokens || usage.outputTokens || 0  // output tokens
```

This pattern is used in `station-runtime.ts` (OTel recording + monitoring events) and `tool-executor.ts` (conversation stats).

### Where Metrics Are Recorded

| Metric | Location | Trigger |
|--------|----------|---------|
| `chat.requests`, `chat.duration`, `tokens.*` | `station-runtime.ts` completion handler | After stream finishes |
| `chat.errors` | `station-runtime.ts` catch block | On chat endpoint error |
| `tool.calls` | `MetadataHandler.collectStats()` | On `tool-call` stream chunk |
| `tool.duration` | `MetadataHandler.collectStats()` | Between `tool-call` and `tool-result` chunks |
| `tokens.context`, `cost.estimated` | `tool-executor.ts` stats update | After framework hook fires |
| `agents.active`, `mcp.connections` | `station-runtime.ts` init | Observable gauges, polled by SDK |
| `plugin.installs`, `plugin.updates` | `routes/plugins.ts` | After install/update completes |
| `scheduler.job.runs`, `scheduler.job.duration` | `builtin-scheduler.ts` | After job execution |
| `knowledge.operations` | `routes/knowledge.ts` | On CRUD operations |

> **45+ instruments total** — see `src-server/telemetry/metrics.ts` for the full list covering all domains (agents, layouts, projects, prompts, providers, notifications, MCP, feedback, approvals, terminals, ACP, voice, templates, conversations, coding, auth, etc.).

### Dashboard

The Grafana dashboard JSON lives at `monitoring/grafana/dashboards/station.json` and is bind-mounted into the container. Edits to the file are reflected immediately. The datasource uses a stable UID (`station-prometheus`) set in `monitoring/runtime/grafana-provisioning/datasources/prometheus.yml`.

## Additional Services

### ACP Bridge (`services/acp-bridge.ts`)

Connects Station to external AI agents via the [Agent Client Protocol](https://agentclientprotocol.dev). Spawns a subprocess (e.g. `kiro-cli acp`), communicates over stdin/stdout using ndjson, and translates ACP session events into the same SSE streaming format the UI already consumes — so the UI works unchanged.

See [docs/guides/acp.md](../guides/acp.md) for full setup and configuration details.

**Key classes:**
- `ACPConnection` — manages one subprocess connection: lifecycle (start/stop/reconnect), mode switching, model switching, chat handling, session persistence, and terminal management.
- `ACPManager` — manages multiple `ACPConnection` instances from config; exposes the same interface as the old single bridge.

**Public API:**
```typescript
// ACPManager
manager.startAll(configs)           // start all enabled connections
manager.addConnection(config)       // add/replace a single connection
manager.removeConnection(id)        // shutdown and remove
manager.hasAgent(slug)              // check if slug belongs to any connection
manager.getVirtualAgents()          // list all ACP-backed agent descriptors
manager.getSlashCommands(slug)      // slash commands advertised by the agent
manager.getCommandOptions(slug, partial) // autocomplete for slash commands
manager.handleChat(c, slug, input, options) // stream a chat turn as SSE
manager.getStatus()                 // connection health for all connections
manager.shutdown()                  // stop everything
```

**When to use:** When you need to expose an external CLI-based AI agent (e.g. kiro-cli) as a first-class Station agent without rewriting its logic. The bridge handles reconnection, session resumption, tool approval, terminal management, and MCP OAuth prompts automatically.

---

### Approval Registry (`services/approval-registry.ts`)

Shared registry for pending tool-approval requests. Both framework elicitation hooks and ACP permission requests use this to pause execution and wait for the user to approve or reject a tool call via the UI.

**Public API:**
```typescript
registry.register(approvalId, timeoutMs?)  // returns Promise<boolean> — resolves when user responds
registry.resolve(approvalId, approved)     // called by the tool-approval route; returns false if not found
registry.has(approvalId)                   // check if an approval is pending
ApprovalRegistry.generateId(prefix?)       // generate a unique approval ID
```

**Flow:**
1. Service calls `register(id)` and awaits the promise (blocks the tool call).
2. SSE stream emits a `tool-approval-request` event to the UI.
3. User approves/rejects via `POST /tool-approval/:id`.
4. Route calls `resolve(id, approved)`, unblocking the awaiting service.
5. Unanswered requests auto-resolve to `false` after `timeoutMs` (default 60 s).

**When to use:** Any time a tool call requires explicit user consent before proceeding. Do not implement ad-hoc approval flows — use this registry so all approvals share the same UI surface.

---

### Event Bus (`services/event-bus.ts`)

Typed pub/sub for server-side state changes. Services emit named events; the SSE `/events` endpoint subscribes and pushes them to connected browser clients.

**Public API:**
```typescript
bus.emit(event, data?)          // broadcast to all subscribers
bus.subscribe(fn)               // returns an unsubscribe function
```

**Built-in events (by convention):**
| Event | Emitted by | Meaning |
|---|---|---|
| `agents:changed` | ACP bridge, agent service | Agent list changed |
| `acp:status` | ACP bridge | Connection status changed |

**When to use:** Emit an event whenever server-side state changes that the UI should react to in real time (e.g. agent list updated, connection status changed). Subscribe in the `/events` SSE route — do not poll from the UI.

---

### Plugin Permissions (`services/plugin-permissions.ts`)

Three-tier permission model for installed plugins. Grants are persisted in `plugin-grants.json` keyed by plugin name.

**Tiers:**

| Tier | Permissions | Behavior |
|---|---|---|
| `passive` | `navigation.dock` | Auto-granted at install time |
| `active` | `network.fetch`, `agents.invoke`, `tools.invoke` | Requires user consent |
| `trusted` | `providers.register`, `system.config`, `plugin.server` | Requires isolated host approval |

**Public API:**
```typescript
getPermissionTier(permission)                          // → PermissionTier
needsConsent(permission)                               // → boolean
getPluginGrants(projectHomeDir, pluginName)            // → string[]
grantPermissions(projectHomeDir, pluginName, perms)    // persist grants
revokeAllGrants(projectHomeDir, pluginName)            // remove all grants
hasGrant(projectHomeDir, pluginName, permission)       // check single grant
processInstallPermissions(projectHomeDir, pluginName, declared)
  // → { autoGranted, pendingConsent }  — call at install time
```

**When to use:** Call `processInstallPermissions` during plugin install to auto-grant passive permissions and surface the consent list to the user. Call `hasGrant` at runtime before executing any privileged plugin action.

Trusted permissions use `routes/plugin-host-approval-routes.ts`: an
authenticated request creates a short-lived review, but the grant is committed
only by a user navigation on the script-free host review page. The public plugin
grant route remains limited to passive and active permissions. Pending and
completed reviews are time-bounded and capped so approval state cannot grow
without limit.

---

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
scheduler.previewSchedule(cron, count?)  // next N fire times as ISO strings
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

Core-server router over internally composed scheduler providers. The built-in
scheduler is currently the only production registration. There is no plugin
scheduler-provider registration API: plugins must not treat
`ISchedulerProvider` or `addProvider` as a supported extension seam.
The internal compatibility Adapter still accepts a legacy provider's
`Promise<string>` manual result and projects only `data.output`; it cannot
invent a `RunSummary.runId` or receipt for that source shape.

**Public API:**
```typescript
service.addProvider(provider)              // internal runtime composition only
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
