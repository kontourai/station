# Station API Documentation

This reference explains selected HTTP route families and their current owners.
It is not a complete endpoint inventory. Request examples use illustrative IDs;
replace them with identities returned by the selected Station. Response excerpts
show relevant fields rather than every optional field.

**Base URL**: the selected Station's server origin. The CLI resolves an
unbootstrapped Stable loopback target to `http://localhost:18141` through the
shared runtime context; development/bootstrap ports are explicit, not fallback
documentation. Prefer the endpoint from `station target` instead of assuming a
channel or port. Protected routes
require a supported credential and the route's authority checks; loopback is not
an authentication bypass. Paired devices, application sessions, and internal
server requests have different authority paths.

**Endpoint authority**: See [endpoints.md](./endpoints.md) for OpenAPI and auth
authorities. The [runtime composition](../../src-server/runtime/routes/runtime-routes.ts)
mounts handlers and their request boundaries. A handler existing in source does
not mean every deployment mounts or admits it.

## Endpoint Legend

- Method and path identify the route, not its permission tier.
- HTTP success can mean persisted or accepted while activation remains pending.
- Readiness, health, catalog discovery, and a completed model turn are distinct
  observations. Response fields and receipts state which one was observed.

## Table of Contents

- [Agent Management](#agent-management)
- [Integration Management](#integration-management)
- [Layout Management](#layout-management)
- [Workflow Management](#workflow-management)
- [Conversation Management](#conversation-management)
- [Configuration](#configuration)
- [Connections](#connections)
- [Fleet Inference](#fleet-inference)
- [Bedrock Models](#bedrock-models)
- [Analytics](#analytics)
- [Monitoring](#monitoring)
- [Agent Invocation](#agent-invocation)
- [Auth & Users](#auth--users)
- [Branding](#branding)
- [Events (SSE)](#events-sse)
- [File System](#file-system)
- [Insights](#insights)
- [Standalone Model Capability Routes](#standalone-model-capability-routes)
- [Plugins](#plugins)
- [Registry](#registry)
- [Scheduler](#scheduler)
- [System](#system)
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
`/projects/<slug>/layouts/review?receipt=...` link — the Project's own Review
layout, which #2065 made the home of review evidence when the global
`/review-queue` was retired. A stored `/review-queue?receipt=...&project=...`
link still resolves: it redirects to that same layout with the receipt
selected, and one carrying no `project` goes to `/notifications` rather than
guessing a Project. Observation re-reads the owner every
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

### Custom Chat Stream

```http
POST /api/agents/:slug/chat
```

The [chat handler](../../src-server/routes/chat/chat.ts) is Station's managed
chat stream, with tool approval and elicitation handling. The current chat dock
primarily enters through [orchestration](#orchestration-model-launch-behavior),
which owns durable Sessions and engine selection. Do not substitute this route
for the orchestration lifecycle merely because both stream text.

```json
{
  "input": "Summarize this project.",
  "options": { "conversationId": "existing-conversation-id" }
}
```

`input` can also carry the supported chat-message array. Options and principal
handling are prepared by
[chat-request-preparation](../../src-server/routes/chat/chat-request-preparation.ts).
A supplied `userId` is not authentication. Explicit model overrides are resolved
through the selected provider/catalog; absent or unknown selector evidence does
not create an arbitrary model binding. The response is SSE; failures before
stream creation use HTTP errors, while failures during a stream must be handled
as stream outcomes.

<a id="agent-management-1"></a>

### Default Agent

The public built-in Agent ID is **`station`**. `default` remains a private
Station-engine map key; use public identities returned by `/api/agents`.
The built-in Agent can be bound to an external engine, or run on Station's own
engine with a resolvable Model connection and model. A model-less Station still
starts its configuration and connection surfaces; that does not prove the
Station-engine Agent is launchable.

The [default-Agent builder](../../src-server/runtime/agents/runtime-default-agent.ts)
loads `station-control` and `station-docs` on the Station-engine path, installs
approval hooks and memory, and processes the configured system prompt. This is
not a tool-free text helper. Delivery to an external engine depends on that
engine's supported delivery mechanisms. The catalog projection is separate
from proof that a particular engine received its tools.

For a named one-shot invocation, use an available Agent such as
`POST /agents/station/invoke`; see [Agent Invocation](#agent-invocation) for its
limits. The global `/invoke` path is described separately below.

---

### List All Agents (Enriched)
```http
GET /api/agents
```

The [enriched catalog](../../src-server/routes/agents/enriched-agents.ts) merges
persisted definitions, registry defaults, and runtime observations. Rows can
include execution binding, availability/validation findings, and activation
failures; inclusion in the list is not proof that a chat can launch. The example
below is a field excerpt, not a fixed response for every Agent.


**Response**:
```json
{
  "success": true,
  "data": [
    {
      "slug": "my-agent",
      "name": "My Agent",
      "prompt": "System instructions...",
      "description": "Agent description",
      "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "region": "us-east-1",
      "guardrails": {
        "maxTokens": 4096,
        "temperature": 0.7
      },
      "maxSteps": 10,
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


---

### Create Agent
```http
POST /agents
```

The [Agent routes](../../src-server/routes/agents/agents.ts) validate the body,
persist the definition through AgentService, and queue runtime reconciliation.
Creation can succeed with a non-blocking availability warning. Raising the
default approval posture to full access requires its separate authority.
See [configuration](config.md#agentjson) for admitted file fields.

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
    "name": "My Agent"
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


---

### Update Agent
```http
PUT /agents/:slug
```

**Request Body**: Partial agent configuration (same structure as create)

**Response**:
```jsonc
{
  "success": true,
  "data": { /* updated agent */ }
}
```

Updates use the same HTTP `202` `configurationActivation` receipt described
under Create Agent when persistence completes before runtime activation.


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

**Example refusal** (a definition still referenced by a layout cannot be deleted):
```json
{
  "success": false,
  "error": "Cannot delete agent 'my-agent' - it is referenced by layouts: my-layout"
}
```


---

### Get Agent Health

This [handler](../../src-server/routes/agents/agent-tools.ts) inspects Station’s
active Agent/model/memory and recorded MCP status. It does not run a fresh
provider turn. An external engine can be usable through orchestration without
appearing in this active-Agent map. Missing identities return 404; known inactive
ones return 409; pending activation returns 503.

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


---

## Integration Management

These routes manage MCP integration definitions through the
[MCP service](../../src-server/services/plugins/mcp-service.ts) and
[tool routes](../../src-server/routes/agents/tools.ts). A saved definition,
a successful probe, and tool availability on an Agent are separate states.

### List All Integrations

`GET /integrations` returns `{success: true, data}`. Rows are integration metadata
augmented with `builtin`, `usedBy`, recorded `connected` status, known tool
names/descriptions, and `renderAllowed`. This is not a complete raw definition
or proof that every listed tool can currently execute.

### Create Integration

`POST /integrations` accepts the integration definition schema and returns
`{success: true}`. The handler saves the definition disabled; creation does not
automatically connect or enable it. Submitted `env` values enter the service's
secret-environment write path instead of being echoed as ordinary read data.

### Get Integration

`GET /integrations/:id` returns `{success: true, data: definition}` through the
read projection. It withholds raw `env`, `secretEnv`, and credential-binding
values; clients use the returned metadata when editing. A failed lookup returns
404 from this handler.

### Update Integration

`PUT /integrations/:id` accepts a partial definition and returns
`{success: true}`. Environment updates are merged by key: omission preserves
stored values, `{env: {}}` clears nothing, and removal uses
`removeSecretEnvKeys`. Package-supplied definitions are read-only; the MCP
service refuses changes that would create a shadow copy.

### Delete Integration

`DELETE /integrations/:id` returns `{success: true}` after deletion.
Runtime-managed built-ins such as `station-control` and `station-docs` return
409 because startup recreates them. Package-supplied definitions must be
removed through their owning package instead.

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

The [tool-catalog handler](../../src-server/routes/agents/agent-tools.ts) returns
404 for an unknown Agent, 409 for a known inactive/failed Agent, and 503 with
`Retry-After: 1` while activation is pending. A persisted external-engine Agent
returns an empty Station-tool catalog; its external engine owns its tool loop.
Tool add/remove/allow-list writes can carry the same 202 activation receipt as
Agent writes. An empty `available` list filters out all loaded tools; omit it or
use `["*"]` to include all loaded tools.

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

## Personal Boards

A **Board** is a Layout owned by a principal rather than a project
(`docs/design/shell-ownership-and-boards.md`, decision D1). Boards are stored
under the Station home keyed by principal, so the same Boards are served to
every device that resolves to the same principal — a device identified by
Tailscale WhoIs, or a paired device bound to a person. A bare paired device
with no person binding resolves to a per-device principal instead and sees
its own Boards; see `docs/design/principals.md` for how a request is placed.

A caller the resolver cannot place at all is refused with `400` and
`code: "principal_unresolved"` — a deterministic authorization failure, not a
transient one, so retrying the same request with the same credential fails
the same way.

The owning principal is resolved from the request's own authentication. No
path segment, body field, or query parameter names it, and a body that carries
an `owner` is refused with 400 rather than accepted and stripped. A slug
another principal owns answers exactly like a slug nobody owns — the same 404
status and the same body — so the response cannot be used to discover whether
someone else has a Board by that name.

### List My Boards
```http
GET /api/me/layouts
```

### Create a Board
```http
POST /api/me/layouts
Content-Type: application/json

{
  "slug": "daily-brief",
  "name": "Daily brief",
  "type": "custom",
  "icon": "star",
  "description": "Morning view",
  "config": {}
}
```

`slug` must be unique among the caller's own Boards; a repeat answers 409.

### Get a Board
```http
GET /api/me/layouts/:layoutSlug
```

The response may carry `paneReferences` (#2090), a response-only verdict
naming the Board's own tabs that cannot be shown to this caller:

```json
{ "paneReferences": { "unavailableTabIds": ["notes"] } }
```

It is present only when something really is withheld, it carries no reason,
no source and no action, and it is never stored. A Board tab reaches the same
renderer a project Layout's does, so a tab naming a component from a plugin
this person cannot see would otherwise render "…is not installed or
registered" — a cause the server never derived. Unlike the project layout
read, this route withholds nothing else: it performs no live plugin read and
no catalog backfill, and a Board's `config.plugin` is the caller's own input
into their own record.

### Update a Board
```http
PUT /api/me/layouts/:layoutSlug
Content-Type: application/json

{ "name": "Renamed" }
```

Fields the body omits are left as stored. `id`, `slug`, `createdAt`, and the
owner are immutable. The read and the write happen inside one per-record
transaction, so two concurrent updates cannot lose one another's change.

This body is otherwise strict — an unrecognized key is refused rather than
quietly dropped — with one exception: `paneReferences` is ACCEPTED and
discarded, so that reading a Board and writing it back is not a 400 against a
field this route itself attached. It never reaches storage. The response
carries the same verdict the read does.

### Delete a Board
```http
DELETE /api/me/layouts/:layoutSlug
```

### Promote a Board into a project
```http
POST /api/me/layouts/:layoutSlug/promote
Content-Type: application/json

{ "projectSlug": "campfit" }
```

A **move**, not a copy: on success the personal record is gone and the project
owns the Layout under the same slug, keeping the Board's `id` and `createdAt`
verbatim. Carrying the same id IS the lineage — there is no `promotedFrom`
field, because layout ids are a record field rather than a directory key and
nothing else records the move.

`projectSlug` is the only field the body may name; anything else is 400. A
project that does not exist answers 404 `Project not found` — the project
routes' own answer, given before the personal record is touched, so a promote
that cannot land never destroys the Board. A slug the project already uses for
a different Layout answers 409 and moves nothing.

A Board the destination project would not accept is refused before anything
moves. Promote runs the same admission `POST /api/projects/:slug/layouts`
runs — the same function, not a second copy of its rules — so a layout naming
an agent the project cannot reach answers 400 with that route's diagnostics,
and a `coding` Board carrying its own `config.workingDirectory` is refused by
name (that value is derived from the project). A promoted `coding` Board
therefore persists no `workingDirectory` of its own.

Promote grants no capability that `POST /api/projects/:slug/layouts` does not:
it publishes through the same project transaction, and both carry the same
`orchestration:operate` pairing scope. Read that as a statement about WHO may
call, which is a different question from what a call may contain — the
admission above is the second one, and the two are enforced separately.
Station applies no per-project membership check to layout writes today
(`docs/design/project-membership.md` specifies that contract and does not claim
it is implemented), so promote does not claim one either.

The two writes are ordered create-then-delete, which accepts a visible
duplicate over a possible loss: if the process dies between them, the Layout is
in the project AND still listed personally. Repeating the promote closes it —
the second call sees the project occupant carrying this Board's own id,
recognizes the interrupted run, and completes the delete.

**Used by**: the Boards section of the left panel (#2062)

---

## Workflow Management

These routes manage retained Agent workflow **files**. Saving source does not
execute it or create a Task/Flow run. The [route mapper](../../src-server/routes/projects/layouts.ts)
calls [LayoutService](../../src-server/services/projects/layout-service.ts),
which delegates to the Agent file store.

### List Agent Workflows

`GET /agents/:slug/workflows/files` returns `{success: true, data: workflows}`.
The rows are file metadata, not completed execution receipts.

### Get Workflow Content

`GET /agents/:slug/workflows/:workflowId` returns
`{success: true, data: {content}}` after the stored-content safety check.

### Create Workflow

```http
POST /agents/:slug/workflows
```

```json
{
  "filename": "example.ts",
  "content": "export default async function example() { return 'Hello'; }"
}
```

A successful creation returns 201 with `{success: true, data: {filename}}`.
The example is stored source; this request does not verify a runtime workflow
contract or invoke its function.

### Update Workflow

`PUT /agents/:slug/workflows/:workflowId` accepts `{content: "..."}` and returns
`{success: true}` after saving it.

### Delete Workflow

`DELETE /agents/:slug/workflows/:workflowId` returns `{success: true}` on deletion.

The typed refusal mapper distinguishes missing files (404), existing files on
create (409), invalid input (400), and unsafe stored content on read (422).
Unexpected storage failures reach the runtime's correlated generic 500 boundary;
they are not all reported as bad requests.

---

## Conversation Management

The [conversation routes](../../src-server/routes/chat/conversations.ts) combine
personal file-memory history with authorized orchestration history. They do not
make those storage models interchangeable. Reads use request-bound authority;
file-memory title/context/deletion operations remain unavailable in hosted mode.

### List Agent Conversations

```http
GET /agents/:slug/conversations?limit=100
```

```json
{ "success": true, "data": { "items": [], "hasMore": false } }
```

`limit` is an integer from 1–100, default 100. Hosted reads may return
`nextCursor`; the personal compatibility page rejects a supplied cursor.
The route merges file-memory and orchestration rows by ID, sorts by recency,
and returns a bounded page. `data` is a page object, not the old bare array.
Respect `hasMore` rather than assuming one response contains the entire history.

### Get Conversation Messages

`GET /agents/:slug/conversations/:conversationId/messages` returns
`{success: true, data: messages}`. The reader can restore authorized messages
from orchestration when the file-memory path has no usable record. Messages
carry the owner's current parts/metadata shape; do not depend on every message
having the old `content: string`/`timestamp` pair.

### Update Conversation

`PATCH /agents/:slug/conversations/:conversationId` accepts the supported
conversation update, such as `{title: "New title"}`, and returns
`{success: true, data: updated}`. This is the file-memory update path.
Orchestration-owned titles return 409 here; hosted requests and missing records
are refused. Use the orchestration operation for its owned history.

### Delete Conversation

`DELETE /agents/:slug/conversations/:conversationId` returns `{success: true}`
after deleting file-memory history and its derived summary. Orchestration
history is read-only through this path (409), and hosted requests return 404.
A caller-scoped station-control deletion additionally checks the stored owner.
This is not a general endpoint for deleting any Session visible in a list.

### Manage Conversation Context

```http
POST /agents/:slug/conversations/:conversationId/context
```

```json
{ "action": "add-system-message", "content": "User switched to dark mode" }
```

The [context owner](../../src-server/runtime/conversation/conversation-manager.ts)
implements two actions. `add-system-message` requires content and stores a
**user-role** message prefixed with `[SYSTEM_EVENT]`; the name does not make it
a privileged model system instruction. `clear-history` clears the file-memory
messages. Success returns `{success: true, message}`. Unknown actions or a
missing adapter throw through this route's error handler. Hosted mode refuses
these file-memory mutations before invoking the owner.

### Get Conversation Statistics

`GET /agents/:slug/conversations/:conversationId/stats` returns
`{success: true, data: stats}` after the shared stats parser. The owner uses
file-memory stats or authorized orchestration usage when available. Prompt/tool
estimates, reported tokens, cost, and observed model/context values are distinct
inputs; missing provider observations are not measurements of zero.

`contextWindowPercentage` is absent when the model's context window cannot be
resolved. Render that as unavailable. See the
[stats owner](../../src-server/runtime/conversation/conversation-manager.ts)
and [response contract](../../packages/contracts/src/runtime.ts).

---

## Configuration

### Get App Configuration

`GET /config/app` returns `{success: true, data, provenance}`. `data` is the
public app-config projection with applicable runtime-derived fields; it is not
a raw file dump. `?project=<slug>` adds Project provenance, while the values
remain this Station's config. It does not automatically return fully composed
Project-effective settings. Invalid/missing Project selections return 400/404.

### Update App Configuration

```http
PUT /config/app
```

```json
{ "defaultMaxOutputTokens": 8192 }
```

The [route](../../src-server/routes/system/config.ts) applies the settings
sanitizer and serialized config mutation. The response contains the public
updated `data`, optional `ignoredKeys`, and an activation receipt when relevant.
Ordinary success is 200; persisted changes awaiting activation can return 202.
A field being present in `AppConfig` does not mean this generic endpoint may
write it: first-run decisions and revisioned log-level changes have separate
routes, and contribution/full-access choices have additional checks.
See [config reference](config.md) for effective defaults and consumer limits.

---

## Connections

The [connection routes](../../src-server/routes/connections/connections.ts)
call [ConnectionService](../../src-server/services/connections/connection-service.ts).
Model connections configure inference providers. Agent App connections identify
engines that run Agent loops. A connection ID and its `config.engineId` are
separate identities.

### List All Connections

`GET /api/connections` returns `{success: true, data: connections}` with connection
secrets redacted. Current Agent App rows use `kind: "agent"`; `runtime` is retained
as a write-schema compatibility spelling, not the current row kind.

### List Model Connections

`GET /api/connections/models` returns `{success: true, data, failures}`. A row
that fails discovery is represented in `failures`; an empty `data` array alone
does not establish that no Model connections exist. Provider-reported
`config.modelOptions` is a discovery projection, not editable connection config.

<a id="list-runtime-connections"></a>

### List Agent App Connections

`GET /api/connections/agents` returns `{success: true, data, failures}`. The old
`/api/connections/runtimes` spelling is not registered here.
`GET /api/connections/agents/catalog` returns the Agent App catalog separately.

Rows can include `runtimeCatalog` model observations and readiness evidence.
A cached catalog, built-in selector, prerequisite check, and successful smoke
are different facts. Preserve the returned source/freshness/completeness fields;
do not label every listed selector as a model that completed a turn.
The [SDK connection query](../../packages/sdk/src/query-domains/workspaceConnections.ts)
is a current consumer.

### List Launchable Model Inventory

```http
GET /api/connections/model-inventory
```

This compatibility route returns `{success: true, data: manifest}`, where
`manifest` is the bounded **contributed** `station.fleet-contribution/v1`
projection. It requires `inference:invoke`. It does not expose the complete
`station.model-inventory/v2` value.

[ConnectionService](../../src-server/services/connections/connection-service.ts)
still builds the complete inventory in-process for model resolution and the
contribution projection. Its [inventory owner](../../src-server/services/connections/launchable-model-inventory.ts)
contains the selector, completeness, freshness, and output-budget rules. The
HTTP boundary intentionally returns only the contributed subset. See
[the fleet manifest](#read-the-contributed-model-manifest); that route wraps the
same projection as `{manifest}`, so the two response envelopes differ.

The current SDK names are `fetchContributedModelManifest` and
`useContributedModelManifestQuery`. The old launchable-inventory exports are
not compatibility aliases.

### Get One Connection

`GET /api/connections/:id` returns `{success: true, data: connection}` or 404 for
an unknown connection. This read uses the same connection projection and
secret-redaction path as the merged list.

### Save a Connection

```http
POST /api/connections
PUT /api/connections/:id
```

These accept the [connection write schema](../../src-server/routes/schemas/schema-definitions/runtime.ts):
`kind`, `type`, `name`, `config`, `enabled`, and `capabilities` are required even
for PUT. PUT is not a generic partial patch. POST supplies an ID when omitted;
PUT uses the path ID. Model discovery fields such as `config.modelOptions` are
not persisted as operator choices. For an Agent App, the service resolves an
existing engine identity and saves supported overrides; posting an arbitrary
kind/name does not invent a new engine adapter.

Creation normally returns 201, update 200, with `{success: true, data}`. A saved
configuration awaiting runtime activation returns 202 and
`configurationActivation`, as with Agent writes. The returned definition is
redacted. Invalid saves return a structured 400 response.

### Delete or Reset a Connection

`DELETE /api/connections/:id` deletes a Model connection. For an Agent App it
removes saved overrides and unregisters the engine connection from the Agent
registry. This does not uninstall the engine executable. A pending runtime
reconciliation can return 202 with `configurationActivation`.

### Test a Connection

`POST /api/connections/:id/test` returns `{success: true, data}` with
`healthy`, `status`, `prerequisites`, and optional `reason`/`checkedAt`.
This is a readiness/health check, not the separate bounded-turn smoke at
`POST /api/connections/:id/smoke`. A false `healthy` value remains a successful
HTTP response describing an unsuccessful check. Unknown connections return 404;
other thrown check failures return 400.

---

## Fleet Inference

The [serving routes](../../src-server/routes/inference/fleet-inference.ts) let an
authorized peer read contributed models and request token generation. The
consumer keeps its Agent loop, tools, workspace, and Session; the serving route
does not create a Session or accept tool/workspace inputs. This differs from
`delegate_task`, which starts work on the receiving Station. The serving
Station separately attempts to record a local serve receipt.

The route-family pairing scope is `inference:invoke`; ordinary authentication,
origin, and applicable request-authority checks still apply. The `inference`
preset grants this scope; Standard, Delegation, Read-only, and the historical
default grant do not. A direct loopback or SSH-forwarded request still needs a
supported credential. See [scope definitions](../../packages/contracts/src/environment-security.ts)
and [route mapping](../../src-server/security/pairing-route-scopes.ts).

The [contract limits](../../packages/contracts/src/fleet-inference.ts) are:

| Input/output | Limit |
| --- | --- |
| Request body | 128 KiB, checked while reading the stream |
| Messages | 64 |
| Total prompt text | 96,000 JavaScript string code units |
| Output tokens | 4,096 (also the default) |
| Returned generated text | 64,000 JavaScript string code units |
| Concurrent completions | 2 |
| Completion abort deadline | 120 seconds after generation admission |

The deadline and caller disconnect signal are **cooperative**. The
[service](../../src-server/services/inference/fleet-inference-service.ts) releases
a concurrency slot only when the provider iteration settles and its `finally`
runs. An adapter that ignores abort can hold its slot beyond the deadline.
The response-text ceiling stops accumulation but continues draining for terminal
usage/finish data under the same cooperative bound.

The handler's domain refusals use `{refusal: {schemaVersion, code, message,
participation?, refusedAt}}`. Earlier authentication/origin/scope middleware can
return its own error envelope. A model not contributed and a nonexistent model
receive the same contribution refusal.

| Code | HTTP status |
| --- | --- |
| `contribution-disabled`, `model-not-contributed` | 403 |
| `model-unavailable`, `contribution-unavailable` | 503 |
| `streaming-unsupported`, `request-invalid` | 400 |
| `request-too-large` | 413 |
| `capacity-exhausted` | 429 |
| `completion-timeout` | 504 |
| `request-abandoned` | 499 (recorded outcome after disconnect) |
| `execution-failed` | 502 |

### Read The Contributed Model Manifest

```http
GET /api/inference/manifest
```

Returns `{manifest}` containing the bounded `station.fleet-contribution/v1`
projection. `/api/connections/model-inventory` returns the same projection under
`{success: true, data}`, with the same pairing tier.

`participation` distinguishes `contributing`, `disabled`, `nothing-contributed`,
and `contributed-unavailable`; an empty `models` array alone cannot distinguish
them. The boundary carries at most 128 models and 64 diagnostics, adding an
`inventory-truncated` diagnostic when it trims a list. Diagnostic messages are
bounded to 240 string code units. `projectedAt` dates the projection;
`sourceObservedAt` and each model's `observedAt` date its evidence. A new
projection does not make old evidence fresh.

The public handshake's `fleetInference` capability describes protocol support,
not current participation. Read the authorized manifest to learn what this
Station currently contributes.

### Serve A Completion

```http
POST /api/inference/completions
```

```json
{
  "model": "exact-manifest-model-id",
  "messages": [{ "role": "user", "content": "Summarize this changelog: ..." }],
  "maxOutputTokens": 512,
  "temperature": 0.2
}
```

Use the manifest's exact model `id`, not a provider selector or alias. Roles are
`system`, `user`, or `assistant`; content is text. `maxOutputTokens` must be a
positive integer within the ceiling; it is refused rather than clamped above
it. Temperature, when present, must be finite and within 0–2. `stream: true`
returns `streaming-unsupported`; current delivery is buffered.

The response is `{completion}` with schema version, `delivery: "buffered"`,
model identity, `servedAt`, text `content`, `stop`, `finishReason`, `usage`, and
`elapsedMs`. `stop: "response-bound"` means Station truncated accumulated text;
`provider` means the provider ended without that truncation. `finishReason` is
separate provider output. `usage` is null unless both input and output token
figures were reported; null does not mean zero.

A serve-receipt append failure is logged and counted, but does not replace the
completion response. Successful delivery therefore does not prove the local
receipt was durably written. Receipt reading and diagnosis are separate from
completion execution.

### Who May Turn Contribution On

`PUT /config/app` writes `fleetContribution` under its normal
`orchestration:operate` tier. In addition, the
[config handler](../../src-server/routes/system/config.ts) refuses a caller
whose granted scope includes `inference:invoke` when it writes either
`fleetContribution` or the separate `contribution` map. This covers changing
connection IDs as well as enabling contribution.

An operate-only credential is not refused by that beneficiary check. The
separate Project `contribution` map also has an operator-authority check for
changed offers. Neither rule creates a credential-less loopback exception;
normal request authentication runs first. See the
[inference design](../design/inference-fleet.md) for the authority decision.

---

## Orchestration model launch behavior

`POST /api/orchestration/chat` carries model selection under
`target.model: {override?, options?}`, alongside the Agent and Environment target.
The [route schema](../../src-server/routes/orchestration/orchestration.ts),
[capability planner](../../packages/contracts/src/provider.ts), and
[model-launch owner](../../src-server/services/orchestration/model-launch-planning.ts)
separate requested selection from adapter acceptance.

A plan is `station-resolved`, `engine-selected`, or `unavailable`.
Station-resolved selectors begin as `catalog-pending`; the adapter marks them
`catalog-accepted` only after validation. An adapter without a model-launch
declaration can accept omission as `capability-absent`, but cannot thereby
claim explicit override support. The orchestration start path checks its plan
before readiness/discovery; actual selector validation remains adapter-owned.

`POST /api/orchestration/chat/:conversationId/continue` keeps the persisted
Agent, Environment, and workspace binding. It accepts an optional **object**
`model: {override?, options?}` for the next turn; legacy scalar model values are
ignored by this schema. The
[continuation caller](../../src-server/tools/station-control-delegation.ts)
rebuilds the target from the authorized conversation binding and forwards that
model choice. Whether it can apply to an existing Session or requires another
lifecycle boundary depends on the engine. Unsupported lifecycle overrides have
the typed `model-override-unsupported` refusal; this is not permission to invent
an applied model after an unsuccessful request.

The [session projection](../../src-server/services/orchestration/orchestration-session-state.ts)
keeps `requestedModel`, `appliedModel`, and independently reported model facts
separate. Old `session.configured.model` echoes alone are not apply receipts.
A later effective-model boundary also prevents an older reported model from
being presented as current.

Bedrock and Ollama declare catalog-validated start/resume/per-turn overrides.
ACP now supports a fresh-start override **when that Session advertises a model
configuration option and `setConfigOption` returns the requested current
value**. Its adapter records the verified selection then. ACP does not declare
new resume/per-turn override support; restating an already retained selector is
handled separately from requesting a different model. See the
[ACP apply boundary](../../src-server/providers/adapters/acp-adapter.ts),
[Bedrock adapter](../../src-server/providers/adapters/bedrock-adapter.ts), and
[Ollama adapter](../../src-server/providers/adapters/ollama-adapter.ts).

## Bedrock Models

The [Bedrock routes](../../src-server/routes/connections/bedrock.ts) use the
shared [model catalog](../../src-server/providers/llm/bedrock-models.ts).
Catalog discovery is evidence of a selector, not proof that an account can
complete inference on it.

### List Available Models

`GET /bedrock/models` returns `{success: true, data: models}`. It includes
streaming, text-output foundation models with `ON_DEMAND` support and active
inference profiles whose complete model-ARN set resolves to one such foundation
model. Ambiguous/unresolved profile relationships are omitted. Profile rows
carry their own selector/ARN/name plus `isInferenceProfile`, `profileType`, and
`status`; their capability fields come from the matched foundation model.

### Get Model Pricing

`GET /bedrock/pricing?region=us-east-1` returns `{success: true, data: prices}`,
where `prices` is an **array**, not a map keyed by model ID. Rows include
`modelId`, optional provider/input/output price values, `region`, and `feature`.
The catalog groups returned AWS price dimensions by model and feature. The
numeric fields copy the returned USD price-per-unit value; this parser does
not normalize its unit, so the field names alone are not proof of a per-token
or per-1,000-token rate.

The region falls back through stored app config, `AWS_REGION`, and `us-east-1`;
an invalid supplied region returns 400 before lookup. Missing catalog or lookup
failure returns 500. Model/profile/pricing caches expire after 15 minutes;
pricing uses a bounded regional cache and paginated reads. Route JSON output is
also size-bounded. The catalog source contains the exact budgets.

### Validate Model ID

`GET /bedrock/models/:modelId/validate` returns
`{success: true, data: {modelId, isValid}}`. It calls selector resolution: a base
ID with exactly one eligible profile can validate by resolving to that profile.
An ambiguous match does not validate. This is catalog validation, not an
inference smoke.

### Get Model Info

`GET /bedrock/models/:modelId` returns `{success: true, data: model}` for an
**exact selector in the projected list**, otherwise 404. Unlike validation, this
lookup does not substitute a profile for a base ID. Use a selector returned by
`GET /bedrock/models` for a predictable detail lookup.

---

## Analytics

The [analytics routes](../../src-server/routes/operations/analytics.ts) read
[UsageAggregator](../../src-server/analytics/usage-aggregator.ts). This retained
summary is separate from the monitoring event stream and from authoritative
per-invocation receipts. An unavailable aggregator returns a 500 error.

### Get Usage Statistics

`GET /api/analytics/usage` returns `{success: true, data: stats}` with lifetime,
Agent, model, and date aggregates. The date map is `byDate`, not `byDay`.
Optional `from`/`to` date strings filter `byDate` and add `rangeSummary`; other
fields retain their existing aggregate scope. Do not relabel those other fields
as totals for the selected window.

### Get Achievements

`GET /api/analytics/achievements` returns
`{success: true, data: achievements}` from the aggregator. The achievement
schema and unlock rules belong to that owner, not a fixed list in this page.

### Rescan Analytics

`POST /api/analytics/rescan` returns
`{success: true, data: stats, message: "Full rescan completed"}`. It scans
Agent file-memory transcripts and folds available orchestration usage, excluding
Session IDs already counted in file memory. It merges the rescan with retained
stats rather than resetting every lifetime counter to zero. An unavailable
orchestration source is not a measured empty source; inspect coverage metadata.

## Monitoring

These [routes](../../src-server/routes/operations/monitoring.ts) expose different
inputs: active-Agent maps, an in-memory metrics list, and persisted/live
monitoring events. They are not interchangeable measures of the whole Station.

### Get System Stats

`GET /monitoring/stats` returns `{success: true, data: {agents, summary}}`.
Rows come from the active managed-Agent map. `healthy` checks for a model and
memory adapter; it is not a fresh model completion. Personal mode can include
cached conversation/message counts. The legacy `cost`, `activeAgents`, and
`runningAgents` values here are currently zero placeholders, so they must not
be presented as measured spend or activity. Hosted mode omits the personal
history counts and cost fields.

### Get Historical Metrics

`GET /monitoring/metrics?range=today` groups the runtime's in-memory metrics by
Agent and returns `{success: true, data: {range, metrics}}`.
`today`, `week`, and `month` mean trailing 24 hours, 7 days, and 30 days;
`all` or an unrecognized value applies no start cutoff. This is not a query of
all durable history. Hosted mode returns an empty metrics list through this
legacy path.

### Get/Stream Events (SSE)

```http
GET /monitoring/events?start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z&limit=100
GET /monitoring/events
```

A nonempty `start` or `end` selects historical JSON:
`{success: true, data: events, truncated}`. Without a time bound, the route
opens SSE. Historical bounds accept epoch milliseconds or parseable date text;
send ISO 8601 for clarity. Unparseable supplied bounds return 400.

Historical filters are `agent`, `tool`, `engine`, `conversation`, and
`tools=true`. `limit` is optional and capped at 5,000; without it there is no
route-level result-count cap. Results are ordered by event timestamp, and a
limit selects the most recent matching rows. `truncated` reports actual drops.
These dimension/limit options are implemented in the historical branch, not
as live SSE subscription filters.

The user filter defaults to the resolved local user alias, with legacy `userId`
or `x-user-id` inputs where allowed. A principal-scoped station-control request
has a fixed owner and cannot replace it. Session/tenant visibility is also
filtered by the runtime-supplied authority. User-filter text is not a substitute
for those checks.

SSE sends GenAI monitoring records, including an initial record with
`station.system.type: "connected"` and a heartbeat every 30 seconds. It does
not use the old `{type: "message"}` event example. Content is redacted before
historical or streaming output. See the [monitoring guide](../guides/monitoring.md)
for event keys and producer limits.

---

## Agent Invocation

These [routes](../../src-server/routes/agents/invoke.ts) execute against Station's
active managed Agent map. An external-engine Agent being listed in the catalog
does not make it callable through this map; use orchestration for its lifecycle.
The [request schemas](../../src-server/routes/schemas/schema-definitions/runtime.ts)
distinguish `input` on named invoke from `prompt` on global/legacy stream invoke.

<a id="silent-invocation-no-memory"></a>

### Named Invocation

```http
POST /agents/:slug/invoke
```

```json
{ "input": "Summarize the supplied text: ...", "tools": [] }
```

Optional fields are `model`, `tools`, and `schema`. `silent` is not an admitted
control. The [owner](../../src-server/routes/agents/invoke-agent.ts) calls the
existing Agent's `generateText`; the route does not itself guarantee that the
Agent's memory implementation is disabled. A supplied tool list filters the
Agent's loaded tools by runtime name; it does not load a new integration.

The JSON response contains `success`, `response`, `usage`, `runId`, and any
returned steps/tool calls/tool results/reasoning. With `schema`, the route adds a
JSON instruction to the prompt and tries `JSON.parse` on the result. It does
not validate the parsed object against that schema; a parse failure leaves the
original text in `response`.

The durable native-invocation record is separate from a conversation transcript.
An indeterminate or partially completed invocation returns a coded 409 with run
identity; observe that run before retrying. Unavailable record storage returns
503. A 2xx response is not a claim that a caller's requested JSON shape was
validated.

### Raw Tool Call (No LLM)

```http
POST /agents/:slug/tools/:toolName
```

The body is the tool's arguments. The
[tool owner](../../src-server/routes/agents/invoke-agent.ts) resolves an existing
loaded tool, executes it under the captured runtime configuration, and returns
`{success: true, response, metadata: {toolDuration, totalDuration}}`. Durations
are rounded milliseconds. MCP text content may be JSON-decoded by the result
unwrapper. Tool errors, including station-control failure envelopes, are checked
before success is returned. Unknown Agent/tool identities return 404.

### Streaming Invocation

```http
POST /agents/:slug/invoke/stream
```

Despite the retained path name, this handler currently returns **buffered JSON,
not SSE**. Its body uses `prompt`, optional `model`, `tools`, `maxSteps`, and
`schema`:

```json
{ "prompt": "Summarize the supplied text: ...", "tools": [], "maxSteps": 5 }
```

With an explicit tools array, it builds a temporary Agent with the selected
loaded tools. With a schema on that branch, it asks for JSON and parses the
text; this is not JSON Schema validation. Without a tools array it calls the
existing Agent's `generateObject` or `generateText`. Both branches return
`{success: true, response, usage, runId}`. Schema behavior therefore depends on
the branch and framework, rather than a universal validated-output guarantee.
See [Custom Chat Stream](#custom-chat-stream) and orchestration for actual chat
streaming.

---

## Attachments

### Get Attachment Bytes
```http
GET /api/attachments/:ref
```

The bytes behind an attachment a transcript is showing, where `:ref` is the
`sha256-<64 hex>` content reference persisted on the turn's `attachments`
(station#3374/#3385). Authenticated at the `orchestration:read` pairing tier.

The response deliberately **does not name the image's type**: the store is
addressed by bytes alone and holds no MIME type, and two attachments with
different declared names can share one digest. The declared type lives on the
attachment metadata in the event, and the client applies it when it builds the
Blob. Serving inert bytes under `nosniff` also means a direct navigation
downloads rather than renders.

| status | meaning |
|---|---|
| `200` | `application/octet-stream`, `ETag: "<ref>"`, `Cache-Control: private, no-cache`, `Vary: Authorization, Cookie`, plus `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cross-Origin-Resource-Policy: same-origin` |
| `400` | `:ref` is not a `sha256-<64 lowercase hex>` reference — refused before it reaches any path |
| `404` | no readable binding for this caller, or bytes absent/reclaimed. The response does not reveal which case applies; the transcript keeps its attachment chip without a preview |

Every fetch reauthorizes a readable conversation binding; knowing the digest
is insufficient. ETag is emitted, but this handler does not implement an
authorization-skipping 304 path. See the [handler](../../src-server/routes/orchestration/attachments.ts),
[preview consumer](../../src-ui/src/components/chat/FilePartPreview.tsx), and
[retry recovery](../../src-ui/src/components/chat-dock/retry-attachments.ts).

---

## Model Capabilities

### Get Model Capabilities

`GET /api/models/capabilities` is the Bedrock-only capability projection described
under [Standalone Model Capability Routes](#standalone-model-capability-routes).
An absent model row is unknown; it does not show that a Claude Code, Codex, ACP,
or Ollama model rejects an attachment. The current
[UI helper](../../src-ui/src/contexts/ModelCapabilitiesContext.tsx) preserves an
unknown result for an unmatched model.

---

## Error Handling

There is no universal response envelope across these retained route families.
Many handlers return `{success: true, data}`, invocation returns `response`,
some provider-facing reads return plain objects, and fleet routes use
`manifest`/`completion`/`refusal`. Read each family's contract.

The [runtime error boundary](../../src-server/runtime/bootstrap/runtime-http.ts)
returns unexpected failures as a generic 500 with
`{success: false, error: {code: "internal_error", correlationId}}`. A typed
`RouteError` keeps its status and bounded message, with optional `code`,
`details`, and a correlation ID. Legacy handlers that catch errors locally can
still return a string `error`; a message substring is not a universal API error
code. Authentication, origin, scope, membership, and operation-specific refusals
also have their own shapes.

Clients must check HTTP status and the family's body/stream result. Treat 202
as acceptance with pending work when the response says so, 409 indeterminate
receipts as requiring observation, and a failed health result as different
from a failed HTTP request. Never retry a mutation solely because its response
was lost.

## Frontend Usage Summary

The current public entry point is the [SDK reference](sdk.md). Its source routes
lead from query hooks and clients to their handlers; the former Context-name
inventory here no longer described current consumers.

- [SDK client](../../packages/sdk/src/client/index.ts): instance-scoped HTTP APIs.
- [SDK query domains](../../packages/sdk/src/queries.ts): cache keys and query/mutation hooks.
- [API-base provider](../../src-ui/src/contexts/ApiBaseContext.tsx): selected Station and transport binding.
- [Chat dock](../../src-ui/src/components/chat-dock/ChatDock.tsx): current orchestration-based chat consumer.

The legacy imperative SDK functions and direct `fetch` callers do not all share
the instance client's error/transport behavior. Their individual reference
entries describe those limits.

---

## Auth & Users

These [provider-backed routes](../../src-server/routes/system/auth.ts) are
mounted under `/api/auth` and `/api/users`. Provider authentication status and
user-directory identity are separate from the HTTP request's paired/account
principal and route authority.

### Get Auth Status

`GET /api/auth/status` combines the configured auth provider's status with
`user` from the user-identity provider. The identity is process-cached and may
be enriched asynchronously; this is not the request-authority observation API.
For that distinction see [the SDK authority reader](sdk.md).

### Renew Credentials

`POST /api/auth/renew` calls the configured provider's `renew()` and returns its
result. A thrown renewal error returns `{success: false, error}` with 500.
It is not a generic paired-device credential rotation endpoint.

### Terminal Auth Renew

`POST /api/auth/terminal` calls the same provider renewal method and returns the
same provider-defined result shape.

### Get Badge Photo

`GET /api/auth/badge-photo/:id` returns JPEG bytes when the auth provider has a
photo. The handler sets `Cache-Control: public, max-age=86400`. Missing support
or bytes returns 404; a provider fetch failure returns 502.

### Search Users

`GET /api/users/search?q=<query>` returns the directory provider's result array.
An empty query returns `[]`. A caught provider failure also returns `[]` with
200, so this legacy response cannot distinguish a failed search from no matches.

### Lookup User by Alias

`GET /api/users/:alias` returns the directory provider's result. A thrown lookup
failure returns 404 with `{alias, name: alias, error}`; its message is the
formatted failure, not necessarily the literal `User not found`.

## Branding

### Get Branding Config

`GET /api/branding` reads the active
[branding provider](../../src-server/routes/system/branding.ts):

```json
{
  "success": true,
  "data": { "name": "Station", "logo": null, "theme": null, "welcomeMessage": null }
}
```

The name is provider-supplied. An absent optional logo/theme/welcome method
produces `null`; other returned values belong to the provider contract.

## Events (SSE)

### Subscribe to Real-Time Events

```http
GET /events
```

The [event relay](../../src-server/routes/orchestration/events.ts) subscribes to
the server event bus, sends the current ACP status, then drains events queued
during that initial read. It sends a named `ping` every 30 seconds.
This is a live connection-state/cache-invalidation stream, not durable Session
history replay with a resume cursor.

Only events admitted by the broadcast-safety policy or the relevant scoped
notification, approval, plugin, draft, navigation, and answer-evidence gate are
relayed. A listener does not receive every internal event. Paired-device
currentness is checked before writes, and disconnect cleanup releases the
listener's lease and subscription. See [server event keys](../../packages/contracts/src/runtime-events.ts)
for the payload vocabulary.

## File System

### Browse Directories

```http
GET /api/fs/browse?path=~
```

The [directory picker handler](../../src-server/routes/projects/fs.ts) lists
directories, not regular files. `path` defaults to `~` and is resolved on the
server's platform. On Windows, the server-emitted `\\` navigation level lists
present drive roots.

```json
{
  "success": true,
  "data": {
    "path": "/path/to/projects",
    "parent": "/path/to",
    "selectable": true,
    "entries": [
      { "name": "Documents", "path": "/path/to/projects/Documents", "isDirectory": true }
    ]
  }
}
```

`parent` is server-derived; `null` marks the top. `label` can name a navigation
level (Windows uses `This PC`). `selectable: false` identifies a navigation-only
level. Entry paths use the server platform's separators. Non-dot directories
sort before dot directories, alphabetically within each group.

| Status | Error | Cause |
| --- | --- | --- |
| 404 | `Folder not found` | Missing path |
| 403 | `Permission denied reading this folder` | Filesystem access denied |
| 400 | `That path is a file, not a directory` | Non-directory path |
| 400 | `Folder path is too long` | Filesystem path-length refusal |
| 400 | `Folder path is not valid` | Invalid path argument, such as a NUL byte |
| 500 | `Folder could not be read` | Other read failure; detail remains in server logs |

These error bodies use `{success: false, error}` and do not echo the requested
path. The API's authentication and operation authority still apply.

## Insights

### Get Usage Insights

```http
GET /api/insights?days=14
```

The [insights owner](../../src-server/routes/operations/insights.ts) streams
monitoring NDJSON files and returns `{success: true, data}`. `data` contains
`toolUsage`, a 24-bucket `hourlyActivity` array, `agentUsage`, `modelUsage`,
`totalChats`, `totalToolCalls`, `totalErrors`, `totalOutcomeUnknown`,
`totalUnresolved`, and `days`.

- `days` defaults to 14. It is currently parsed as an integer rather than
  validated against a closed set of windows.
- `agent`, `tool`, and `engine` are exact filters. Engine reads
  `gen_ai.provider.name`; an event without that field does not match.
- A positive `limit` retains the top buckets (cap 500); it does not cap the
  scanned events or recompute totals from just the displayed buckets.
- Applied filters/limit are echoed in `data.applied`. Hours use the server's
  local time. Health probes are excluded.

Chat counts deduplicate observed trace IDs, with a separate count for completed
`no-session` events. Tool calls count start records; errors, unresolved outcomes,
and unknown outcomes count end records. They are not a guaranteed joined
population: a retained end record can have no matching retained start.
`agentUsage.tokens` is currently initialized to zero and never accumulated by
this route; it is not measured token usage.

Filtering applies before aggregation. A tool filter excludes ordinary chat
records, so chat/model aggregates normally disappear. The current
[Agent-complete emitter](../../src-server/monitoring/emitter.ts) carries model
but no provider, so its model counts disappear under an engine filter; this is
a producer limitation, not evidence that the engine used no model. The route
also accepts other persisted event producers, so it cannot promise this absence
for every possible record.

Malformed lines and unreadable files are logged and skipped; this response has
no completeness field for those skipped inputs. A result is a rollup of what
was read, not certification that every event was available. `(unnamed)` is the
bucket for a missing tool name and remains distinct from a literal `unknown`.

### The rows behind the rollup

Use the historical branch of [GET /monitoring/events](#getstream-events-sse)
with `start` or `end` and the desired dimensions. It applies the existing user
and Session/tenant visibility checks and supports bounded tail reads; the
`read_monitoring_events` MCP tool uses that route too. These are monitoring
records, not the server log lines returned by `read_logs`.

---

## Standalone Model Capability Routes

The [standalone owner](../../src-server/routes/connections/models.ts) is distinct
from the shared `/bedrock` catalog. Do not assume it has the same pagination,
cache, selector resolution, pricing normalization, or failure contract.

### Get Model Capabilities

```http
GET /api/models/capabilities
```

The handler calls Bedrock `ListFoundationModels`, keeps ACTIVE/LEGACY rows, and
maps input/output modalities to `supportsImages`, `supportsVideo`,
`supportsAudio`, and streaming/lifecycle fields. Its one-hour cache is keyed by
the effective region. Region uses current app config before `AWS_REGION` and the
default; the runtime supplies Bedrock auth separately.

```json
{ "success": true, "source": "bedrock", "complete": true, "data": [] }
```

`complete: true` means this Bedrock catalog fetch succeeded, including a cached
successful fetch. It is not a cross-provider catalog or proof of live model
execution. Credential-classified failures return 200 with `data: []`,
`complete: false`, and an AWS-credentials warning. Other failures return 500.
Never interpret a missing row as unsupported merely because `complete` is true.

The current image-support UI helper matches IDs directly or by suffix and
returns `unknown` when no row matches. For a matched row it treats any of the
image/video/audio flags as `yes`; otherwise a nonempty modality list produces
`no`, and an absent/empty list remains `unknown`. That is the helper's current
attachment-support interpretation, not a promise that every provider accepts
all attachment media.

### Get Model Pricing (Standalone Route)

`GET /api/models/pricing/:modelId?region=us-east-1` returns
`{success: true, data: {modelId, region, inputTokenPrice, outputTokenPrice, currency}}`.
The region defaults through current app config, environment, and `us-east-1`.

This handler makes one AWS Pricing `GetProducts` request with `MaxResults: 100`,
then matches model-name text and reads the first price dimension in each
matching item. It does not follow pagination or normalize the unit; unmatched
input/output values remain null. It is not an exhaustive price quote or the
same implementation as `/bedrock/pricing`.

---

## Plugins

[Plugin route composition](../../src-server/routes/plugins/plugins.ts) mounts
these handlers under `/api/plugins`. Installation, visibility, permissions,
selected code, retained data, and runtime activation have separate owners.
The [Agent Plugins reference](agent-plugins.md) covers the package format;
[installation lifecycle](../design/plugin-installation-lifecycle.md) covers
retained generations and recovery.

### List Installed Plugins

`GET /api/plugins` returns `{plugins}` after projecting the installed inventory
for the calling principal. The instance operator sees the installed set;
other principals see its intersection with their visibility grants. An unresolved
principal returns 400; unreadable visibility, grants, or installation inventory
returns 503 instead of an empty success.

Rows include manifest metadata, `installationReadiness`, bundle/settings
availability, git observations when readable, and permission state. Rejected
installed entries can still appear with their rejection. `hasBundle` and a
listed provider declaration are not proof that its runtime contribution is
active. The [list handler](../../src-server/routes/plugins/plugin-install-routes.ts)
shows the complete current projection.

### Revoke Plugin Permissions

```http
DELETE /api/plugins/:name/grant
```

```json
{ "permissions": ["network.fetch"] }
```

The body names permissions to withdraw. The grant store commits withdrawal before
runtime reconciliation. Lifecycle permissions can additionally retire the
captured generation's server module, subscriptions, providers/adapters, and
engine connections. The response contains `success`, `revoked`, `granted`, and
`reconciliation`.

`winding-down` returns 202. A terminal `completed`, `superseded`, or `incomplete`
reconciliation returns 200, so HTTP success alone does not prove all cleanup
completed. An unavailable grant store returns 503. The
[permission routes](../../src-server/routes/plugins/plugin-public-routes.ts)
and [reconciliation service](../../src-server/services/plugins/plugin-grant-reconciliation.ts)
own those results. Host-approval reads retain reconciliation separately from
approval status; approving consent does not erase pending cleanup.

### Plugin Visibility Directory (operator only)

`GET /api/plugins/visibility` returns `{success: true, data: {principals}}`.
Its directory comes from known device/person principals in the trusted device
registry plus the operator row; it is not an inventory of every account or
principal the application could know. A principal with any active device is not
reported revoked solely because another device was revoked.

Each row carries its recorded plugin grants and an `operator` flag. The operator's
blanket sight is derived by the visibility service, not stored as an enumerated
list of every installed plugin.

### Grant or Revoke Plugin Visibility (operator only)

```http
POST /api/plugins/visibility/grants
DELETE /api/plugins/visibility/grants
```

```json
{ "principalId": "human:device:laptop", "plugin": "notes" }
```

`principalId` is the target, not caller authority. The
[handlers](../../src-server/routes/plugins/plugin-visibility-routes.ts) require
the resolved instance operator and validate the request. Non-operator callers
with a valid body receive 403; unresolved principals or invalid inputs receive
400. The [service](../../src-server/services/plugins/plugin-visibility-service.ts)
serializes its read/modify/write and returns the target's updated grant list as
`{success: true, data: {principalId, plugins}}`.

Visibility controls listing and composition. It does not grant a plugin runtime
permission or revoke an already granted execution capability.

### Which routes return plugin identity

The [route inventory](../../src-server/routes/plugins/plugin-identity-enumeration.ts)
and [scanner](../../scripts/plugin-identity-enumeration-scan.mjs) record three
current dispositions. The scanner is structural and has documented exclusions;
it is not proof that every possible response path was executed.

| Surface | Current disposition |
| --- | --- |
| `/api/plugins`, Project Pane catalog, layout pickers, Registry layouts, Home-role candidates/holder | Projected for the calling principal |
| Project layout list/detail | Projected with retained user-record text |
| Plugin update checks/reload, Registry plugin available/installed lists, Registry Agent/integration installed lists | Instance operator only |

[Project layout reads](../../src-server/routes/projects/projects.ts) withhold a
hidden plugin's binding, live package merge, catalog attribution, global actions,
and skills. The user's stored layout name, slug, description, or component
strings can remain; this is not a claim that the entire response contains no
plugin-authored text. Apply/from-plugin operations check visibility before
installed/enabled state.

The [Pane-reference owner](../../src-server/services/layouts/layout-pane-reference.ts)
can attach response-only `paneReferences: {unavailableTabIds}`. It names affected
stored tabs without claiming a cause, source, or remedy. Field presence matters
even when the array is empty: it indicates a withheld binding. The
[layout view](../../src-ui/src/views/layout-workspace-shape.ts) carries the verdict
to the renderer. This can conservatively mark multiple plugin-component tabs
when the record does not identify which plugin owns each component. Portable
Kit references follow their Kit lifecycle rather than a fictitious installed
plugin directory.

Plugin event frames on `/events` use the same projection; update-available lists
reach the operator only. The Home-role slot frame has a reserved name and marker
and names no installed plugin. See the [event gate](../../src-server/routes/plugins/plugin-identity-enumeration.ts)
and [relay](../../src-server/routes/orchestration/events.ts).

Addressed bundle, permission, and plugin-server routes are separate from catalog
projection. Their responses can reveal whether a guessed exact name is present;
the scanner records this as a residual limitation. Hiding a catalog entry is not
a guarantee that every addressed asset responds identically for hidden and
missing packages.

### Preview Plugin (Pre-install Validation)

```http
POST /api/plugins/preview
```

```json
{ "source": "/absolute/path/to/plugin" }
```

Alternatively send `registryId` so the host resolves the registry source and
claim. The [preview handler](../../src-server/routes/plugins/plugin-install-routes.ts)
stages source, validates it, reports components/conflicts/dependencies, and
cleans the staged directory without installing it. `valid: true` also carries
`contentDigest`, `grantRevision`, applicable `registryTrustRevision`, the
observed `installationRevision`, `existingDataScope`, and permission/dependency
consent information.

A source-fetch refusal can be HTTP200 with `valid: false`; inspect the body.
Invalid manifests/context or unsupported dependencies return400; a missing
registry entry returns404; changed registry source or trust refusal returns409.
A trust refusal includes a closed reason such as stale review or a missing
claim. Request data cannot supply trusted signing keys or declare itself
verified. See [registry trust policy](../design/registry-trust-policy.md).

### Install Plugin

```http
POST /api/plugins/install
```

The body contains `source`, optional `skip`, and a **required** `consent` object
from the reviewed preview. Consent carries `contentDigest`, `permissions`,
`grantRevision`, applicable `registryTrustRevision`, and approved dependency IDs
and their individual approval records. `dataPolicy` and `expectedInstallation`
cover preserve/reset and the observed installed generation. Do not construct
fake revisions or reuse a preview after its source changes; use the
[SDK install flow](sdk.md).

This route uses the [person-approval predicate](../../src-server/routes/plugins/plugin-person-approval.ts):
internal agent tools and unconfirmed person-device callers cannot install
directly. An Agent can propose work for a person to complete. Normal request
scope and other admission rules still apply.

The successful result carries plugin/tools/dependencies and permission state.
`permissions.dependencies` reports the installed transitive graph's remaining
approval needs, not merely the preview's requirements. Older responses can omit
it, which means unknown. A persisted install awaiting activation returns202
with `success: false` and `configurationActivation`, or a pending lifecycle
receipt. It is not complete solely because the HTTP request was accepted.

Missing/mismatched consent returns400, registry trust or diagnosed content-lock
conflicts return409, and unexpected/compensation failure can return500.
A dependency refusal is not a promise that no earlier staged/dependency effect
occurred; the [transaction owner](../../src-server/services/plugins/plugin-install-transaction.ts)
records compensation and retained-state limits.

### Check for Plugin Updates

`GET /api/plugins/check-updates` is operator-only. It reads installed names and
checks git/registry update sources. Results use the installed manifest name as
`name`, even when a registry entry ID differs. A caught top-level check failure
currently returns200 with `{updates: []}`; that legacy result cannot prove
there were no available updates.

### Update Plugin

`POST /api/plugins/:name/update` uses the person-approval predicate and resolves
the installed identity/current generation. A managed installation selects new
retained code with `dataPolicy: "preserve"`; this is not an in-place `git pull`
of its selected bytes. Its update path supplies no new operator consent, so
changes requiring a preview decision must be completed through preview/install.
Missing update source or managed update refusal returns409; pending lifecycle
or activation returns202.

The legacy path can still use git/registry update with a backup and restoration
on failure. Do not treat either path's response as proof that unmanaged child
processes or remote work ended. The
[lifecycle handler](../../src-server/routes/plugins/plugin-lifecycle-routes.ts)
contains the current identity, compensation, and activation branches.

### Remove Plugin

`DELETE /api/plugins/:name` also requires person approval. It resolves the
installed manifest identity, withdraws owned contributions/grants, and reconciles
runtime state while preserving conversation memory. Managed package removal
retains code/data for its lifecycle owner; it is not immediate disk reclamation.
A pending activation returns202 with `success: false` and its receipt. Inspect
the outcome before retrying or declaring cleanup complete.

### Serve Plugin Bundle (JS)

`GET /api/plugins/:name/bundle.js` returns JavaScript with `Cache-Control: no-cache`
when the [bundle reader](../../src-server/routes/plugins/plugin-bundles.ts) can
capture current, contained bytes. Unavailable/missing bytes return404.

### Serve Plugin Bundle (CSS)

`GET /api/plugins/:name/bundle.css` returns text/css for present bytes. The current
handler returns an empty200 when its reader returns no CSS, including unavailable
reads. That result is not proof of a complete CSS-free installation.

### Get Plugin Permissions

`GET /api/plugins/:name/permissions` returns `declared`, `granted`,
`contentBinding`, and `withheld` for the captured installation. Missing runtime
artifact returns404; unreadable grants return503.

### Grant Plugin Permissions

`POST /api/plugins/:name/grant` accepts `{permissions: [...]}` for declared,
grantable permissions. Trusted permissions require the isolated host approval
channel and are refused here with403. An accepted response can include
`granted`, `withdrawn`, and reconciliation: binding a new decision can withdraw
old permissions, so a grant request is not necessarily an additive-only effect.
Winding reconciliation returns202.

### Plugin Fetch Proxy (Scoped)

`POST /api/plugins/:name/fetch` is currently disabled. It checks the named
`network.fetch` grant, then returns403 because plugin execution identity is not
yet verifiable. A grant does not make this endpoint an operational HTTP proxy.

### Unscoped Plugin Fetch Proxy

`POST /api/plugins/fetch` returns403 requiring a named route. The development CLI
proxy is a separate implementation; neither production route provides the
successful proxy response previously shown here.

### Reload Plugin Providers

`POST /api/plugins/reload` is operator-only. It reconciles installation
projections, quiesces server modules/subscriptions, prepares and publishes the
provider generation, and reconciles Agent state. A pending projection or runtime
activation returns202 with `success: false`. Completed responses include
`loaded`; a failed quiescence/reload returns500. It is not a raw unconditional
"clear and reload everything" action.

### Get Plugin Providers

`GET /api/plugins/:name/providers` returns `{providers}` with declared `type`,
`module`, retained legacy `layout`, and `enabled` from provider overrides.
`enabled` here is configuration, not proof of runtime activation.

### Get Plugin Overrides

`GET /api/plugins/:name/overrides` returns `{disabled: [...]}` from the override
record for the current captured package.

### Update Plugin Overrides

`PUT /api/plugins/:name/overrides` accepts `{disabled: [...]}`, preserves other
stored overrides, and returns `{success: true}` after saving. This handler does
not itself reload providers. Current-artifact checks can return409, including
when a change was saved before currentness was lost; reload and inspect before
retrying. See [config handlers](../../src-server/routes/plugins/plugin-config-routes.ts).

---

## Registry

The [registry routes](../../src-server/routes/plugins/registry.ts) are mounted
under `/api/registry`. Catalogs and mutation results depend on registered
providers; a list entry is not proof of successful installation or activation.
Plugin-backed Agent entries use the full plugin lifecycle when resolved as such.

### List Available Agents (Registry)

`GET /api/registry/agents` returns `{success: true, data}` from the Agent registry
provider's available catalog.

### List Installed Agents (Registry)

`GET /api/registry/agents/installed` returns that provider's installed rows under
`{success: true, data}` and requires the instance operator.

### Install Agent from Registry

`POST /api/registry/agents/install` accepts `{id, ...pluginInstallFields}`.
When the ID resolves to a plugin, it uses the plugin install/consent path below.
Otherwise it calls the Agent registry provider and returns its result. A
successful provider result triggers ACP-mode refresh, whose failure is currently
caught separately; it is not a universal runtime-activation receipt.

### Uninstall Agent from Registry

`DELETE /api/registry/agents/:id` likewise resolves a plugin-backed entry through
plugin removal, or calls the Agent registry provider. Plugin lifecycle pending
results retain their activation semantics; a plain provider result is not the
same receipt.

### List Available Integrations (Registry)

`GET /api/registry/integrations` returns `{success: true, data}` after the route's
ID filtering, first-ID deduplication, and display-text cleanup.

### List Installed Integrations (Registry)

`GET /api/registry/integrations/installed` is operator-only and returns the
integration registry provider's installed catalog.

### Install Integration from Registry

`POST /api/registry/integrations/install` accepts `{id}`. After successful provider
installation, an available ToolDef is saved **disabled**. An existing
credential-binding configuration can refuse replacement with409. Provider
installation success does not prove connection, enablement, or Agent attachment.

### Uninstall Integration from Registry

`DELETE /api/registry/integrations/:id` returns the provider's uninstall result.
After provider success it attempts to delete the local definition; that deletion
error is currently caught, so success is not proof that local cleanup completed.

### Sync Integration Registry

`POST /api/registry/integrations/sync` awaits provider sync and returns
`{success: true}`.

### List Available Skills (Registry)

`GET /api/registry/skills` merges registered Skill catalogs and deduplicates IDs,
keeping the first occurrence. No registered providers gives an empty list.

### Install Skill from Registry

`POST /api/registry/skills/install` accepts `{id}` and returns SkillService's
result. It attempts a Skill reload after success; a caught reload failure does
not change the install result.

### Uninstall Skill from Registry

`DELETE /api/registry/skills/:id` returns SkillService's removal result and uses
the same reload behavior. Package-owned read-only Skills retain their owner's
mutation rules.

### List Available Plugins (Registry)

`GET /api/registry/plugins` is operator-only and returns
`{success: true, data}` with catalog installation status.

### List Installed Plugins (Registry)

`GET /api/registry/plugins/installed` filters the same availability projection to
installed entries; it is also operator-only.

### Install Plugin from Registry

`POST /api/registry/plugins/install` resolves the registry ID to a unique source
and uses the full plugin transaction. Its body can carry the same preview
consent, skip list, data policy, and expected installation as source installation.
Ambiguous registry ownership is refused rather than resolved by choosing the
first provider.

Unlike direct `/api/plugins/install`, this compatibility path can construct a
`no-operator-decision` request when consent is absent. The
[consent owner](../../src-server/services/plugins/plugin-install-consent.ts)
permits that only when there are neither consent-requiring permissions nor
undisclosed contributions. A UI/Agent/dependency-bearing package cannot use that
absence as approval. Person, scope, current content/grant revision, registry trust,
and activation checks still apply. Prefer preview and an explicit decision.

### Uninstall Plugin from Registry

`DELETE /api/registry/plugins/:id` resolves installed identity and uses the full
person-gated removal transaction. Pending runtime activation returns202 with
`success: false` and `configurationActivation`; normal completion returns200.

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
GET /scheduler/jobs/preview-schedule?cron=<expr>&count=5&timezone=<iana>
```

Returns the next N scheduled run times for a cron expression.

**Query Parameters**:
- `cron`: Cron expression (required)
- `count`: Number of upcoming runs to return (default: `5`)
- `timezone`: IANA zone the expression is written in (optional). Omitted means
  UTC, which is how the scheduler evaluates a schedule with no zone — so a
  preview of a ZONED job must send this or it describes different instants from
  the ones the job will fire at.

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

On a source checkout, runs `git pull --ff-only`, installs dependencies through
the repository's owned lifecycle (`npm run dependencies:install`, the same step
`station upgrade` runs), builds through the checkout's own `station build`, emits
a `core:updated` event, and restarts the server under a detached health
watchdog. A pulled tree without the owned dependency lifecycle fails closed
(`500`) before anything is installed, built, or restarted.

**Response**:
```json
{ "success": true, "restarting": true, "hash": "def5678", "restart": { "expectedHash": "def5678", "expectedInstanceId": "default", "deadlineAt": "..." } }
```

A supervised server refuses with `409` before any git or build work, because
its supervisor would restart it mid-update. The code is `service-managed` under
the installed launchd/systemd service, and `supervised` when only a supervisor
PID is present (the Windows service, the desktop, a development harness), whose
remedy does not presume the service:

```json
{ "success": false, "selfUpdateUnavailableCode": "service-managed", "error": "... Stop the service with \"station service stop\", run \"station upgrade\", then start it again with \"station service start\" ..." }
```

`GET /system/core-update` reports the same refusal up front as
`selfUpdateUnavailableCode` with the remedy in
`selfUpdateUnavailableReason`, so clients do not offer an apply the server
will refuse.

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

```json
{ "prompt": "What is 2+2?", "tools": [], "maxSteps": 5 }
```

The [global owner](../../src-server/routes/agents/invoke-global.ts) builds a
temporary Agent with selected tools from the runtime's global registry. The
body also accepts `schema`, `model`, `structureModel`, and `system`. Model
selection is `model` → configured `invokeModel` → `defaultModel`; structured
formatting uses `structureModel` → configured `structureModel` → resolved invoke
model. Both are resolved through Station's model-selection path.

Without a schema, the JSON response carries text, usage, step count, and a
`runId`. With a schema, a second, tool-free Agent formats the first result using
`generateObject`; the response includes the primary run ID and
`relatedRunIds` for that formatting pass. If the first pass completes but
formatting does not, the route returns a partial 409 receipt rather than
pretending the whole operation never ran. This is a separate implementation
from the named-invoke prompt-and-parse behavior above.

---

### Tool Approval Response
```http
POST /tool-approval/:approvalId
```

Resolve a pending tool call using the request-bound Session read authority and
client origin. Knowing an approval ID alone is not sufficient. The
[approval handler](../../src-server/routes/agents/invoke.ts) returns 404 when it
cannot resolve an authorized pending request.

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

Returns `{success: true, message: "Usage stats reset"}` after resetting the
existing aggregate stats file to `{}`. It does not delete conversations,
monitoring logs, or invocation receipts; later updates/rescans can rebuild
statistics from retained sources. See the
[aggregator reset](../../src-server/analytics/usage-aggregator.ts).

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

[Runtime composition](../../src-server/runtime/routes/runtime-routes.ts) mounts
Station's Hono handlers and supplies their service dependencies. The framework
server also has its own routes. Follow the composition call and the specific
handler together; a relative path inside a route factory is not its public URL.

### Authentication

[HTTP security](../../src-server/runtime/bootstrap/runtime-http.ts) is installed
before the public/custom handlers, with a route-classification gate and the
[external surface policy](../../src-server/security/pairing-route-scopes.ts).
Authentication-provider identity, paired-device scope, account membership,
Session ownership, and operator authority answer different questions. A valid
credential does not by itself authorize every operation. See
[endpoints](endpoints.md) for the route/auth authorities and
[deployment authentication](../guides/deployment-authentication.md) for identity.

### CORS

The running Station uses the exact browser origins assembled by
[resolveStationBrowserOrigins](../../src-server/security/station-browser-origins.ts):
configured additions, its bound-port loopback origins, native shell origins, and
specific bound-host origins. The CLI adds its UI listener origins. Other origins
are refused before route dispatch. This is not the permissive helper used when
HTTP security is absent, and it does not allow every localhost port. Origin
admission does not replace authentication or scope. See
[environment settings](env-vars.md#server).

---

## Bind a paired device to its verified person

`POST /api/pairing/requests/:requestId/confirm` accepts an optional JSON body:

```json
{ "bindVerifiedIdentity": true }
```

The operator must deliberately select this option. The pending device request
must carry server-verified Tailscale identity; the server derives its subject.
Only a current operator credential or a verified local-grant operator may bind
it. Ordinary paired-device approval authority, an internal proxy token or a
self-declared subject is insufficient. Hosted binding is unavailable until the
device store is tenant-bound (`409 person_binding_unavailable`). Invalid fields/types return `400`; insufficient
operator authority returns `403`. Bodyless approval preserves device-only access. A binding approval returns
`personBindingApproved: true`; clients must require that acknowledgment because
older servers can accept an ordinary approval without understanding the option.

The existing one-time exchange persists `device.principalBinding` together with
the credential. Its provider, subject, approval time, approval id and approving
principal record explicit consent; they grant no Project membership or added
wire scope. The binding lasts with the device grant and is removed from active
authority by revoking that device. Two approved devices for the same verified
subject resolve to the same person over direct connections. A conflicting live
identity is refused. Existing grants/history are not relabeled automatically.

Use the host pairing panel's **Recognize this device as …** checkbox or
`station environment access approve <request-id> --bind-person` on the Station
computer for this flow. See [Project membership and enrollment](../design/project-membership.md)
for the accepted pilot contract and the remaining shared-Project work.
