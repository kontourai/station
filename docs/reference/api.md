# Station API Documentation

This document describes all REST API endpoints available in Station.

**Base URL**: the selected Station's server origin. The CLI resolves an
unbootstrapped Stable loopback target to `http://localhost:18141` through the
shared runtime context; development/bootstrap ports are explicit, not fallback
documentation. Prefer the endpoint from `station target` instead of assuming a
channel or port. Protected routes
require the saved Station's paired credential; loopback is not an
authentication bypass.

**Endpoint authority**: See [endpoints.md](./endpoints.md) for OpenAPI and auth
authorities. This document is historical narrative, not an endpoint inventory.

## Endpoint Legend

- 🟢 **Custom** - Station-specific extensions
- ✅ **In Use** - Currently used by frontend
- ⚪ **Available** - Implemented but not currently used

## Table of Contents

- [Agent Management](#agent-management)
- [Integration Management](#integration-management)
- [Layout Management](#layout-management)
- [Workflow Management](#workflow-management)
- [Conversation Management](#conversation-management)
- [Configuration](#configuration)
- [Fleet Inference](#fleet-inference)
- [Bedrock Models](#bedrock-models)
- [Analytics](#analytics)
- [Monitoring](#monitoring)
- [Agent Invocation](#agent-invocation)
- [Auth & Users](#auth--users) *(new)*
- [Branding](#branding) *(new)*
- [Events (SSE)](#events-sse) *(new)*
- [File System](#file-system) *(new)*
- [Insights](#insights) *(new)*
- [Standalone Model Capability Routes](#standalone-model-capability-routes) *(new)*
- [Plugins](#plugins) *(new)*
- [Registry](#registry) *(new)*
- [Scheduler](#scheduler) *(new)*
- [System](#system) *(new)*
- [Starter Work](#starter-work)
- [Spatial Board](#spatial-board)

---

## Starter Work

```http
GET /api/starter-work
POST /api/starter-work/bind
POST /api/starter-work/launch
GET /api/starter-work/:starterId
GET /api/starter-work/:starterId/candidate
GET /api/starter-work/:starterId/observation
```

Starter Work is a bounded server catalog, not a client-defined checklist. The
catalog exposes `start-task`, `continue-session`, `inspect-approval`, and
`inspect-receipt`, plus `run-scheduled-check`; all require the durable
completed first-run decision. Their targets are, respectively, an exact Task
with its matching Project ID and an exact Station-owned continuation Session.
`GET` returns catalog projections (including each starter's correlation
status). Binding accepts only the registered target kind and owner identity and
returns `409` for a conflicting binding or mismatched/missing owner, `404` for
an unknown starter, and `503` when the durable ledger is unavailable. A bind
does not declare a Task complete: Task Session, run, and receipt owners remain
the completion authority.

`POST /api/starter-work/launch` is the first vertical's only create-and-start
intent. Readiness is checked first: `200` with `state: deferred|unavailable`
and `retrySafe: true` creates no Task and dispatches nothing. A ready launch
returns `201` with `state: started`: it creates a real Task idempotently,
persists its exact binding and operation fence, then asks the existing Task
dispatcher exactly once. The response separates correlation from the total
dispatch disposition. `indeterminate` is never retried automatically;
`NOT_VERIFIED` remains until the Task's owner evidence reports a passed receipt
or explicit exception. Hosted tenant execution exposes no personal-home
Starter route until it has equivalent tenant-bound Work owners.

For `continue-session`, the launch body carries only the exact read-only source
Session ID and an operation ID. Station validates that source through the
orchestration owner and uses the existing adoption ledger's idempotency key to
create or replay one Station-owned child. A `201 state: continued` response
contains the exact child Session and command receipt identity; failures remain
typed as `failed`, `unavailable`, or `indeterminate`, with the same operation ID
safe to retry when `retrySafe` is true. The command receipt proves admission,
not useful-work completion, so evidence remains `NOT_VERIFIED`.
The catalog binding is one-time: after it is bound, later attached-session
continuations stay on the ordinary orchestration owner API rather than
overwriting Starter correlation.

The two inspection starters are read-only owner journeys. Candidate reads
select only a validated Approval Inbox notification or independent-review
receipt and return its exact typed reference; they never select by title.
Launching revalidates that owner, binds the exact reference idempotently, and
returns a server-built `/notifications?approval=...` or
`/review-queue?receipt=...&project=...` link. Observation re-reads the owner every
time, so resolved, expired, missing, stale, unavailable, and `NOT_VERIFIED`
states do not come from a browser checkbox or copied payload. Inspecting does
not approve an approval, and independent-review findings remain input-only
evidence rather than a pass, exception, or gate verdict. Hosted execution does
not mount candidate or launch routes until tenant-bound owners exist.
Starter telemetry remains default-off until the product telemetry decision is
resolved.

`run-scheduled-check` accepts only its Starter ID and stable operation ID. The
server creates the canonical `station-starter-check` job disabled, with the
Station Agent, no retries, and a daily schedule that does not recur until an
operator explicitly enables it. SchedulerLedger atomically prepares the exact
manual run; Starter Work binds its canonical `scheduler-run` receipt before
activation. Response loss replays that run rather than invoking again. The
bound Home recovery action reuses the binding's stored `operationId`, including
for SDK-created identities, so restart recovery cannot drift to a new run. The
result and observation link to `/schedule?run=...`; running, completed, failed,
and indeterminate are derived from RunService. Completion proves the check ran,
not that its free-form findings passed a gate, so evidence remains
`NOT_VERIFIED`.

## Spatial Board

```http
GET /api/spatial-board
GET /api/spatial-board/resolved
POST /api/spatial-board/pins
PUT /api/spatial-board/pins/:pinId
DELETE /api/spatial-board/pins/:pinId
PATCH /api/spatial-board/title
PATCH /api/spatial-board/camera
POST /api/spatial-board/cleanup
POST /api/spatial-board/undo
```

The Spatial Board is a personal, revision-checked schema-v2 layout store. Pins
persist only a full WorkReference (Project, Task, Session, approval, Flow
run/gate, scheduler or independent-review receipt, run-output Artifact, or
Agent) and bounded geometry. Titles, states, verdicts, and evidence remain
with their owners. `GET /resolved` reads only the current board's stored refs,
groups them by owner, and returns ephemeral `current`, `missing`, `stale`,
`unavailable`, `ambiguous`, or `NOT_VERIFIED` projections; it is not a general
cross-product query API. Every mutation supplies the last observed
`expectedRevision`; stale writes return `409`, missing pins return `404`,
capacity returns `413`, and unreadable/corrupt storage returns a redacted
`503`. Cleanup accepts exact full WorkReferences observed missing by the
caller, and undo exchanges one bounded prior snapshot. Hosted tenant execution
mounts none of these routes until equivalent tenant-bound owner and storage
seams exist.

## Agent Management

### 🟢 ✅ Custom Chat Stream
```http
POST /api/agents/:slug/chat
```

**Custom endpoint** that provides streaming chat with elicitation support and tool approval handling.

**Request Body**:
```json
{
  "input": "Hello, how can you help?",
  "options": {
    "userId": "user-123",
    "conversationId": "conv-456",
    "temperature": 0.7,
    "maxOutputTokens": 1000,
    "model": "anthropic.claude-3-5-sonnet-20240620-v1:0"
  }
}
```

**Response**: Server-Sent Events stream

**Status**: In use  
**Used by**: `ConversationsContext.tsx`, `ChatDock.tsx` (primary chat interface)

**Features**:
- Elicitation support for gathering user information
- Tool approval workflow integration
- Model override capability
- Conversation history management

An explicit model override is accepted only when Station has a configured model catalog that resolves the exact selector. A missing catalog or unknown selector rejects the request instead of constructing an unverified model binding.

---

## Agent Management

### 🟢 ✅ Default Agent

Station creates the **system default agent** only when `defaultModel` is configured and resolves through the current model catalog:

**Agent ID**: `default`  
**Model**: Uses current `defaultModel` from `app.json`  
**Tools**: None (simple text generation only)  
**Instructions**: "You are a helpful AI assistant. Provide clear, concise, and accurate responses."

**Usage**:
```bash
# Use with any agent endpoint
POST /agents/default/invoke
POST /agents/default/text
POST /api/agents/default/chat
```

**Behavior**:
- A fresh model-less Station still starts its setup, configuration, readiness, and connection surfaces
- No model-less default agent is registered until a launchable model is configured
- Once configured, the agent uses the catalog-resolved default model
- No tools = fast, simple text generation
- Suitable for utility tasks (prompt generation, text formatting, etc.)

**Used by**: `AgentEditorView.tsx` (prompt generation)

---

### 🟢 ✅ List All Agents (Enriched)
```http
GET /api/agents
```

**Custom endpoint** that returns enriched agent data including configuration, tools, and metadata.

**Status**: In use  
**Used by**: `AgentsContext.tsx`, agent selector, layout views

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "agent-id",
      "slug": "my-agent",
      "name": "Station Agent",
      "prompt": "System instructions...",
      "description": "Agent description",
      "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "region": "us-east-1",
      "guardrails": {
        "maxTokens": 4096,
        "temperature": 0.7
      },
      "maxTurns": 10,
      "icon": "🤖",
      "commands": {},
      "toolsConfig": {
        "mcpServers": ["files"],
        "available": ["*"],
        "autoApprove": []
      },
      "updatedAt": "2025-12-08T12:00:00Z"
    }
  ]
}
```

**Used by**: `AgentsContext.tsx`, agent selector, layout views

---

### 🟢 ✅ Create Agent
```http
POST /agents
```

**Custom endpoint** for creating new agents.

**Request Body**:
```json
{
  "name": "My Agent",
  "prompt": "You are a helpful assistant...",
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "description": "Optional description",
  "guardrails": {
    "maxTokens": 4096,
    "temperature": 0.7
  },
  "tools": {
    "mcpServers": ["files"],
    "available": ["*"]
  }
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "slug": "my-agent",
    "name": "My Agent",
    ...
  }
}
```

Agent creation persists before runtime activation. When activation is queued,
the response is HTTP `202` and also includes this acceptance-time snapshot:

```json
{
  "configurationActivation": {
    "status": "pending",
    "reason": "Configuration was saved, but runtime activation is pending reconciliation."
  }
}
```

`pending` means activation was queued when the write was accepted; it is not a
live status subscription and activation may complete before the response is
processed.

**Used by**: `AgentsContext.tsx`, agent editor

---

### Update Agent
```http
PUT /agents/:slug
```

**Request Body**: Partial agent configuration (same structure as create)

**Response**:
```json
{
  "success": true,
  "data": { /* updated agent */ }
}
```

Updates use the same HTTP `202` `configurationActivation` receipt described
under Create Agent when persistence completes before runtime activation.

**Used by**: `AgentsContext.tsx`, agent editor

---

### Delete Agent
```http
DELETE /agents/:slug
```

**Response**:
```json
{
  "success": true
}
```

Deletes use the same HTTP `202` `configurationActivation` receipt described
under Create Agent when persistence completes before runtime activation.

**Error** (if agent is referenced by layouts):
```json
{
  "success": false,
  "error": "Cannot delete agent 'my-agent' - it is referenced by layouts: my-layout"
}
```

**Used by**: `AgentsContext.tsx`, agent management view

---

### Get Agent Health
```http
GET /agents/:slug/health
```

**Response**:
```json
{
  "success": true,
  "healthy": true,
  "checks": {
    "loaded": true,
    "hasModel": true,
    "hasMemory": true,
    "integrationsConfigured": true,
    "integrationsConnected": true
  },
  "integrations": [
    {
      "id": "files",
      "type": "mcp",
      "connected": true,
      "metadata": {
        "transport": "stdio",
        "toolCount": 5,
        "tools": [
          {
            "name": "files_readFile",
            "originalName": "files_read_file",
            "server": "files",
            "toolName": "read_file",
            "description": "Read file contents"
          }
        ]
      }
    }
  ],
  "status": "idle"
}
```

**Used by**: Monitoring view, health checks

---

## Integration Management

### List All Integrations
```http
GET /integrations
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "files",
      "kind": "mcp",
      "displayName": "File System",
      "description": "Read and write files",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./"]
    }
  ]
}
```

**Used by**: Integration management view

---

### Create Integration
```http
POST /integrations
```

**Request Body**: Integration definition (same shape as `integration.json`).

**Response**:
```json
{
  "success": true,
  "data": { /* created integration */ }
}
```

---

### Get Integration
```http
GET /integrations/:id
```

**Response**:
```json
{
  "success": true,
  "data": { /* integration definition */ }
}
```

---

### Update Integration
```http
PUT /integrations/:id
```

**Request Body**: Partial integration definition.

**Response**:
```json
{
  "success": true,
  "data": { /* updated integration */ }
}
```

---

### Delete Integration
```http
DELETE /integrations/:id
```

**Response**:
```json
{
  "success": true
}
```

---

### Get Agent Tools
```http
GET /agents/:slug/tools
```

Returns tools available to a specific agent with full schemas.

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "files_readFile",
      "name": "files_readFile",
      "originalName": "files_read_file",
      "server": "files",
      "toolName": "read_file",
      "description": "Read file contents",
      "parameters": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        }
      }
    }
  ]
}
```

**Errors** — the two reasons an agent has no tool list are separated
(archive#3158): `404` `Agent '<slug>' not found` when neither the persisted
catalog nor the registry's default agents knows the slug, and `409`
`Agent '<slug>' exists but is not active` when it does and its runtime is not
up.

**Used by**: `ConversationsContext.tsx`, tool displays, agent editor

---

### Add Tool to Agent
```http
POST /agents/:slug/tools
```

**Request Body**:
```json
{
  "toolId": "files"
}
```

**Response**:
```json
{
  "success": true,
  "data": ["files", "other-tool"]
}
```

**Used by**: Agent editor, integration management

---

### Remove Tool from Agent
```http
DELETE /agents/:slug/tools/:toolId
```

**Response**:
```json
{
  "success": true
}
```

**Used by**: Agent editor, integration management

---

### Update Tool Allow-List
```http
PUT /agents/:slug/tools/allowed
```

**Request Body**:
```json
{
  "allowed": ["files_*", "fetch_get"]
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "mcpServers": ["files", "fetch"],
    "available": ["files_*", "fetch_get"],
    "autoApprove": []
  }
}
```

**Used by**: Agent editor

---

## Layout Management

Standalone `/layouts` endpoints were removed during project-layout convergence.
Use the project-scoped layout endpoints under `/api/projects/:slug/layouts` instead.

**Used by**: project-scoped layout management flows

---

## Workflow Management

### List Agent Workflows
```http
GET /agents/:slug/workflows/files
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "filename": "example-simple.ts",
      "path": ".station/agents/my-agent/workflows/example-simple.ts"
    }
  ]
}
```

**Used by**: `WorkflowsContext.tsx`, workflow management

---

### Get Workflow Content
```http
GET /agents/:slug/workflows/:workflowId
```

**Response**:
```json
{
  "success": true,
  "data": {
    "content": "import { Agent } from '@strands-agents/sdk';\n\nexport default andThen(() => 'Hello');"
  }
}
```

**Used by**: Workflow editor

---

### Create Workflow
```http
POST /agents/:slug/workflows
```

**Request Body**:
```json
{
  "filename": "new-workflow.ts",
  "content": "import { Agent } from '@strands-agents/sdk';\n\nexport default andThen(() => 'Hello');"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "filename": "new-workflow.ts"
  }
}
```

**Used by**: Workflow editor

---

### Update Workflow
```http
PUT /agents/:slug/workflows/:workflowId
```

**Request Body**:
```json
{
  "content": "// Updated workflow code"
}
```

**Response**:
```json
{
  "success": true
}
```

**Used by**: Workflow editor

---

### Delete Workflow
```http
DELETE /agents/:slug/workflows/:workflowId
```

**Response**:
```json
{
  "success": true
}
```

**Used by**: Workflow management

---

## Conversation Management

### List Agent Conversations
```http
GET /agents/:slug/conversations
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "conv-123",
      "userId": "agent:my-agent:user:default",
      "title": "Conversation Title",
      "createdAt": "2025-12-08T12:00:00Z",
      "updatedAt": "2025-12-08T12:30:00Z",
      "metadata": {
        "stats": {
          "inputTokens": 1000,
          "outputTokens": 500,
          "totalTokens": 1500,
          "turns": 5,
          "toolCalls": 2,
          "estimatedCost": 0.05
        }
      }
    }
  ]
}
```

**Used by**: `ConversationsContext.tsx`, conversation list

---

### Get Conversation Messages
```http
GET /agents/:slug/conversations/:conversationId/messages
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "Hello",
      "timestamp": "2025-12-08T12:00:00Z"
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "Hi! How can I help?",
      "timestamp": "2025-12-08T12:00:05Z"
    }
  ]
}
```

**Used by**: `ConversationsContext.tsx`, chat view

---

### Update Conversation
```http
PATCH /agents/:slug/conversations/:conversationId
```

**Request Body**:
```json
{
  "title": "New Title"
}
```

**Response**:
```json
{
  "success": true,
  "data": { /* updated conversation */ }
}
```

**Used by**: Conversation management, title editing

---

### Delete Conversation
```http
DELETE /agents/:slug/conversations/:conversationId
```

**Response**:
```json
{
  "success": true
}
```

**Used by**: Conversation management

---

### Manage Conversation Context
```http
POST /api/agents/:slug/conversations/:conversationId/context
```

**Request Body** (add system message):
```json
{
  "action": "add-system-message",
  "content": "User switched to dark mode"
}
```

**Request Body** (clear history):
```json
{
  "action": "clear-history"
}
```

**Response**:
```json
{
  "success": true,
  "message": "System event added"
}
```

**Used by**: Context management features

---

### Get Conversation Statistics
```http
GET /agents/:slug/conversations/:conversationId/stats
```

**Response**:
```json
{
  "success": true,
  "data": {
    "inputTokens": 1000,
    "outputTokens": 500,
    "totalTokens": 1500,
    "contextTokens": 1500,
    "turns": 5,
    "toolCalls": 2,
    "estimatedCost": 0.05,
    "contextWindowPercentage": 0.75,
    "conversationId": "conv-123",
    "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "modelStats": {},
    "systemPromptTokens": 200,
    "mcpServerTokens": 300,
    "userMessageTokens": 500,
    "assistantMessageTokens": 500,
    "contextFilesTokens": 0
  }
}
```

`contextWindowPercentage` is included only when Station can resolve the
model's context-window size. When it is omitted, clients must treat context
window usage as unavailable and omit the percentage display rather than
rendering `0%`.

**Used by**: `StatsContext.tsx`, `ConversationStats.tsx`

---

## Configuration

### Get App Configuration
```http
GET /config/app
```

**Response**:
```json
{
  "success": true,
  "data": {
    "region": "us-east-1",
    "defaultModel": "anthropic.claude-3-5-sonnet-20240620-v1:0"
  }
}
```

**Used by**: `ConfigContext.tsx`, settings view

---

### Update App Configuration
```http
PUT /config/app
```

**Request Body**:
```json
{
  "region": "us-west-2",
  "defaultModel": "anthropic.claude-3-haiku-20240307-v1:0"
}
```

**Response**:
```json
{
  "success": true,
  "data": { /* updated config */ }
}
```

**Used by**: `ConfigContext.tsx`, settings view

---

## Connections

### List All Connections
```http
GET /api/connections
```

Returns the merged Connections surface used by the UI, including both model/provider rows and runtime rows.

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "bedrock-default",
      "kind": "model",
      "type": "bedrock",
      "name": "Bedrock",
      "enabled": true,
      "capabilities": ["llm"],
      "config": {},
      "status": "ready",
      "prerequisites": [],
      "lastCheckedAt": null
    },
    {
      "id": "codex-runtime",
      "kind": "runtime",
      "type": "codex-runtime",
      "name": "Codex Runtime",
      "enabled": true,
      "capabilities": ["agent-runtime", "resume"],
      "config": {
        "provider": "codex",
        "providerLabel": "Codex",
        "defaultModel": "gpt-5.3-codex"
      },
      "status": "ready",
      "prerequisites": [],
      "lastCheckedAt": null
    }
  ]
}
```

**Used by**: `ConnectionsHub.tsx`

---

### List Model Connections
```http
GET /api/connections/models
```

Returns provider/model-backed connections only.

LLM-capable rows can include `config.modelOptions` when the provider can enumerate models.

**Used by**: `ProviderSettingsView.tsx`, `KnowledgeConnectionView.tsx`, `NewChatModal.tsx`, `AgentEditorRuntimeTab.tsx`

---

### List Runtime Connections
```http
GET /api/connections/runtimes
```

Returns runtime connections only.

Current connected-runtime rows expose runtime-scoped model metadata on the read-only `runtimeCatalog` projection:

- `source`: `live`, `cached`, `built-in`, or `none`
- `models`: live or cached model entries
- `builtInModels`: Station's bounded built-in entries
- `reason`, `fetchedAt`, and `truncated`: status and completeness metadata

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "codex-runtime",
      "kind": "runtime",
      "type": "codex-runtime",
      "name": "Codex Runtime",
      "enabled": true,
      "description": "Codex app-server runtime over the local Codex CLI.",
      "capabilities": ["agent-runtime", "resume"],
      "config": {
        "provider": "codex",
        "providerLabel": "Codex",
        "defaultModel": "gpt-5.3-codex"
      },
      "runtimeCatalog": {
        "source": "live",
        "fetchedAt": "2026-08-09T00:00:00.000Z",
        "reason": null,
        "models": [
          {
            "id": "gpt-5.4-codex",
            "name": "GPT-5.4 Codex",
            "originalId": "gpt-5.4-codex"
          }
        ],
        "builtInModels": [
          {
            "id": "gpt-5.3-codex",
            "name": "GPT-5.3 Codex",
            "originalId": "gpt-5.3-codex"
          }
        ]
      },
      "status": "ready",
      "prerequisites": [],
      "lastCheckedAt": null
    }
  ]
}
```

**Used by**: `RuntimeConnectionView.tsx`, `ConnectionsHub.tsx`, `NewChatModal.tsx`, `useChatDockViewModel.ts`, `ChatDock.tsx`, `AgentEditorRuntimeTab.tsx`

---

### List Launchable Model Inventory
```http
GET /api/connections/model-inventory
```

Returns a normalized, secret-free `station.model-inventory/v2` snapshot of model selectors reported by active model and agent connections. The snapshot keeps Station's configured launch binding (`providerId`) separate from adapter-declared runtime identity. `providerModel` is the selector Station passes to invocation, including a resolved Bedrock inference-profile id when required. Missing runtime, context, tool, vision, revision, or quantization facts remain `null`; Station does not infer them from endpoint URLs or model names.

`availability: "available"` requires current selector evidence. Station's own time-bounded, configuration-fingerprinted provider catalog may remain queryable as `availability: "stale"` with `freshness: "cached"`. Built-in and explicitly configured selectors observed during the current refresh may remain queryable as `"built-in"` or `"configured"`; peer-carried older observations use `"stale-snapshot"`. Bedrock opts out because its invocation selector must be returned by AWS evidence. Caller-provided persisted Agent app catalog fields are ignored; failed Agent app discovery contributes no substitute selector. Disabled and non-ready connections do not contribute model records.

Locality is declaration-backed. Station's built-in default Ollama runtime declares `local`; a configurable Ollama model endpoint remains `unknown` unless its connection explicitly declares locality. Station does not infer locality from provider type or endpoint URL.

Refresh work is single-flight, deadline-bound, abortable, and concurrency-limited. Application-config updates are serialized so concurrent field updates cannot overwrite one another. Mutation revisions advance only after provider or application configuration persistence commits; native file events plus periodic semantic fingerprint observation detect out-of-process config commits, and duplicate observations do not double-count Station's own atomic writes. Each generation discovers models and runtimes from immutable provider-configuration and application-configuration snapshots captured with their respective revisions, then rechecks both owner revisions before publication. This prevents an unobserved external A-to-B-to-A file transition from substituting transient launchability input. Provider fingerprints are SHA-256 digests rather than retained serialized configuration.

Mutation, timeout, and sibling-discovery failure abort in-flight network and subprocess work. Station starts deadline cancellation after 4.35 seconds to reserve the final 650 ms of the five-second response target for cleanup. Registration provenance, not adapter-supplied metadata, decides which adapters are trusted built-ins. Built-in model providers and Agent app adapters may declare that their discovery promise settles only after owned resources close; Station aborts on the first branch failure and awaits every active trusted cleanup-declaring branch only within the reserved cleanup window. A defective implementation cannot hold the inventory or orchestration request open indefinitely, and its late rejection remains supervised. Plugin metadata cannot elevate a plugin into this contract or inject plugin-controlled readiness dimensions. Concurrent Codex catalog callers share one process; cancelling one caller preserves work for remaining callers, while cancellation by the final caller terminates the process and confirms settlement before returning. Every Station-owned Codex process path, including catalog discovery, failed session startup, normal session stop, and bulk stop, sends `SIGTERM`, waits a bounded grace period, escalates to `SIGKILL`, and then waits within a second bounded confirmation window. A `kill()` return value is never treated as exit proof.

Provider catalogs are bounded before projection: built-in HTTP and SDK pagination follows only returned cursors, rejects non-advancing cursors, stops after 32 pages or 1,000 accepted entries, and applies one cumulative 2 MiB response budget where raw response bytes are available. Reaching an entry ceiling while a continuation cursor remains is reported as incomplete discovery, never as a complete catalog; built-in Bedrock and Ollama Agent app adapters preserve that truncation signal through the shared adapter contract. Persisted app and provider configuration inputs are independently limited to 2 MiB before parsing. A refresh deterministically selects at most 64 Model connections and 64 Agent app adapters by stable identity. Projection retains only the lexically earliest bounded candidate set while scanning sources, serializes each candidate once for exact incremental byte accounting, and assembles the final response without repeatedly serializing whole candidate inventories. The final inventory contains at most 4,096 model records, and the complete `{success,data}` HTTP response is at most 2 MiB; omitted work produces a bounded `discovery-limited` diagnostic. Inventory discovery does not collect adapter commands.

Catalog observations and the last successful inventory snapshot may be served stale for at most 15 minutes. The aggregate timestamp is no newer than its oldest published model observation; an unknown-age model is omitted rather than receiving the refresh time. A stale response preserves the original `observedAt`, marks records stale, and includes `refresh-unavailable`, including when the prior snapshot contained no models. Connection save and delete operations invalidate the snapshot and configuration-bound catalog cache, so an id reused for another endpoint cannot inherit the former endpoint's models. Adapter registration and plugin removal publish the same invalidation contract, including when a reload occurs during discovery.

Every launch path requires an enabled LLM connection and exact selector evidence. Conversation, project, and application defaults define precedence only; Station does not rank providers, select the first of multiple configured connections, or replace an unsupported selector with the first catalog model. When exactly one enabled LLM connection exists, it is unambiguous and may be used without a separately persisted default. Non-Bedrock chat overrides resolve through the selected provider's bounded catalog, and Ollama sessions reject model-less or server-absent selectors rather than inventing `llama3.2`.

Bedrock launch selectors are evidence-backed through one shared resolver used by inventory, `/bedrock/models`, model detail, validation, configured-model resolution, and the built-in adapter. Runtime initialization constructs the catalog and LLM provider from the same configured region and injects both into the adapter; the adapter has no independent default-region launch path. On-demand foundation-model IDs remain unchanged. An active inference profile is exposed only when its complete returned model-ARN set resolves to exactly one foundation model; every profile satisfying that relationship is exposed as its own selector, and Station does not choose among them. A provisioned-only base ID resolves implicitly only when exactly one such profile matches, including cross-region profiles discovered through bounded pagination; ambiguous or multi-model relationships are rejected. Unknown selectors, missing catalogs, and model-less adapter sessions fail closed before lifecycle events are published. Station does not invent a regional prefix or fall back to a configured selector when evidence is absent. Only streaming, text-capable Bedrock foundation models contribute selectors. Bedrock model, profile, and pricing caches expire after 15 minutes; pricing region ids are validated before AWS access, its per-region cache is capped at 32 LRU entries, and responses exceed neither 32 pages, 1,000 raw entries, nor 2 MiB. Model and pricing routes enforce a 2 MiB serialized-response ceiling. Google models are launchable only when the API explicitly reports `generateContent`, and incomplete Claude catalogs retain truncation metadata rather than being cached as complete.

**Response**:
```json
{
  "success": true,
  "data": {
    "schemaVersion": "station.model-inventory/v2",
    "observedAt": "2026-07-19T13:00:00.000Z",
    "models": [
      {
        "id": "model:ollama-local:qwen3%3A30b",
        "connectionId": "ollama-local",
        "connectionKind": "model",
        "providerId": "ollama-local",
        "runtime": { "id": "ollama", "version": null },
        "adapter": { "id": "station-ollama", "version": null },
        "model": {
          "id": "qwen3:30b",
          "revision": null,
          "quantization": null
        },
        "providerModel": "qwen3:30b",
        "aliases": ["qwen3:30b"],
        "displayName": "Qwen 3 30B",
        "locality": "local",
        "availability": "available",
        "freshness": "live",
        "observedAt": "2026-07-19T13:00:00.000Z",
        "effectiveContextTokens": null,
        "toolSurface": null,
        "supportsVision": null
      }
    ],
    "diagnostics": []
  }
}
```

**Consumers**: the Station SDK exports `fetchLaunchableModelInventory()` and `useLaunchableModelInventoryQuery()`. Datum-backed Auto routing is planned in `archive#423`. Its upstream contract must preserve Station's unknown execution dimensions rather than coercing them into a complete Bearing profile; that prerequisite is tracked in `kontourai/datum#21`. Existing manual model selection does not use or change this endpoint.

> ## ⚠️ Superseded by archive#1398 slice 2 — read this before the section above
>
> **This endpoint no longer returns `station.model-inventory/v2`.** Both halves of §5.3's recorded decision shipped together:
>
> 1. **Scope**: it requires the **`inference:invoke`** pairing scope instead of inheriting the `/api/connections` family's `orchestration:read` — a longest-prefix leaf override, the same mechanism `GET /api/environments/ssh/sessions` uses.
> 2. **Payload**: it returns the **contributed-subset projection** (`station.fleet-contribution/v1`) — the same body and the same disclosure surface as [`GET /api/inference/manifest`](#read-the-contributed-model-manifest). Everything documented above about the un-projected inventory now describes an *in-process* value (`ConnectionService#listLaunchableModelInventory()`), not this route's response.
>
> Shipping only the scope half would have been worse than shipping neither. Raising the tier hands this endpoint to precisely the fleet-peer class the completion route's refusal parity is built to keep from learning what this Station has but has **not** contributed — a peer that cannot discover a withheld model through `POST /api/inference/completions` must not be able to read the whole list here.
>
> The reasoning for narrowing at all (`docs/design/inference-fleet.md` §5.3, §10 OQ-2): a model name discloses hardware class, spend, and what its owner works on, and the fleet design turns that list into a routing input. Tightening now is reversible; discovering the exposure later is not.
>
> **Protected routes have no loopback bypass.** A credential-less caller over an SSH local forward receives `401 authentication_required`, just like any other direct caller. The UI proxy relays browser bearer/device-session credentials; Station's exact per-boot internal-token attestation is reserved for genuine internal/MCP callers and is a process credential, not authority inferred from a loopback address.
>
> **Who this affects.** Direct consumers, including an SSH-forwarded browser, must present a supported credential. No in-repo caller existed — no view, CLI command, MCP tool, or E2E spec. What changes for out-of-repo consumers:
>
> - The SDK exports are **renamed and re-typed**: `fetchLaunchableModelInventory()` / `useLaunchableModelInventoryQuery()` are now `fetchContributedModelManifest()` / `useContributedModelManifestQuery()`, returning `FleetContributionManifest`. Renamed deliberately rather than silently re-typed — a type change under the old name compiles everywhere while meaning something else. No alias is kept; this repo ships no compat shims.
> - An embedder holding a `read-only`, `standard`, or `delegation` credential now receives `403 insufficient_scope`. Re-pair with the `inference` preset.

---

### Get One Connection
```http
GET /api/connections/:id
```

Returns a single connection projection with the same shape used by the list endpoints.

**Used by**: `RuntimeConnectionView.tsx`

---

### Save a Connection
```http
POST /api/connections
PUT /api/connections/:id
```

Creates or updates a connection.

For runtime connections, the writable payload remains the existing editable surface (`name`, `enabled`, `config`). The server-projected `runtimeCatalog` is read-only response state and should not be treated as user-editable input.

**Used by**: `ProviderSettingsView.tsx`, `KnowledgeConnectionView.tsx`, `RuntimeConnectionView.tsx`

---

### Delete or Reset a Connection
```http
DELETE /api/connections/:id
```

Deletes a model connection or resets a runtime connection override.

**Used by**: `ProviderSettingsView.tsx`, `RuntimeConnectionView.tsx`

---

### Test a Connection
```http
POST /api/connections/:id/test
```

Runs a lightweight health check for the selected connection.

**Response**:
```json
{
  "success": true,
  "data": {
    "healthy": true,
    "status": "ready",
    "prerequisites": []
  }
}
```

**Used by**: `ProviderSettingsView.tsx`, `RuntimeConnectionView.tsx`

---

## Fleet Inference

Station's serving side of the inference fleet (archive#1398, `docs/design/inference-fleet.md`). A peer holding a credential for this Station can read which local models it contributes and ask for a completion on one of them. **This is not `delegate_task`**: a delegated task runs here, with this machine's agents, tools, credentials, and workspace, and persists in this machine's event store. Fleet inference keeps the agent loop, the tools, the files, and the event record on the *consumer* — only token generation happens here. There is no `tools` field, no session, no filesystem access, and no agent slug anywhere in this family.

**Authorization.** The whole `/api/inference/**` family requires the **`inference:invoke`** pairing scope and nothing else. Only the `inference` pairing preset grants it. It is deliberately absent from the default grant, so an unscoped offer, a credential migrated from a pre-scoping registry, and the Station operator bootstrap credential all lack it — including for local testing, where you must mint an `inference`-preset grant.

**No loopback bypass.** Like every protected route family, this one refuses a direct loopback caller that presents no credential (`401 authentication_required`). An SSH local forward is indistinguishable from a genuinely local caller at the TCP layer, so it must use a bearer or device-session credential; the exact Station-owned, per-boot internal-token attestation remains a separate internal credential path.

**Bounds.** Request body ≤ 128 KiB, ≤ 64 messages, ≤ 96,000 prompt characters, ≤ 4,096 output tokens, ≤ 64,000 generated characters returned, ≤ 2 concurrent fleet completions, and a **120-second wall-clock deadline per completion**. Values are published on the contract (`FLEET_INFERENCE_LIMITS`, `@kontourai/station-contracts/fleet-inference`) so a caller can size a request rather than discover a limit as a failure.

The deadline is what makes the concurrency cap a bound at all: without it, a provider that accepts a request and never yields holds its slot forever, and two such requests pin the whole fleet surface permanently — for the cost of two requests and no credential beyond `inference:invoke`. It is not caller-tunable, because it protects the serving machine. A client disconnect likewise aborts generation and frees the slot immediately rather than leaving this Station generating tokens nobody will read.

*The deadline is cooperative, not preemptive.* It fires the `AbortSignal` the provider was handed; it does not kill the generator. A provider that observes the signal settles and its slot is freed — that is every provider Station ships. A provider that accepts the signal and never observes it never settles, and **its slot is not freed**: the leak the deadline exists to prevent, relocated behind a worse-behaved adapter. Reaching that requires an operator to install a plugin-supplied provider which ignores abort *and* mark its connection as contributed, which is why it is disclosed rather than defended against — see `docs/design/inference-fleet.md` §12.

*Ingestion is stream-bounded.* A declared `Content-Length` over the ceiling is refused before a byte is read; past that, the body is read chunk by chunk and the reader is cancelled the moment observed bytes exceed the cap. A caller that lies about its length, or sends a chunked body with no declared length, is stopped mid-stream rather than buffered in full and measured afterwards.

**Refusals are named, never a 404.** Every rejection returns `{ "refusal": { schemaVersion, code, message, participation?, refusedAt } }` with a closed `code`. A model this Station could launch but has not contributed is refused identically to one that does not exist — distinguishing them would let a peer enumerate the models the owner deliberately withheld.

| `code` | Status | Meaning |
|---|---|---|
| `contribution-disabled` | 403 | The opt-in is off, or on with no connection marked. |
| `model-not-contributed` | 403 | That model is not in the contributed subset. |
| `model-unavailable` | 503 | Contributed, but not routable right now. |
| `contribution-unavailable` | 503 | This Station cannot currently say what it offers. Unknown, not empty. |
| `streaming-unsupported` | 400 | `stream: true` — reserved, refused rather than silently buffered. |
| `request-invalid` | 400 | Malformed body, bad role, empty `messages`, missing `model`. |
| `request-too-large` | 413 | A published size ceiling was exceeded. |
| `capacity-exhausted` | 429 | Concurrency limit reached. Retry shortly. |
| `completion-timeout` | 504 | The 120s deadline elapsed; the stream was aborted and the slot freed. Distinct from `execution-failed` — the provider did not fail, it failed to *finish*. |
| `request-abandoned` | 499 | The caller disconnected before the completion finished. Nobody receives this; it exists so the outcome is named rather than indistinguishable from a success. |
| `execution-failed` | 502 | The local provider failed. Upstream error text is never relayed. |

### Read The Contributed Model Manifest
```http
GET /api/inference/manifest
```

The `station.fleet-contribution/v1` projection (archive#1398 slice 1) as it crosses the machine boundary. This is the **only** place participation is readable: the public handshake advertises the static `fleetInference` protocol-support flag and never whether this Station is currently contributing anything, so an unauthenticated LAN or tailnet scanner cannot enumerate which of the owner's machines have GPUs.

`GET /api/connections/model-inventory` serves this same body, for the same scope — that leaf is the compatibility-path spelling of this route, not a wider one.

`participation` is a four-state fact — `contributing`, `disabled`, `nothing-contributed`, `contributed-unavailable` — and three of the four carry `models: []`, so the array is never the signal. `diagnostics[]` names which empty it is, per connection. Foreign diagnostic message text is truncated at 240 characters at this boundary; the `code` is the authoritative fact and the message is supporting prose.

**Response**:
```json
{
  "manifest": {
    "schemaVersion": "station.fleet-contribution/v1",
    "projectedAt": "2026-08-01T10:00:01.000Z",
    "sourceObservedAt": "2026-08-01T10:00:00.000Z",
    "participation": "contributing",
    "models": [
      {
        "id": "model:ollama-workstation:llama3.3%3A70b",
        "connectionId": "ollama-workstation",
        "providerModel": "llama3.3:70b",
        "model": { "id": "llama3.3", "revision": null, "quantization": null },
        "aliases": ["llama3.3:70b"],
        "displayName": "Llama 3.3 70B",
        "locality": "local",
        "availability": "available",
        "freshness": "live",
        "observedAt": "2026-08-01T10:00:00.000Z",
        "effectiveContextTokens": 131072,
        "supportsVision": false
      }
    ],
    "diagnostics": []
  }
}
```

`projectedAt` is when the projection ran and is **not** a freshness input; `sourceObservedAt` and the per-model `observedAt` are. A fresh projection of a stale inventory is a stale claim.

### Serve A Completion
```http
POST /api/inference/completions
```

**Request**:
```json
{
  "model": "model:ollama-workstation:llama3.3%3A70b",
  "messages": [
    { "role": "system", "content": "You summarize changelogs." },
    { "role": "user", "content": "Summarize the 0.7.0 release." }
  ],
  "maxOutputTokens": 512,
  "temperature": 0.2
}
```

`model` is the manifest's `id`, matched exactly — a provider-native id or an alias is refused, so the manifest is the only way to address a contributed model. `role` is `system`, `user`, or `assistant`; there is no `tool` role. `maxOutputTokens` above the ceiling is refused rather than silently clamped, because clamping would let a consumer believe it bounded a cost it did not.

**Response**:
```json
{
  "completion": {
    "schemaVersion": "station.fleet-inference-completion/v1",
    "delivery": "buffered",
    "model": {
      "id": "model:ollama-workstation:llama3.3%3A70b",
      "connectionId": "ollama-workstation",
      "providerModel": "llama3.3:70b",
      "displayName": "Llama 3.3 70B"
    },
    "servedAt": "2026-08-01T10:00:02.000Z",
    "content": "The 0.7.0 release …",
    "stop": "provider",
    "finishReason": "stop",
    "usage": { "inputTokens": 412, "outputTokens": 88 },
    "elapsedMs": 1840
  }
}
```

`stop` reports whether the *provider* ended generation (`provider`) or this Station's own response ceiling did (`response-bound`), separately from the provider's `finishReason` — a truncated answer must not read as a complete one. `usage: null` means the provider reported none; that is unknown, not zero.

**Specified for streaming, buffered in v1** (`inference-fleet.md` §10 OQ-8). `delivery` is the discriminant that makes streaming additive: a future streaming release answers `stream: true` with an event stream whose terminal event is exactly this object carrying `delivery: "stream"`. A consumer that never sets `stream` sees no change; one that branches on `delivery` is correct in both worlds. Until then `stream: true` is refused by name rather than served buffered, because a consumer told it is streaming when it is not has been misinformed about the path it routes over.

### Who May Turn Contribution On

Enabling contribution is `PUT /config/app` (`AppConfig.fleetContribution`), which sits in the `/config` family at **`orchestration:operate`** — unchanged by this slice, and stated here rather than left implicit (`inference-fleet.md` §5.4).

So a `delegation`-scoped peer or a Standard paired device can turn contribution on. That was weighed and accepted rather than overlooked, **on one stated precondition**: the credential that flips the switch must not be the one that benefits from it.

The accepted case is a credential holding `orchestration:operate` and *not* `inference:invoke`. Such a peer already authorizes starting arbitrary agent sessions and driving turns on this Station — strictly *more* authority over this machine's compute than causing it to serve buffered completions — and flipping the opt-in grants it nothing, because it cannot invoke what it enabled. Adding a consent ceremony in front of the lesser of two powers the same credential already holds would teach the wrong lesson about which gate matters.

**That reasoning stops holding the moment one grant carries both scopes**, so the code does not rely on it. A credential presenting `inference:invoke` is **refused (403) any write to `fleetContribution`** through `PUT /config/app`. Otherwise such a peer could enable contribution, name a connection — including a *billable hosted* one, since `connectionIds` rides the same write — and then spend the owner's money through `/api/inference/**` with no operator in the loop at any step. That is not "less authority than running agents here"; it is a self-authorized, self-serving budget. The guard covers `connectionIds` as well as `enabled` (naming a new connection on an already-enabled Station is the same act), is scoped to that one field so the peer's other settings writes are unaffected, and does not touch a caller presenting no credential — the loopback operator, who is exactly who should be making this decision.

What remains true is that `PUT /config/app` is a broad write at a broad tier; narrowing that surface generally is the honest fix, and the scope vocabulary this slice adds makes it cheap to do later.

---

 ## Orchestration model launch behavior

`POST /api/orchestration/chat` accepts model controls only inside the canonical
Environment + Agent `target`. They are capability-gated before adapter readiness
or model discovery is invoked. A launch is either
Station-resolved with an honest `catalog-pending` selector that becomes
`catalog-accepted` only after adapter catalog validation, deliberately
engine-selected with no Station-invented model id, or unavailable with a stable
reason. Adapters without a model-lifecycle capability declaration receive an explicit
`capability-absent` omission plan;
their explicit model overrides fail closed. `modelId` is a request, not a runtime
observation: session read models keep typed requested/applied facts separate from
an engine's independently reported model. `appliedModel` is present only after a
real adapter apply boundary; ACP `session.configured.model` echoes from the earlier
metadata-only projection never
become applied. `reportedModel` is never derived from either fact.
Bound continuation at `POST /api/orchestration/chat/:conversationId/continue`
accepts no target or model replacement. Unsupported lifecycle overrides
return `model-override-unsupported` and create no adapter dispatch or
effective-model receipt. Bedrock/Ollama resume and omitted turns retain the
accepted session model; an explicit replacement is catalog-validated. ACP model
overrides are currently unsupported, including automatic recovery of those
metadata-only model echoes.

## Bedrock Models

### List Available Models
```http
GET /bedrock/models
```

Returns all foundation-model selectors that AWS marks `ON_DEMAND` plus `ACTIVE` inference-profile selectors whose complete returned model-ARN set resolves to one streaming, text-capable foundation model. Profile capability fields are copied from that AWS foundation-model evidence. The route omits relation-unknown or multi-model profiles, does not infer regional relationships, and does not suppress an on-demand selector merely because a related profile exists.

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "modelArn": "arn:aws:bedrock:...",
      "modelName": "Claude 3.5 Sonnet",
      "providerName": "Anthropic",
      "inputModalities": ["TEXT", "IMAGE"],
      "outputModalities": ["TEXT"],
      "responseStreamingSupported": true,
      "customizationsSupported": [],
      "inferenceTypesSupported": ["ON_DEMAND"]
    }
  ]
}
```

**Used by**: `ModelsContext.tsx`, `AppDataContext.tsx`, model selector

---

### Get Model Pricing
```http
GET /bedrock/pricing?region=us-east-1
```

**Response**:
```json
{
  "success": true,
  "data": {
    "anthropic.claude-3-5-sonnet-20240620-v1:0": {
      "inputTokenPrice": 0.003,
      "outputTokenPrice": 0.015
    }
  }
}
```

**Used by**: Cost calculations, analytics

---

### Validate Model ID
```http
GET /bedrock/models/:modelId/validate
```

**Response**:
```json
{
  "success": true,
  "data": {
    "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "isValid": true
  }
}
```

**Used by**: Model validation in forms

---

### Get Model Info
```http
GET /bedrock/models/:modelId
```

Accepts either a launchable foundation-model selector or an evidence-backed inference-profile selector returned by `GET /bedrock/models`. Detail lookup and list membership use the same bounded launchability projection.

**Response**:
```json
{
  "success": true,
  "data": {
    "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "modelName": "Claude 3.5 Sonnet",
    "providerName": "Anthropic",
    ...
  }
}
```

**Used by**: Model details, capabilities checking

---

## Analytics

### Get Usage Statistics
```http
GET /api/analytics/usage
```

**Response**:
```json
{
  "data": {
    "totalMessages": 1000,
    "totalTokens": 50000,
    "totalCost": 2.50,
    "byAgent": {
      "my-agent": {
        "messages": 500,
        "tokens": 25000,
        "cost": 1.25
      }
    },
    "byDay": [
      {
        "date": "2025-12-08",
        "messages": 100,
        "tokens": 5000,
        "cost": 0.25
      }
    ]
  }
}
```

**Used by**: `AnalyticsContext.tsx`, analytics dashboard

---

### Get Achievements
```http
GET /api/analytics/achievements
```

**Response**:
```json
{
  "data": [
    {
      "id": "first-message",
      "title": "First Message",
      "description": "Sent your first message",
      "unlocked": true,
      "unlockedAt": "2025-12-08T12:00:00Z"
    }
  ]
}
```

**Used by**: `AnalyticsContext.tsx`, achievements display

---

### Rescan Analytics
```http
POST /api/analytics/rescan
```

Triggers a full rescan of all conversation data to rebuild analytics.

**Response**:
```json
{
  "data": { /* updated stats */ },
  "message": "Full rescan completed"
}
```

**Used by**: `AnalyticsContext.tsx`, analytics management

---

## Monitoring

### Get System Stats
```http
GET /monitoring/stats
```

**Response**:
```json
{
  "success": true,
  "data": {
    "agents": [
      {
        "slug": "my-agent",
        "name": "Station Agent",
        "status": "idle",
        "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
        "conversationCount": 10,
        "messageCount": 100,
        "cost": 5.00,
        "healthy": true
      }
    ],
    "summary": {
      "totalAgents": 1,
      "activeAgents": 0,
      "runningAgents": 0,
      "totalMessages": 100,
      "totalCost": 5.00
    }
  }
}
```

**Used by**: `MonitoringContext.tsx`, monitoring dashboard

---

### Get Historical Metrics
```http
GET /monitoring/metrics?range=today
```

**Query Parameters**:
- `range`: `today` | `week` | `month` | `all`

**Response**:
```json
{
  "success": true,
  "data": {
    "range": "today",
    "metrics": [
      {
        "agentSlug": "my-agent",
        "messageCount": 50,
        "conversationCount": 5,
        "totalCost": 2.50
      }
    ]
  }
}
```

**Used by**: `MonitoringContext.tsx`, metrics visualization

---

### Get/Stream Events (SSE)
```http
GET /monitoring/events?start=2025-12-08T00:00:00Z&end=2025-12-08T23:59:59Z&userId=default-user
```

**Query Parameters**:
- `start`: ISO timestamp (optional, for historical)
- `end`: ISO timestamp (optional, for historical)
- `userId`: User ID filter (default: `default-user`)

**Response** (historical):
```json
{
  "success": true,
  "data": [
    {
      "type": "message",
      "timestamp": "2025-12-08T12:00:00Z",
      "agentSlug": "my-agent",
      "conversationId": "conv-123",
      "messageCount": 1
    }
  ]
}
```

**Response** (streaming SSE):
```
data: {"type":"connected","timestamp":"2025-12-08T12:00:00Z"}

data: {"type":"message","agentSlug":"my-agent","conversationId":"conv-123"}

data: {"type":"heartbeat","timestamp":"2025-12-08T12:00:30Z"}
```

**Used by**: `MonitoringContext.tsx`, real-time monitoring

---

## Agent Invocation

### 🟢 ✅ Silent Invocation (No Memory)
```http
POST /agents/:slug/invoke
```

Invoke agent without loading conversation history. Used for dashboard data fetching and utility tasks.

**Request Body**:
```json
{
  "prompt": "What's the weather today?",
  "silent": true,
  "model": "anthropic.claude-3-haiku-20240307-v1:0",
  "tools": ["files_read_file"]
}
```

**Response**:
```json
{
  "success": true,
  "response": "The weather is sunny...",
  "usage": {
    "inputTokens": 100,
    "outputTokens": 50
  }
}
```

**Error** (authentication):
```json
{
  "success": false,
  "error": "authentication failed"
}
```
Status: `401`

**Status**: In use  
**Used by**: 
- Dashboard widgets, background data fetching
- `station-layout/CRM.tsx` (activity description generation)
- `AgentEditorView.tsx` (prompt generation with `default` agent)

**Tip**: Use the `default` agent for simple text generation without tools:
```bash
POST /agents/default/invoke
{
  "prompt": "Generate a professional email subject line",
  "silent": true
}
```

---

### Raw Tool Call (No LLM)
```http
POST /agents/:slug/tools/:toolName
```

Execute a tool directly without LLM processing.

**Request Body**: Tool arguments
```json
{
  "startDate": "2025-12-08",
  "endDate": "2025-12-15"
}
```

**Response**:
```json
{
  "success": true,
  "response": { /* tool result */ },
  "debug": {
    "toolDuration": 150.5,
    "totalDuration": 152.3
  }
}
```

**Used by**: Direct tool invocations, testing

---

### Streaming Invocation
```http
POST /agents/:slug/invoke/stream
```

Invoke agent with streaming response and optional structured output.

**Request Body**:
```json
{
  "prompt": "List files in the documents folder",
  "silent": true,
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "tools": ["files_list_directory"],
  "maxSteps": 10,
  "schema": {
    "type": "object",
    "properties": {
      "files": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "size": { "type": "number" }
          }
        }
      }
    }
  }
}
```

**Response** (SSE stream):
```
data: {"type":"text-delta","text":"Looking"}

data: {"type":"tool-call","toolName":"files_list_directory"}

data: {"type":"tool-result","result":{...}}

data: {"type":"finish","text":"Here are your files..."}
```

**Used by**: Streaming responses with structured output

---

## Attachments

### Get Attachment Bytes
```http
GET /api/attachments/:ref
```

The bytes behind an attachment a transcript is showing, where `:ref` is the
`sha256-<64 hex>` content reference persisted on the turn's `attachments`
(archive#3374/#3385). Authenticated at the `orchestration:read` pairing tier.

The response deliberately **does not name the image's type**: the store is
addressed by bytes alone and holds no MIME type, and two attachments with
different declared names can share one digest. The declared type lives on the
attachment metadata in the event, and the client applies it when it builds the
Blob. Serving inert bytes under `nosniff` also means a direct navigation
downloads rather than renders.

| status | meaning |
|---|---|
| `200` | `application/octet-stream`, `ETag: "<ref>"`, `Cache-Control: private, max-age=3600`, plus `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cross-Origin-Resource-Policy: same-origin` |
| `400` | `:ref` is not a `sha256-<64 lowercase hex>` reference — refused before it reaches any path |
| `404` | no such blob: never written, or reclaimed by retention. The transcript renders its chip without a preview |

**Used by**: `FilePartPreview` (fetch → object URL), the chat dock's retry
recovery.

---

## Model Capabilities

### Get Model Capabilities
```http
GET /api/models/capabilities
```

This is a **Bedrock-only** projection of `ListFoundationModels`: it is empty
without AWS credentials and carries no row for a Claude Code, Codex, ACP, or
Ollama model. A missing row means the catalog has nothing to say about that
model, never that the model rejects images — `useModelImageSupport` keeps that
distinction as a three-state answer (archive#3344), and the response envelope
carries the provenance it needs to (archive#3373).

Full description, including `source` and `complete`:
[Standalone Model Capability Routes](#standalone-model-capability-routes) below.

**Used by**: `ModelCapabilitiesContext.tsx`, the chat composer's attachment gate

---

## Error Handling

All endpoints follow a consistent error response format:

**Success**:
```json
{
  "success": true,
  "data": { /* response data */ }
}
```

**Error**:
```json
{
  "success": false,
  "error": "Error message"
}
```

**HTTP Status Codes**:
- `200`: Success
- `201`: Created
- `400`: Bad Request (validation error)
- `401`: Unauthorized (authentication error)
- `404`: Not Found
- `500`: Internal Server Error

**Authentication Errors** (Status `401`):
Triggered when error message contains:
- `authentication failed`
- `status code 403`
- `Form action URL not found`

---

## Frontend Usage Summary

### Contexts Using API Endpoints

| Context | Endpoints Used |
|---------|---------------|
| `AgentsContext` | `/api/agents`, `/agents/:slug`, `/agents` (POST/PUT/DELETE) |
| `LayoutsContext` | removed during project-layout convergence |
| `ConversationsContext` | `/agents/:slug/conversations`, `/agents/:slug/conversations/:id/messages`, `/agents/:slug/tools` |
| `StatsContext` | `/agents/:slug/conversations/:id/stats` |
| `ConfigContext` | `/config/app` (GET/PUT) |
| `ModelsContext` | `/bedrock/models` |
| `AppDataContext` | `/bedrock/models` |
| `AnalyticsContext` | `/api/analytics/usage`, `/api/analytics/achievements`, `/api/analytics/rescan` |
| `MonitoringContext` | `/monitoring/stats`, `/monitoring/events` |
| `ModelCapabilitiesContext` | `/api/models/capabilities` |
| `WorkflowsContext` | `/agents/:slug/workflows/files` |

### Components Using Direct API Calls

- **ChatDock**: Uses the custom `/api/agents/:slug/chat` streaming endpoint
- **Station Layout**: `/agents/:slug/tools/:toolName`
- **Agent Editor**: Integration management endpoints
- **Settings View**: Configuration endpoints

---

## Auth & Users

> **New section** — routes from `src-server/routes/system/auth.ts`

### Get Auth Status
```http
GET /auth/status
```

Returns current authentication status and resolved user identity.

**Response**:
```json
{
  "authenticated": true,
  "user": {
    "alias": "jdoe",
    "name": "Jane Doe",
    "email": "jdoe@example.com"
  }
}
```

---

### Renew Credentials
```http
POST /auth/renew
```

Triggers credential renewal via the configured auth provider.

**Response**:
```json
{
  "success": true,
  "message": "Credentials renewed"
}
```

---

### Terminal Auth Renew
```http
POST /auth/terminal
```

Alias for `/auth/renew` — triggers credential renewal (used for terminal-based auth flows).

**Response**: Same as `/auth/renew`

---

### Get Badge Photo
```http
GET /auth/badge-photo/:id
```

Returns a JPEG badge/profile photo for the given user ID. Requires the configured auth provider to support `getBadgePhoto`.

**Response**: `image/jpeg` binary  
**Cache-Control**: `public, max-age=86400`  
**Error**: `404` if not found or provider does not support photos

---

### Search Users
```http
GET /users/search?q=<query>
```

Search the user directory by name or alias.

**Query Parameters**:
- `q`: Search string (required; returns `[]` if empty)

**Response**:
```json
[
  { "alias": "jdoe", "name": "Jane Doe", "email": "jdoe@example.com" }
]
```

---

### Lookup User by Alias
```http
GET /users/:alias
```

Look up a specific user by their alias.

**Response**:
```json
{ "alias": "jdoe", "name": "Jane Doe", "email": "jdoe@example.com" }
```

**Error** (`404`):
```json
{ "alias": "jdoe", "name": "jdoe", "error": "User not found" }
```

---

## Branding

> **New section** — routes from `src-server/routes/system/branding.ts`

### Get Branding Config
```http
GET /branding
```

Returns resolved branding configuration from the active branding provider.

**Response**:
```json
{
  "name": "Station",
  "logo": null,
  "theme": null,
  "welcomeMessage": null
}
```

Fields are `null` when the provider does not implement the optional method.

---

## Events (SSE)

> **New section** — routes from `src-server/routes/orchestration/events.ts`

### Subscribe to Real-Time Events
```http
GET /events
```

Opens a Server-Sent Events stream for all real-time server events. On connect, replays the current ACP connection state so clients don't miss events that fired before they subscribed.

**Response** (SSE stream):
```
event: acp:status
data: {"connected":true,"connections":[{"id":"acp-1","status":"connected"}]}

event: system:status-changed
data: {"source":"config"}

event: ping
data: 
```

A `ping` keepalive is sent every 30 seconds.

---

## File System

> **New section** — routes from `src-server/routes/projects/fs.ts`

### Browse Directories
```http
GET /fs/browse?path=<path>
```

Lists directories (not files) at the given path. Used by the UI directory picker.

**Query Parameters**:
- `path`: Absolute path or `~` for home directory (default: `~`)

**Response**:
```json
{
  "path": "~/projects",
  "entries": [
    { "name": "Documents", "isDirectory": true },
    { "name": "Downloads", "isDirectory": true }
  ]
}
```

Entries are sorted: non-dotfiles first, then dotfiles, each group alphabetically.

**Errors** — one status and message per cause (archive#3158); the response never
echoes the requested path:

| Status | `error` | Cause |
|--------|---------|-------|
| `404` | `Folder not found` | `ENOENT` — nothing at that path |
| `403` | `Permission denied reading this folder` | `EACCES`/`EPERM` — it exists, Station cannot read it |
| `400` | `That path is a file, not a directory` | `ENOTDIR` |
| `500` | `Folder could not be read` | Anything else; the cause is logged server-side |

---

## Insights

> **New section** — routes from `src-server/routes/operations/insights.ts`

### Get Usage Insights
```http
GET /insights?days=14
```

Aggregates monitoring event logs to produce tool usage, hourly activity, agent usage, and model usage statistics.

**Query Parameters**:
- `days`: Number of days to look back (default: `14`)
- `agent`, `tool`, `engine`: exact-match filters (archive#3075). `engine` reads
  `gen_ai.provider.name`, added in archive#3074 — events written before it
  carry no engine and are excluded by that filter rather than guessed at.
- `limit`: keep the top N buckets by rank, server-side (cap 500)

Scope notes, because the filters interact with the other dimensions:
`tool=` filters the whole scan, so `totalChats`/`agentUsage`/`modelUsage` go
to zero for a tool-filtered request — those are "not asked", not "none".
`engine=` yields an empty `modelUsage` structurally, because the
agent-complete event that carries the model does not carry a provider.
`tool=` also cannot reach the `(unnamed)` bucket, which is a derived absence
rather than a value on the event.

When any filter or limit is applied, the response echoes it under `applied`,
so a filtered rollup cannot be mistaken for a whole-corpus one.

**Response**:
```json
{
  "data": {
    "toolUsage": {
      "files_read_file": { "calls": 42, "errors": 1 },
      "(unnamed)": { "calls": 3, "errors": 0 }
    },
    "hourlyActivity": [0, 0, 0, 0, 0, 0, 2, 5, 12, 18, 20, 15, 10, 8, 14, 16, 12, 9, 6, 4, 2, 1, 0, 0],
    "agentUsage": {
      "my-agent": { "chats": 30, "tokens": 45000 }
    },
    "modelUsage": {
      "anthropic.claude-3-5-sonnet-20240620-v1:0": 28
    },
    "totalChats": 30,
    "totalToolCalls": 42,
    "totalErrors": 1,
    "days": 14
  }
}
```
`totalOutcomeUnknown` (and `outcomeUnknown` per tool) counts results whose
producer reported no terminal status. They are in `totalToolCalls` but are
neither successes nor failures, so an error rate computed without them
flatters itself.

### The rows behind the rollup

They live on `GET /monitoring/events` (historical branch, i.e. with `start`
and/or `end`), which now accepts `agent`, `tool`, `engine`, `conversation`,
`tools=true` and `limit`.

`limit` is **opt-in**: omit it and you get every matching row. It caps at
5000, and its semantics are a tail — the most recent N **by timestamp**.
Rows are returned oldest-first, and that ordering is derived from each row's
own timestamp rather than from the order the daily log files were enumerated
(`readdir` guarantees no order, and an OTLP backfill persists client-supplied
timestamps, so write order and timestamp order genuinely disagree). The order
does not change depending on whether you pass a limit. `truncated: true` says
rows were actually dropped, not merely that the cap was reached.

The route does not invent a default cap, and that is deliberate: an earlier
version applied the MCP tool's 500-row default here, at a route the Monitoring
view and `station monitoring events` also use. Neither passes a limit, neither
reads `truncated`, so a month-long range silently became its most recent 500
rows — and the view builds its conversation autocomplete from that array, so
filtering for an older conversation reported it did not exist. A consumer that
needs a bound sets one.

A `start` or `end` that does not parse is a `400`, not a wider window. Epoch
milliseconds and ISO 8601 are both accepted; epoch *seconds* parse as a 1970
timestamp, which is why an unparseable bound must not silently fall back.

Deliberately NOT a second endpoint under `/api/insights` (archive#3076): that
handler already applies the two authorization layers these rows require — the
per-user filter inside `queryEventsFromDisk` and the tenant predicate in
`filterMonitoringEvents` — and an export that re-derives an authorization
check is one that eventually gets it wrong. A first attempt here did exactly
that and returned other users' rows.

Also reachable as the `read_monitoring_events` MCP tool, which reads a
different store from `read_logs`.

The `(unnamed)` bucket counts tool calls whose producer reported no name
(archive#3073). It is deliberately distinct from a tool literally named
`unknown`, which older events — written when the name was substituted at
write time — still carry as their own bucket.


---

## Standalone Model Capability Routes

> **New section** — routes from `src-server/routes/connections/models.ts`
>
> **Note**: These standalone routes remain available, but new integrations should use `/bedrock/models` and `/bedrock/pricing` from `bedrock.ts`.

### Get Model Capabilities
```http
GET /api/models/capabilities
```

Lists all ACTIVE and LEGACY **Bedrock** foundation models with capability flags. Results are cached for 1 hour, keyed by the region in effect.

Scope, stated on the response rather than left to the path (archive#3373):

- `source: 'bedrock'` — the one catalogue projected here. There is no row for a
  Claude Code, Codex, ACP, or Ollama model, so a model absent from `data` is not
  evidence that it lacks a capability.
- `complete` — whether that catalogue was actually enumerated. `complete: false`
  means `data` is **unknown**, not empty. Read an absent row as "unsupported"
  only when `complete` is `true`.

**Response**:
```json
{
  "success": true,
  "source": "bedrock",
  "complete": true,
  "data": [
    {
      "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "modelName": "Claude 3.5 Sonnet",
      "provider": "Anthropic",
      "inputModalities": ["TEXT", "IMAGE"],
      "outputModalities": ["TEXT"],
      "supportsStreaming": true,
      "supportsImages": true,
      "supportsVideo": false,
      "supportsAudio": false,
      "lifecycleStatus": "ACTIVE"
    }
  ]
}
```

**No AWS credentials** (`200`): `{ "success": true, "data": [], "source": "bedrock", "complete": false, "warning": "AWS credentials not configured" }` — the catalogue could not be read.

**Error** (`500`): `{ "success": false, "error": "..." }` for any other failure.

---

### Get Model Pricing (Standalone Route)
```http
GET /api/models/pricing/:modelId?region=us-east-1
```

Fetches per-token pricing for a specific model from the AWS Pricing API.

**Path Parameters**:
- `modelId`: Bedrock model ID

**Query Parameters**:
- `region`: AWS region (default: `AWS_REGION` env or `us-east-1`)

**Response**:
```json
{
  "data": {
    "modelId": "anthropic.claude-3-5-sonnet-20240620-v1:0",
    "region": "us-east-1",
    "inputTokenPrice": 0.003,
    "outputTokenPrice": 0.015,
    "currency": "USD"
  }
}
```

---

## Plugins

> **New section** — routes from `src-server/routes/plugins/plugins.ts`

### List Installed Plugins
```http
GET /plugins
```

Returns all installed plugins with manifest info, bundle status, git metadata, and permission state.

**Response**:
```json
{
  "plugins": [
    {
      "name": "my-plugin",
      "displayName": "My Plugin",
      "version": "1.0.0",
      "description": "A plugin",
      "hasBundle": true,
      "layout": { "slug": "my-layout" },
      "agents": [{ "slug": "assistant" }],
      "providers": [],
      "links": [],
      "git": { "hash": "abc1234", "branch": "main", "remote": "https://github.com/org/my-plugin.git" },
      "permissions": {
        "declared": ["network.fetch"],
        "granted": ["network.fetch"],
        "missing": []
      }
    }
  ]
}
```

---

### Preview Plugin (Pre-install Validation)
```http
POST /plugins/preview
```

Fetches a plugin from a git URL or local path, validates it, and returns manifest, components, conflicts, and dependencies — without installing.

**Request Body**:
```json
{
  "source": "https://github.com/org/my-plugin.git"
}
```

**Response**:
```json
{
  "valid": true,
  "manifest": { "name": "my-plugin", "version": "1.0.0", "agents": [], "providers": [] },
  "components": [
    { "type": "agent", "id": "my-plugin:assistant" },
    { "type": "layout", "id": "my-layout" }
  ],
  "conflicts": [],
  "dependencies": [],
  "git": { "hash": "abc1234", "branch": "main" }
}
```

**Error** (`400`/`500`):
```json
{ "valid": false, "error": "Not a valid plugin: plugin.json not found", "components": [], "conflicts": [] }
```

---

### Install Plugin
```http
POST /plugins/install
```

Installs a plugin from a git URL or local path, including agents, layout config, providers, tools, and dependencies.

**Request Body**:
```json
{
  "source": "https://github.com/org/my-plugin.git",
  "skip": ["agent:my-plugin:assistant"]
}
```

- `source`: Git URL (supports `#branch` suffix) or local path
- `skip`: Optional array of component IDs to exclude (e.g. `"agent:<slug>"`, `"layout:<slug>"`, `"provider:<type>"`, `"tool:<id>"`)

**Response**:
```json
{
  "success": true,
  "plugin": { "name": "my-plugin", "displayName": "My Plugin", "version": "1.0.0", "hasBundle": true },
  "tools": [{ "id": "my-tool", "status": "installed" }],
  "dependencies": [{ "id": "dep-plugin", "status": "installed" }],
  "permissions": {
    "autoGranted": ["network.fetch"],
    "pendingConsent": []
  }
}
```

---

### Check for Plugin Updates
```http
GET /plugins/check-updates
```

Checks all installed plugins for available updates via git fetch (git-installed) or registry version comparison. Registry-installed plugins report the installed plugin name in `name`; when a registry entry id differs from the installed manifest name, callers should use the reported installed name as the route target.

**Response**:
```json
{
  "updates": [
    {
      "name": "my-plugin",
      "currentVersion": "1.0.0",
      "latestVersion": "newer commit available",
      "source": "git"
    }
  ]
}
```

---

### Update Plugin
```http
POST /plugins/:name/update
```

Updates a plugin via `git pull` (git-installed) or registry reinstall. Registry-installed plugins may be addressed by either their installed plugin name or their registry entry id; filesystem, build, prompt, and integration ownership use the installed manifest identity, while the registry provider receives its registry id. A plugin name is immutable across an update. Station snapshots the installed generation, synchronizes its owned agent definitions, activates providers, and reloads runtime agents as one configuration mutation. If validation, build, provider activation, runtime reload, or retired-adapter cleanup fails, the prior plugin files, agents, and provider source are restored or the response remains explicitly activation-pending; a removed provider is never reported as fully activated while its cleanup is unconfirmed.

**Response**:
```json
{
  "success": true,
  "plugin": { "name": "my-plugin", "version": "1.1.0" }
}
```

---

### Remove Plugin
```http
DELETE /plugins/:name
```

Removes a plugin, its agents, layout config, and permission grants. Conversation memory is preserved. Removal is not reported as complete until runtime agent maps have reloaded and retired provider adapters have confirmed cleanup. A durable file removal whose runtime reload is still pending returns HTTP `202` with `success: false` and a `configurationActivation` receipt.

**Response**:
```json
{ "success": true }
```

---

### Serve Plugin Bundle (JS)
```http
GET /plugins/:name/bundle.js
```

Serves the compiled JavaScript bundle for a plugin. Returns `404` if no bundle exists.

**Response**: `application/javascript`

---

### Serve Plugin Bundle (CSS)
```http
GET /plugins/:name/bundle.css
```

Serves the compiled CSS bundle for a plugin. Returns empty `200` if no CSS exists.

**Response**: `text/css`

---

### Get Plugin Permissions
```http
GET /plugins/:name/permissions
```

Returns declared and granted permissions for a plugin.

**Response**:
```json
{
  "declared": ["network.fetch", "fs.read"],
  "granted": ["network.fetch"]
}
```

---

### Grant Plugin Permissions
```http
POST /plugins/:name/grant
```

Grants one or more permissions to a plugin.

**Request Body**:
```json
{ "permissions": ["fs.read"] }
```

**Response**:
```json
{ "success": true, "granted": ["fs.read"] }
```

---

### Plugin Fetch Proxy (Scoped)
```http
POST /plugins/:name/fetch
```

Server-side HTTP proxy for a plugin. Requires the plugin to have the `network.fetch` permission grant.

**Request Body**:
```json
{
  "url": "https://api.example.com/data",
  "method": "GET",
  "headers": { "Authorization": "Bearer <token>" },
  "body": null
}
```

**Response**:
```json
{
  "success": true,
  "status": 200,
  "contentType": "application/json",
  "body": "{\"key\":\"value\"}"
}
```

**Error** (`403`): Plugin does not have `network.fetch` permission.

---

### Unscoped Plugin Fetch Proxy
```http
POST /plugins/fetch
```

Server-side HTTP proxy with no permission check. It has the same request/response shape as the scoped variant above; new integrations must use the scoped route.

---

### Reload Plugin Providers
```http
POST /plugins/reload
```

Clears and reloads all plugin providers from disk. Useful after manual plugin changes.

**Response**:
```json
{ "success": true, "loaded": 3 }
```

---

### Get Plugin Providers
```http
GET /plugins/:name/providers
```

Returns provider declarations for a plugin with their enabled/disabled state.

**Response**:
```json
{
  "providers": [
    { "type": "auth", "module": "dist/auth-provider.js", "layout": null, "enabled": true }
  ]
}
```

---

### Get Plugin Overrides
```http
GET /plugins/:name/overrides
```

Returns the current provider override config for a plugin (e.g. which providers are disabled).

**Response**:
```json
{ "disabled": ["auth"] }
```

---

### Update Plugin Overrides
```http
PUT /plugins/:name/overrides
```

Updates provider override config for a plugin.

**Request Body**:
```json
{ "disabled": ["auth"] }
```

**Response**:
```json
{ "success": true }
```

---

## Registry

> **New section** — routes from `src-server/routes/plugins/registry.ts`

### List Available Agents (Registry)
```http
GET /registry/agents
```

Lists agents available in the configured agent registry provider.

**Response**:
```json
{ "success": true, "data": [{ "id": "my-agent", "version": "1.0.0", "description": "..." }] }
```

---

### List Installed Agents (Registry)
```http
GET /registry/agents/installed
```

Lists agents currently installed via the registry.

**Response**:
```json
{ "success": true, "data": [{ "id": "my-agent", "version": "1.0.0" }] }
```

---

### Install Agent from Registry
```http
POST /registry/agents/install
```

**Request Body**:
```json
{ "id": "my-agent" }
```

**Response**:
```json
{ "success": true, "message": "Installed" }
```

---

### Uninstall Agent from Registry
```http
DELETE /registry/agents/:id
```

**Response**:
```json
{ "success": true }
```

---

### List Available Integrations (Registry)
```http
GET /registry/integrations
```

**Response**:
```json
{ "success": true, "data": [{ "id": "my-tool", "version": "1.0.0", "description": "..." }] }
```

---

### List Installed Integrations (Registry)
```http
GET /registry/integrations/installed
```

**Response**:
```json
{ "success": true, "data": [{ "id": "my-tool", "version": "1.0.0" }] }
```

---

### Install Integration from Registry
```http
POST /registry/integrations/install
```

Installs an integration and auto-generates its `integration.json` from provider metadata.

**Request Body**:
```json
{ "id": "my-tool" }
```

**Response**:
```json
{ "success": true }
```

---

### Uninstall Integration from Registry
```http
DELETE /registry/integrations/:id
```

**Response**:
```json
{ "success": true }
```

---

### Sync Integration Registry
```http
POST /registry/integrations/sync
```

Triggers a sync of the integration registry provider.

**Response**:
```json
{ "success": true }
```

---

### List Available Skills (Registry)
```http
GET /registry/skills
```

Lists skills available in the configured registry provider.

**Response**:
```json
{ "success": true, "data": [{ "id": "my-skill", "description": "..." }] }
```

---

### Install Skill from Registry
```http
POST /registry/skills/install
```

**Request Body**:
```json
{ "id": "my-skill" }
```

**Response**:
```json
{ "success": true }
```

---

### Uninstall Skill from Registry
```http
DELETE /registry/skills/:id
```

**Response**:
```json
{ "success": true }
```

---

### List Available Plugins (Registry)
```http
GET /registry/plugins
```

Lists plugins available in the configured registry provider.

**Response**:
```json
{ "success": true, "data": [{ "id": "my-plugin", "version": "1.0.0", "description": "..." }] }
```

---

### List Installed Plugins (Registry)
```http
GET /registry/plugins/installed
```

**Response**:
```json
{ "success": true, "data": [{ "id": "my-plugin", "version": "1.0.0" }] }
```

---

### Install Plugin from Registry
```http
POST /registry/plugins/install
```

Installs a plugin from the configured plugin registry providers. If multiple plugin registry providers claim the same plugin id, Station rejects the install as ambiguous instead of selecting the first provider.

**Request Body**:
```json
{ "id": "my-plugin" }
```

**Response**:
```json
{ "success": true }
```

---

### Uninstall Plugin from Registry
```http
DELETE /registry/plugins/:id
```

**Response**:
```json
{ "success": true }
```

---

## Scheduler

> **New section** — routes from `src-server/routes/operations/scheduler.ts`

### List Scheduler Providers
```http
GET /scheduler/providers
```

Returns registered scheduler provider names (used to populate UI dropdowns).

**Response**:
```json
{ "success": true, "data": ["cron", "eventbridge"] }
```

---

### Subscribe to Scheduler Events (SSE)
```http
GET /scheduler/events
```

Opens a Server-Sent Events stream for real-time scheduler job events. Sends a `ping` keepalive every 30 seconds.

**Response** (SSE stream):
```
data: {"type":"job-started","target":"my-job","timestamp":"..."}

event: ping
data: 
```

---

### Scheduler Webhook Receiver
```http
POST /scheduler/webhook
```

Receives webhook events from external scheduler providers and broadcasts them to SSE subscribers.

**Request Body**: Any JSON event payload from the scheduler provider.

**Response**:
```json
{ "success": true }
```

---

### List Scheduled Jobs
```http
GET /scheduler/jobs
```

**Response**:
```json
{
  "success": true,
  "data": [
    { "target": "my-job", "schedule": "0 9 * * 1-5", "enabled": true, "lastRun": "..." }
  ]
}
```

---

### Get Scheduler Stats
```http
GET /scheduler/stats
```

**Response**:
```json
{
  "success": true,
  "data": { "totalJobs": 5, "enabledJobs": 4, "lastRunAt": "..." }
}
```

---

### Get Scheduler Status
```http
GET /scheduler/status
```

**Response**:
```json
{
  "success": true,
  "data": { "running": true, "provider": "cron" }
}
```

---

### Preview Cron Schedule
```http
GET /scheduler/jobs/preview-schedule?cron=<expr>&count=5
```

Returns the next N scheduled run times for a cron expression.

**Query Parameters**:
- `cron`: Cron expression (required)
- `count`: Number of upcoming runs to return (default: `5`)

**Response**:
```json
{
  "success": true,
  "data": ["2025-07-15T09:00:00Z", "2025-07-16T09:00:00Z"]
}
```

---

### Get Job Logs
```http
GET /scheduler/jobs/:target/logs?count=20
```

Returns recent run logs for a specific job.

**Query Parameters**:
- `count`: Number of log entries to return (default: `20`)

**Response**:
```json
{
  "success": true,
  "data": [
    { "runAt": "2025-07-14T09:00:00Z", "status": "success", "outputPath": "/path/to/output.log" }
  ]
}
```

---

### Read Run Output
```http
POST /scheduler/runs/output
```

Reads the content of a run output file by its log path.

**Request Body**:
```json
{ "path": "/path/to/output.log" }
```

**Response**:
```json
{ "success": true, "data": { "content": "Job output text..." } }
```

---

### Create Job
```http
POST /scheduler/jobs
```

**Request Body**: Job configuration. `prompt` and `name` are required. Schedule
may use the compatible `cron` string or the provider-neutral union:

```json
{ "schedule": { "kind": "cron", "expr": "0 9 * * *", "timezone": "America/Denver" } }
{ "schedule": { "kind": "every", "everyMs": 300000 } }
{ "schedule": { "kind": "at", "timeMs": 1800000000000, "deleteAfterRun": true } }
```

**Response**:
```json
{ "success": true, "data": { "output": "Job created" } }
```

---

### Update Job
```http
PUT /scheduler/jobs/:target
```

**Request Body**: Updated job options, including the same `schedule` union.

**Response**:
```json
{ "success": true, "data": { "output": "Job updated" } }
```

---

### Run Job Now
```http
POST /scheduler/jobs/:target/run
```

Triggers an immediate run of a scheduled job.

**Response**:
```json
{
  "success": true,
  "data": {
    "output": "Scheduler job completed.",
    "receipt": {
      "outcome": "completed",
      "message": "Scheduler job completed.",
      "runId": "schedule:built-in:daily-report:run-1"
    }
  }
}
```

`data.output` is retained for older clients. New clients can use the additive
receipt to observe the canonical run. A `409` with
`code: "scheduler_run_indeterminate"` means provider work may have started;
it is not safe to retry automatically. A receipt is omitted rather than
guessed if an older server cannot provide a nonempty `runId`.

---

### Enable Job
```http
PUT /scheduler/jobs/:target/enable
```

**Response**:
```json
{ "success": true }
```

---

### Disable Job
```http
PUT /scheduler/jobs/:target/disable
```

**Response**:
```json
{ "success": true }
```

---

### Delete Job
```http
DELETE /scheduler/jobs/:target
```

**Response**:
```json
{ "success": true }
```

These twelve operator operations are also available through
`@kontourai/station-sdk/client`, `station schedule`, and station-control MCP.
The SSE event stream and inbound webhook are deliberately HTTP-only transport
surfaces.

---

### Open File with System Handler
```http
POST /scheduler/open
```

Opens a file using the OS default application (`open` on macOS, `xdg-open` on Linux, `start` on Windows).

**Request Body**:
```json
{ "path": "/path/to/file.log" }
```

**Response**:
```json
{ "success": true }
```

---

## System

> **New section** — routes from `src-server/routes/system/system.ts`

### Get System Status
```http
GET /system/status
```

Fast readiness check: resolves AWS credentials, checks ACP connections, detects installed CLIs, and aggregates onboarding prerequisites from all registered providers.

**Response**:
```json
{
  "prerequisites": [
    { "id": "aws-sso", "label": "AWS SSO Login", "met": true, "source": "my-plugin" }
  ],
  "bedrock": {
    "credentialsFound": true,
    "verified": null,
    "region": "us-east-1"
  },
  "acp": {
    "connected": true,
    "connections": [{ "id": "acp-1", "status": "connected" }]
  },
  "clis": {
    "kiro-cli": true,
    "claude": false
  },
  "externalEngines": [
    {
      "engineId": "codex",
      "engineConnectionId": "codex",
      "name": "Codex",
      "detected": true,
      "ready": true,
      "source": "codex-cli"
    }
  ],
  "ready": true
}
```

`engineId` selects engine capability truth. `engineConnectionId` is the
separate public Agent Apps identity used for navigation; clients must not
derive either value from the other or from the Adapter-private runtime ID.

---

### Verify Bedrock Credentials
```http
POST /system/verify-bedrock
```

Heavier check — actually calls `ListFoundationModels` to confirm credentials work.

**Request Body** (optional):
```json
{ "region": "us-west-2" }
```

**Response**:
```json
{ "verified": true, "region": "us-east-1" }
```

**Error**:
```json
{ "verified": false, "error": "UnrecognizedClientException: ..." }
```

---

### Check for Core App Update
```http
GET /system/core-update
```

Checks the app's git repository for upstream commits.

**Response**:
```json
{
  "currentHash": "abc1234",
  "remoteHash": "def5678",
  "branch": "main",
  "behind": 3,
  "ahead": 0,
  "updateAvailable": true
}
```

When no upstream is configured:
```json
{ "currentHash": "abc1234", "branch": "main", "behind": 0, "ahead": 0, "updateAvailable": false, "noUpstream": true }
```

---

### Apply Core App Update
```http
POST /system/core-update
```

Runs `git pull --ff-only` on the app repository and emits a `core:updated` event.

**Response**:
```json
{ "success": true, "hash": "def5678", "message": "Updated to def5678. Restart to apply." }
```

---

### Get Server Capabilities
```http
GET /system/capabilities
```

Returns the server's runtime and available voice/context provider capabilities.

**Response**:
```json
{
  "runtime": "voltagent",
  "voice": {
    "stt": [
      { "id": "webspeech", "name": "WebSpeech (Browser)", "clientOnly": true, "visibleOn": ["all"], "configured": true }
    ],
    "tts": [
      { "id": "webspeech", "name": "WebSpeech (Browser)", "clientOnly": true, "visibleOn": ["all"], "configured": true }
    ]
  },
  "context": {
    "providers": [
      { "id": "geolocation", "name": "Geolocation", "visibleOn": ["mobile"] },
      { "id": "timezone", "name": "Timezone", "visibleOn": ["all"] }
    ]
  },
  "scheduler": true
}
```

---

### Discovery Beacon
```http
GET /system/discover
```

Open-CORS endpoint that LAN clients can probe to detect a Station server without credentials.

**Response** (CORS: `*`):
```json
{
  "station": true,
  "name": "Project Station",
  "port": 3141
}
```

---

## Global Routes

### Global Invoke (No Agent Context)
```http
POST /invoke
```

Lightweight multi-turn invocation without a named agent. Supports tool calling and structured output.

**Request Body**:
```json
{
  "prompt": "What is 2+2?",
  "schema": { "type": "object", "properties": { "answer": { "type": "number" } } },
  "tools": ["calculator"],
  "maxSteps": 5,
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0"
}
```

**Response**:
```json
{
  "success": true,
  "response": "4"
}
```

---

### Tool Approval Response
```http
POST /tool-approval/:approvalId
```

Approve or reject a pending tool call.

**Request Body**:
```json
{
  "approved": true
}
```

**Response**:
```json
{
  "success": true
}
```

**Used by**: `useToolApproval.ts`, `ToolApprovalHandler.ts`

---

### Global Conversation Lookup
```http
GET /api/conversations/:id
```

Looks up a conversation by ID across all agents and projects.

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "conv-123",
    "agentSlug": "my-agent",
    "title": "Conversation Title"
  }
}
```

---

## Additional System Routes

### Get Runtime Info
```http
GET /api/system/runtime
```

Returns the current runtime type.

**Response**:
```json
{ "runtime": "voltagent" }
```

---

### List Skills
```http
GET /api/system/skills
```

Returns available skills.

---

### Get Terminal Port
```http
GET /api/system/terminal-port
```

Returns the terminal WebSocket port.

---

### Get Voice Port
```http
GET /api/system/voice-port
```

Returns the Voice WebSocket port (mirrors `/api/system/terminal-port`; see
`docs/reference/cli.md#accessing-station-remotely-198`).

---

## UI Commands

### Dispatch UI Command
```http
POST /api/ui
```

Dispatches a command to the frontend via the event bus.

**Request Body**:
```json
{
  "command": "navigate",
  "payload": { "path": "/settings" }
}
```

**Response** (delivered — personal-mode deployment):
```json
{ "success": true }
```

Delivery is best-effort even on success: `{success: true}` means the command
was accepted and broadcast, not that a connected client received it — with no
client listening, this is still `true`.

**Response** (refused — hosted multi-tenant deployment, 403): `navigate`
carries no destination identity to route it to one tenant's connections, so a
hosted deployment refuses the command outright rather than broadcasting it to
every tenant.
```json
{
  "success": false,
  "error": "Navigation commands are not delivered in hosted multi-tenant mode: /events has no destination identity to route ui:navigate to one tenant's connections, so it is denied rather than broadcast to every tenant."
}
```

**Response** (invalid path, 400):
```json
{ "success": false, "error": "Invalid navigation path" }
```

---

## Additional Analytics

### Clear Usage Data
```http
DELETE /api/analytics/usage
```

Clears all usage analytics data.

**Response**:
```json
{
  "data": {},
  "message": "Usage data cleared"
}
```

**Used by**: `UsageStatsPanel.tsx`

---

## Independent Review Evidence

Independent review runs one to eight selected reviewer Agents over an exact Git range. The server resolves both revisions to commit SHAs, resolves host-authoritative actor identities, provisions a detached read-only workspace, validates each finding against the reviewed head, and returns a durable request status. Reviewer findings are evidence input only: the completed receipt never represents approval, rejection, pass, fail, or gate completion.

```http
POST /api/projects/:projectSlug/reviews
Content-Type: application/json

{
  "requestId": "018f4d95-7c1a-7c4d-a3f4-62d53ed0d1b8",
  "mode": "initial",
  "target": {
    "kind": "git-range",
    "projectSlug": "station",
    "baseRevision": "origin/main",
    "headRevision": "HEAD"
  },
  "implementerAgentSlug": "terra",
  "reviewers": [{
    "reviewerId": "reviewer-1",
    "executorAgentSlug": "sol",
    "lens": {
      "id": "failure-totality",
      "instructions": "Review durable effects and exact outcomes."
    }
  }]
}
```

The caller-generated `requestId` is the durable idempotency key. `201` returns a completed status whose `result` contains `{receipt, attachment, cleanup}`; `202` returns the same request in `running` state. Rejected and indeterminate statuses are durable and never authorize automatic retry. `attachment` reports whether optional Flow evidence was attached; `cleanup` truthfully reports completed, retained, or unavailable workspace cleanup. The canonical SDK bounds each HTTP request to 30 seconds, recovers an ambiguous submission through the status endpoint, and polls until terminal; an explicit caller deadline or AbortSignal still wins.

Delta mode adds `delta: {priorReceiptId, claimedFindingIds}` and requires every claimed prior finding to be assessed exactly once. Read operations are:

```http
GET /api/projects/:projectSlug/reviews
GET /api/projects/:projectSlug/reviews/requests/:requestId
GET /api/projects/:projectSlug/reviews/:receiptId
GET /api/review-evidence
```

Receipts and request outcomes are immutable protected evidence. Station never silently evicts them; Project admission fails at the configured protected-capacity bound. Aggregate inventory uses bounded receipt references and returns only the newest 512 receipts.

## Architecture Notes

### Custom Endpoint Registration

Custom endpoints are registered via `configureApp` callback in `honoServer()`:

```typescript
server: honoServer({
  port: this.port,
  configureApp: (app) => {
    // Custom routes registered here
    app.get('/api/agents', async (c) => { /* ... */ });
    app.post('/agents', async (c) => { /* ... */ });
  }
})
```

### Authentication

When authentication is configured, custom routes inherit the same authentication behavior as the core runtime. See your auth provider documentation for details.

### CORS

CORS is configured to allow localhost origins and any origins specified in `ALLOWED_ORIGINS` environment variable:

```typescript
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (origin.startsWith('http://localhost:') || origin.startsWith('https://localhost:')) {
      return origin;
    }
    const allowed = process.env.ALLOWED_ORIGINS?.split(',') || [];
    return allowed.includes(origin) ? origin : null;
  },
  credentials: true,
}));
```

---
