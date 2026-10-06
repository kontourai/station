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

## Station MCP endpoints

`/mcp/station-control` serves platform controls. `/mcp/station-knowledge`
serves five read/capture tools described in the [Knowledge guide](../guides/knowledge.md#agent-tools).
Both accept only loopback connections with a live, session-scoped credential
for that exact server. They use MCP authentication rather than a paired Device
credential. Tokens for one server cannot open the other, and in-process tokens
cannot be presented over HTTP. Ordinary API and Project authorization still
apply to each tool operation.

## Endpoint Legend

- Method and path identify the route, not its permission tier.
- HTTP success can mean persisted or accepted while activation remains pending.
- Readiness, health, catalog discovery, and a completed model turn are distinct
  observations. Response fields and receipts state which one was observed.

## Choosing a working folder

Naming a folder takes the authority to run commands there: for a paired
device, the operator's `coding:exec` grant (the same rule `POST /api/projects`
applies to a Project's folder). A device without it, including a `delegation`
or `standard` preset device, gets `403` with
`code: 'working-directory-not-granted'` and nothing starts or saves. The rule
covers exactly these routes:

- `POST /api/orchestration/delegations`, `/chat`, `/chat/delegated`,
  `/chat/background` and `/conversations/:conversationId/handoff`, when
  `target.workspace` is `{ kind: 'directory', cwd }`;
- `POST /api/tasks/:taskId/dispatch` and `POST /api/starter-work/launch`
  (`start-task`), when `runtimeConfig.cwd` is not the Task Project's own
  folder;
- `POST /api/projects/attach` with a `workingDirectory`, and
  `PUT /api/projects/:slug/identity/execution-root` setting a path.

A `{ kind: 'project' }` workspace is unchanged. The operator, and the desktop
app on the Station's own computer, are not decided by the rule. Other routes
that take a path are not covered by it.

Choosing a command for Station to run takes the same authority, decided by the
same check, and answers `403` with `code: 'command-not-granted'` and nothing saved
or run. It covers exactly: `POST /acp/connections`, and `PUT /acp/connections/:id`
when `command`, `args` or `cwd` change; `POST /integrations`, and
`PUT /integrations/:id`, when `command` or `args` are set or change; `POST
/api/projects/:slug/flow/runs/:runId/evidence/command`; and `PUT /config/app`
when `terminalShell` changes (an agent's station-control call may not change it
at all). The same code covers a tool server's `env` or `secretEnv` on a
command-launching server, a URL-transport record changed to launch a stored
command, `POST /api/plugins/install`, `/:name/recover` and `/:name/update`,
`POST /api/registry/plugins/install` and `POST /api/registry/integrations/install`;
entering an API key for a command-launching tool server from a paired device now
needs the grant. Binding a secret to a command-launching server
(`POST /api/secret-bindings/:id/bind`, `migrate-stored-env`, and `PUT` on a binding
already bound to one) and `POST /api/registry/agents/install` take it too. A bind is checked for a missing or hidden
binding too, so a caller without the grant gets `command-not-granted` there and one
with it gets the service's `404`; a person-owned binding still answers the
service's `400`; no env name is
exempt. A saved
Environment's dispatch that names no Project
is sent with the verified project folder; if that Station answers
`working-directory-not-granted`, the caller gets a fixed message naming a Project
or the grant.

## Personal Task room agent requests

`GET /api/tasks/:taskId/room/agent-requests` returns the authorized, versioned
request projection. A client must verify `station.task-room-work/v1` before
sending an additive `taskRoomRequest` through `POST /api/orchestration/delegations`.
That object requires `taskId`, `taskCreatedAt` and a stable `operationId`;
the normal prompt and execution target remain outside it. Supporting servers
also advertise `contextVersion: 'station.task-room-context/v1'` and an authorized
Task/shared-document snapshot in the read response. A create can supply only its
`context: { version, digest }` reference. The server captures and saves that exact
brief for a new operation; an existing operation reuses its saved snapshot.
A stale/unavailable context is refused before invocation, and changed context
under an existing operation conflicts. This initial path
admits current-Station execution in the exact Task Project, with the existing
read/operate, readiness and provider-effect authority gates. A request receipt
does not establish Task completion or result quality.

Ordinary `POST /api/tasks/:taskId/room/messages` can include
`expectedTaskCreatedAt`; the room's history grant rechecks that incarnation
before commit. See the [ownership and failure contract](../design/task-room-agent-requests.md)
and [SDK clients](sdk.md#task-room-agent-requests). These routes are personal-runtime
composition; this reference does not claim hosted, anonymous-public or invited
participation acceptance.

### Keep a declared output

`POST /api/tasks/:taskId/declared-outputs/:sessionId/:eventId/keep` accepts
`{operationId}` and resolves the declaration from the authorized Session owner.
The [route](../../src-server/routes/orchestration/task-outputs.ts) captures the
Task's Project, creation time and workspace. Its publication witness refuses a
changed Task incarnation, Project or workspace, including at the pull-request
commit boundary. Reusing an ID and path does not make a replacement Task the
original target.

The [Session output owner](../../src-server/services/orchestration/session-outputs-module.ts)
checks the durable declaration and source workspace. File curation reaches the
[immutable output store](../../src-server/services/projects/task-output-module.ts),
which checks declared digest/length against captured bytes and rechecks the
publication witness under its lock. A successful keep is `201` with a
`task-declared-output-keep/v1` result; conflicts are `409`, previously deleted kept outputs
are `410`, unavailable storage is `503`, and lost current authority is opaque
`404`. A keep preserves an artifact or reference; it does not establish agent
attribution, accepted quality or feedback. Exact-version review is described below; it remains a human statement rather than Task acceptance.

An agent on any engine declares a pull request with the Station Control
`declare_pull_request` tool, which writes the same declared-output record as
Station's own `declare_output` (see [the tool](../guides/self-configuring-agent.md)).
Its REST side, `POST /api/orchestration/station-control/declare-pull-request`, is
for Station's own tool code only: it answers 404 to any request the runtime
boundary did not accept as Station's internal principal, derives the Session and
its running turn from the verified caller, takes a body of exactly
`{provider, host, repository: {owner, name}, ref, label?}` (the conversation link
identity), and answers `{status}` with `declared`, `already-declared` or
`no-active-turn`. A pull request in another repository than the Session's, or one
the provider cannot return at that identity, is `409`. The declaration lands with
the turn's completion: it is held, with no time limit, while the turn runs, and
is dropped if the turn is aborted, interrupted, ends in an error or is replaced
(a retried transient error keeps the turn alive), or if Station
restarts before the turn completes (declarations wait in memory until the
terminal event is stored). The keep above applies to it unchanged.

`PUT /api/tasks/:taskId/close-on-merge` accepts `{enabled}` and sets or clears the
Task's `closeOnMerge` flag. It is a person's opt-in: no Station Control tool
reaches it, and the authority guard refuses an agent's request to it. A Task with
the flag moves to `done` when every pull request kept on it reports `MERGED` at its
provider, matched by declaration and pull request (one turn's declarations share
an event, so the event alone is not the match), if it is still the same Task
incarnation, nothing was kept since the reads, and `canTransitionTaskStatus` allows
`done`: a Task in todo, ready, triage or blocked never closes by itself. A pull
request closed without merging does not complete it; un-keeping an unmerged pull
request lets the remaining merged ones close it. The check rides the conversation
pull request refresh (`GET /api/conversation-pull-requests/:conversationId`): a
refresh that observes a merged pull request reconciles the Tasks that kept it, in
the background, but only when the viewer holds the pairing scope
`PATCH /api/tasks/:taskId/status` needs (`orchestration:operate`), and never for a
Station Control tool call. There is no timer, so a merge is noticed when an
operate-tier viewer next refreshes that conversation, and nothing reconciles
without one. A store carrying the flag is refused by older Station builds: clear
it before a rollback.

New snapshots store their Task creation identity and, for admitted Session
declarations, the declaration's Session/event/turn/tool identities privately.
Public output records remain schema version 1 and omit those private fields.
Reads and operation receipts for new outputs do not cross a Task incarnation;
legacy outputs retain unknown provenance rather than receiving invented values.
Legacy deletion receipts conservatively continue to block the same declared
candidate under a fresh operation ID.

The private index becomes schema version 2 on the first new snapshot. The new
reader accepts existing version 1 rows; older binaries reject the version 2
index, so downgrade requires an explicit migration. Task deletion clears its
retained identity reservations only while the Task remains absent under the
output lock. This module contract has no current mounted cascade caller and
does not establish a joint transaction with TaskGraph.


## Table of Contents

| Area | Route families |
| --- | --- |
| Work and layouts | [Starter Work](#starter-work), [Spatial Board](#spatial-board), [personal Boards](#personal-boards), [Layouts](#layout-management), [workflow files](#workflow-management), [independent review](#independent-review-evidence) |
| Agents and conversations | [Agent management](#agent-management), [invocation](#agent-invocation), [Task room requests](#personal-task-room-agent-requests), [orchestration model selection](#orchestration-model-launch-behavior), [conversations](#conversation-management), [attachments](#attachments), [global routes](#global-routes) |
| Models and configuration | [App configuration](#configuration), [connections](#connections), [fleet inference](#fleet-inference), [Bedrock catalog](#bedrock-models), [model capabilities](#model-capabilities), [standalone model routes](#standalone-model-capability-routes) |
| Activity and observations | [Analytics](#analytics), [monitoring](#monitoring), [insights](#insights), [events](#events-sse), [analytics reset](#additional-analytics) |
| Extensions | [Plugins](#plugins), [Registry](#registry), [frontend clients](#frontend-usage-summary) |
| Host operations | [Scheduler](#scheduler), [system](#system), [additional system reads](#additional-system-routes), [filesystem browse](#file-system), [UI commands](#ui-commands) |
| Identity and protocol | [Auth and users](#auth--users), [person binding](#bind-a-paired-device-to-its-verified-person), [branding](#branding), [errors](#error-handling), [registration/auth/CORS](#architecture-notes) |

---

## Starter Work

```http
GET /api/starter-work
GET /api/starter-work/:starterId
GET /api/starter-work/:starterId/candidate
GET /api/starter-work/:starterId/observation
POST /api/starter-work/bind
POST /api/starter-work/launch
DELETE /api/starter-work/:starterId/binding
```

Starter Work links a bounded onboarding catalog to real Work owners. Its five
IDs are `start-task`, `continue-session`, `inspect-approval`, `inspect-receipt`,
and `run-scheduled-check`. Binding/launch and inspection candidates require the
home's completed first-run decision. Catalog/status reads describe readiness
and correlation; they do not make a browser checklist authoritative.

The [routes](../../src-server/routes/starter-work.ts) return
`{success: true, data}` for successful reads/actions. Unknown starters return 404;
invalid targets, prerequisites, or conflicting correlation return 409; unavailable
owner/storage paths return 503. Launch results with state `started`, `continued`,
or `opened` use 201; other typed dispositions use 200. Always inspect the data:
HTTP status alone does not prove useful-work completion.

- **Start a Task:** the body names `starterId`, a stable `operationId`, and
  `task` with its Project ID/title, plus optional top-level `dispatch` inputs. The
  [registry](../../src-server/services/starter-work/starter-registry.ts) checks
  readiness before creation. Deferred/unavailable readiness is retry-safe and
  creates no Task. A ready request creates the Task idempotently, then binds and
  fences dispatch. `state: "started"` can still contain unverified correlation
  or failed/indeterminate dispatch; read those fields before claiming execution.
- **Continue a Session:** the body names the Starter ID, operation ID, and
  exact source Session ID, plus an optional `target` for a Session no Project
  claims (`adoptSession`'s `target`, [Session API](session-api.md)); it never
  names a folder. The [session owner](../../src-server/services/starter-work/starter-session-owner.ts)
  validates and adopts the source through the existing idempotency ledger.
  Its child Session/command receipt proves admission, not useful completion.
- **Inspect approval/receipt:** candidate reads return exact typed references.
  Launch revalidates the owner and returns an approval-inbox or Project Review
  layout link. Inspection does not approve a request or turn review findings
  into a gate verdict. Observation rereads the owner; it does not trust copied
  browser state.
- **Run a scheduled check:** the server prepares `station-starter-check` disabled,
  using the Station Agent, no generic retries, and a 24-hour interval. It binds
  the exact manual scheduler-run receipt before activation. Repeated operation
  IDs replay that prepared run. The Home recovery action uses the stored
  operation ID; observing `completed` proves the check ran, not that its findings
  passed a gate.

The [binding store](../../src-server/services/starter-work/starter-work-module.ts)
keeps correlation separate from dispatch fencing. Explicitly clearing a binding
does not delete the underlying Work or erase an admitted dispatch fence.
`NOT_VERIFIED` remains appropriate until the referenced owner supplies the
relevant evidence. Starter counters use the normal monitoring instrumentation;
see [telemetry configuration](env-vars.md#telemetry) for export/usage controls.
These personal Starter routes are not mounted in hosted mode.

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

The Spatial Board is a separate, personal-mode pin store—not a personal Layout
from `/api/me/layouts`. Its [schema-v2 store](../../src-server/services/spatial-board/spatial-board-store.ts)
persists board title/camera and pins containing an ID, full WorkReference, and
bounded geometry/order. Work titles, state, verdicts, and evidence stay with the
referenced owners.

[GET resolved](../../src-server/services/spatial-board/spatial-board-resolver.ts)
groups only the current board's stored references by owner. It returns ephemeral
`current`, `missing`, `stale`, `unavailable`, `ambiguous`, or `NOT_VERIFIED`
projections rather than a general cross-product query result.

Every mutation carries `expectedRevision`, including DELETE and undo. The
[routes](../../src-server/routes/spatial-board.ts) return 409 for revision/identity
conflict, 404 for a missing pin, 413 for capacity, and a redacted 503 for unavailable
storage. Successful results use `{success: true, data}`. PUT also requires the
body pin ID to match the path.

Cleanup accepts full references that the caller observed as missing. The store
checks they belong to the board and removes matching pins; it does not rerun
owner resolution inside that write. Undo swaps one prior bounded snapshot and
advances revision; it is not an unbounded edit history. Hosted mode does not
mount these personal-storage routes.

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

`start-step` and `finish-step` frames carry only their type. Provider request
and response bodies, headers, metadata and nested errors are not sent in these
frames. Text and successful tool frames retain their contracts. Failed VoltAgent
tool-result frames omit the raw `output`, including error messages, stack traces
and other error properties. Their `error` carries a safe Station-composed denial
reason or the fixed `Tool call failed.` message; policy-denial badges remain.
Any other frame field holding a raw error object (for example a `tool-error`
part's `error`) is sent as the fixed text "The response stream failed.", and a
mid-stream `error` part ends the turn with a single outward error frame.

The framework compatibility route `POST /agents/:slug/chat` remains behind
Station authentication. Its HTTP 5xx responses contain fixed failure text and
a correlation ID, never the provider's raw error message. Successful streams
and client-side 4xx refusals keep the framework's response contract.

<a id="agent-management-1"></a>

### Default Agent

The public built-in Agent ID is **`station`**. `default` remains a private
Station-engine map key; use public identities returned by `/api/agents`.
The built-in Agent can be bound to an external engine, or run on Station's own
engine with a resolvable Model connection and model. A model-less Station still
starts its configuration and connection surfaces; that does not prove the
Station-engine Agent is launchable.

The [default-Agent builder](../../src-server/runtime/agents/runtime-default-agent.ts)
loads `station-control`, `station-knowledge`, and `station-docs` on the Station-engine path, installs
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
failures; inclusion in the list is not proof that a chat can launch. A bound
row's `engineId` and `engineConnectionType` come from the connection record and
its Adapter, so they survive a failed or timed-out runtime inspection;
`engineDisplayName` and availability still need that live read. The example
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

A request acting for a deployment account (a Project member) never receives
this shape. The
[Agent audience gate](../../src-server/runtime/bootstrap/agent-audience-gate.ts)
answers `GET /agents`, `GET /api/agents` and `GET /api/agents/:slug` for it
with `station.member-agent/v1` views of Agents whose
[audience](config.md#audience) admits it; `/api/boot`'s `agents` section
carries the same views. Any other or unknown Agent slug, in a path or as an
orchestration `target.agent`, returns `404 Agent not found`. A turn on an
admitted Agent returns `403 member_agent_turns_unavailable`. Creating or
materializing an Agent, and updating, deleting or editing the tools or
workflows of an admitted one, returns `403 member_agent_catalog_read_only`
(a hidden slug stays `404`). All of these gate
responses are `no-store`. See
[Agent audience](../design/project-membership.md#agent-audience).

---

### Create Agent
```http
POST /agents
```

The [Agent routes](../../src-server/routes/agents/agents.ts) validate the body,
persist the definition through AgentService, and queue runtime reconciliation.
Creation can succeed with a non-blocking availability warning. Raising the
effective default approval posture to full access requires its separate authority.
That includes creating an Agent which inherits a Station default of `never`,
or clearing an Agent override so that it inherits that default. Updating an
already-effective full-access default without raising it follows the existing
write authorization; an unreadable prior Agent is not evidence of that state.
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

### Connected accounts (#3279)

An integration whose definition sets `credentialOwnership: {owner: "principal"}`
uses each person's own account instead of the shared Station credential. A turn
uses only the credential of the principal it runs as (a credential narrowed to the
Agent's Project first, then the person's own). A person without one gets a
"connect your account" refusal; the shared credential is used only when
`allowInstanceFallback` is `true`. The owner is the request's resolved human
`PrincipalRef.id`; a paired device without a person, a non-human principal, and a
hosted request cannot own an account.

`POST /integrations/:id/oauth/authorize` and `POST /integrations/:id/oauth/callback`
accept optional `owner` (`"self"` or, when fallback is allowed, `"instance"`) and
`projectSlug`. A person's consent flow is keyed by the principal who started it, so
only that principal's callback can complete it, and it never changes the
integration's shared `probe.authorization`. A successful first connection records
the tool catalog Agents load that integration's tools from.

`GET /integrations/:id/account[?projectSlug=]` returns the caller's own state:
`{ownership, connectedAs, personal, project?, shared, catalogAvailable}`. It shows
owner and availability only, never a token. `DELETE /integrations/:id/account`
removes the caller's own credential; the next call that needs it refuses.

MCP Apps reads and calls are not available yet for these integrations.

### Delete Integration

`DELETE /integrations/:id` returns `{success: true}` after deletion.
Runtime-managed built-ins such as `station-control`, `station-knowledge`, and `station-docs` return
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

The current [Agent editor](../../src-ui/src/views/agent-editor/useAgentsViewModel.ts)
reads this catalog through [useAgentToolsQuery](../../packages/sdk/src/query-domains/agentAdmin.ts).


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


---

## Layout Management

Standalone `/layouts` endpoints were removed during project-layout convergence.
Use the [Project layout routes](../../src-server/routes/projects/projects.ts)
under `/api/projects/:slug/layouts`, or the separate [personal Board](#personal-boards)
routes for principal-owned layouts.


---

## Personal Boards

A Board here is a **Layout owned by a principal**. It differs from the Spatial
Board's Work-reference pins. The [owner-scoped storage](../../src-server/domain/layout-owner-storage.ts)
keys personal layouts from the exact principal ID, so devices resolving to the
same person can share them. An unbound paired device normally has its own
device principal. The request's identity resolver supplies the owner; the body
cannot choose it.

The [routes](../../src-server/routes/me/personal-layouts.ts) return 400 with
`principal_unresolved` when no principal can be resolved. A Board outside the
resolved owner's store has the same 404 as an absent Board. Operations use the
[personal-layout service](../../src-server/services/layouts/personal-layout-service.ts).

### List My Boards

`GET /api/me/layouts` returns `{success: true, data: layouts}` for that owner.

### Create a Board

```http
POST /api/me/layouts
```

```json
{ "slug": "daily-brief", "name": "Daily brief", "type": "custom", "config": {} }
```

Creation returns 201 with `{success: true, data: board}`. A duplicate slug within
that owner's store returns 409. Unknown fields, including a supplied owner, are
refused by the strict request schema.

### Get a Board

`GET /api/me/layouts/:layoutSlug` returns `{success: true, data: board}`.
It can add response-only `paneReferences: {unavailableTabIds}` for tabs withheld
from that viewer. The verdict contains no cause/source/action and is not stored.
Unlike Project layout detail, this handler does not merge live plugin files or
backfill a catalog contribution. See [plugin identity projection](#which-routes-return-plugin-identity).

### Update a Board

`PUT /api/me/layouts/:layoutSlug` accepts a partial writable shape, for example
`{name: "Renamed"}`, and returns the updated Board. Omitted top-level fields
remain stored; each update reads and writes under the owner's record transaction.
Concurrent replacements of the same field still have ordinary last-write
semantics, and `config` is not a deep merge of independent nested edits.

The schema refuses `id`, `slug`, owner, and timestamps. It tolerates then discards
`paneReferences`. This does **not** make an entire GET response a valid PUT body;
clients must still select writable fields. The returned verdict is recomputed.

### Delete a Board

`DELETE /api/me/layouts/:layoutSlug` returns `{success: true}` or 404 when absent.

### Promote a Board into a project

```http
POST /api/me/layouts/:layoutSlug/promote
```

```json
{ "projectSlug": "project-slug" }
```

The body names only the destination Project. This is a move: it preserves the
Board's ID, slug, and creation time, publishes under the Project owner, then
deletes the personal record. A missing Project returns 404, and a different
layout already occupying that slug returns 409.

Before publication, the service uses the same
[layout admission](../../src-server/routes/projects/project-layout-admission.ts)
as Project creation: Agent reachability and derived workspace constraints still
apply. A coding layout cannot bring its own `config.workingDirectory`; the
Project supplies it. This data-admission step does not itself grant Project
membership. The route retains the existing operation-scope boundary rather than
adding a separate membership decision in this service.

Create-then-delete preserves the record if the process stops between writes,
but can temporarily leave both copies. Repeating promotion recognizes the
matching ID at the destination and finishes the personal deletion. That recovery
is not a transaction spanning both stores.

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
`{success: true, data: messages}`. A conversation can span several execution
Sessions: a follow-up its current Session cannot take, such as one after a
failed Station-agent turn, runs in a successor Session. The read covers every
Session in the conversation's lineage, oldest first, and concatenates them
([read seam](../../src-server/routes/chat/conversations.ts)). For each Session it
reads the file-memory record first and, when that has no usable record, the
authorized messages restored from orchestration. A successor stores only its
own turns; earlier history reaches its model without being copied into its
record. Export, fork and summary use the same read. A successor's own record
is never listed as a conversation of its own, and conversation message search
reports its hits under the conversation it continues. A conversation whose
lineage exceeds 64 Sessions is refused with 422 `conversation_lineage_too_long`
by this read, export, fork, summary and stats, rather than read partially. Messages carry the owner's current parts/metadata shape; do not depend on
every message having the old `content: string`/`timestamp` pair.

A stored user turn is the typed text (and its attachments) alone. Ambient
context such as `[Timezone: …]`, skill instructions, project rules and
retrieved knowledge reach only the model's input for that turn.

A `/chat` turn that failed before producing output is recorded as its prompt
followed by a user-role `[SYSTEM_EVENT] [CHAT_ERROR] <text>` message, with no
empty assistant reply between them. `<text>` is never the model
provider's own error message. It is one of: a status sentence such as
"The model provider returned an error (HTTP 500).", "The model provider
rejected the credentials.", "Stream aborted by client", or "The response
stream failed.". A marker stored before this rule holds provider text on
disk; this route and everything behind the same read seam (export, fork and
summary), title regeneration and the knowledge store's conversation records
serve it as "The response stream failed." instead
([marker scrubber](../../src-server/runtime/conversation/chat-error-marker.ts)).
The marker never reaches a model: the Station-engine prompt, native-memory
history and a direct Strands conversation's replayed history all exclude it.

### Update Conversation

`PATCH /agents/:slug/conversations/:conversationId` accepts the supported
conversation update, such as `{title: "New title"}`, and returns
`{success: true, data: updated}`. This is the file-memory update path.
Orchestration-owned titles return 409 here; hosted requests and missing records
are refused. Use the orchestration operation for its owned history.

### Delete Conversation

`DELETE /agents/:slug/conversations/:conversationId` returns `{success: true}`
after deleting file-memory history and its derived summary. Orchestration
history is read-only through this path (409), including a conversation whose
later turns run in successor Sessions and each successor itself, and hosted
requests return 404.
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
inputs; missing provider observations are not measurements of zero. Like the
message read, stats cover every Session in the conversation's lineage: stored
cumulative figures (tokens, turns, tool calls, cost) sum across the Sessions'
records, and context occupancy comes from the newest one. Without a stored
record, the orchestration usage fold runs over every authorized Session's
events in lineage order.

`contextWindowPercentage` is absent when the model's context window cannot be
resolved. Render that as unavailable. See the
[stats owner](../../src-server/runtime/conversation/conversation-manager.ts)
and [response contract](../../packages/contracts/src/runtime.ts).

These statistics cover the conversation's own turns. Its usage with every
subagent and delegated task under it, with a total that says what it leaves
out, is the
[conversation usage tree](session-api.md#conversation-usage-tree-get-conversationsconversationidusage-tree).

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
Claude/Codex engine `config.proxyConnectionId` refers to an enabled saved
OpenAI-compatible Model connection; its current address/key are resolved at
launch. `config.modelRoute` is a secret-free discovery projection, not an
editable credential. Selecting a missing/disabled proxy refuses launch.

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
redacted. Invalid saves return a structured 400 response. A POST whose `id`
names an existing Model connection returns 409 and changes nothing; replacing
it, including its stored API key, is a PUT.

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

Installed [Skill experiences](skill-experiences.md) use this same foreground
route when their inventory advertises `executionContract: "1.0"`. The optional
`skillExperience` selection contains pinned identity, scalar inputs, canonical
attachment-index assignments and an expected previous invocation event. Project
Environment defaults resolve normally; this contract refuses remote forwarding.
`GET /api/orchestration/sessions/:threadId/skill-experience` returns immutable
current/history presentation tied to actual canonical turns. Rich reads and
question answers bind `{identity, eventId}` in `expectedSkillExperience` and hold
the current package grant; ordinary user controls omit that frame admission.
See the [Session API](session-api.md#visual-skill-presentation) for ownership and
unavailable-history behavior.

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
Agent, model, and date aggregates. Active reads rebuild the retained snapshot
at most once a minute, sharing an in-flight rebuild with other readers.
`snapshot.rescannedAt` identifies the completed source scan;
`snapshot.engineUsage` distinguishes available, unavailable, and unconfigured
engine sources, and `snapshot.skippedMessages` counts unreadable message rows.
`snapshot.missingMessageCosts` counts saved assistant/usage rows without a valid
cost, while `snapshot.costCoverageChecked` becomes false after incremental
writes or enrichment until a rebuild. `snapshot.retainedUsage` flags retained
message, token or cost totals larger than the currently rescanned corpus
(ignoring cost rounding differences).
A completed scan does not prove historical totals or every provider's accounting
are complete. The date map is `byDate`, not `byDay`.
Optional `from`/`to` date strings filter `byDate` and add `rangeSummary`; other
fields retain their existing aggregate scope. Do not relabel those other fields
as totals for the selected window.

### Read Usage Receipts and Rollups

`GET /api/analytics/usage-rollup` reads authorized canonical observations, with
an exact 7-, 14-, or 30-day Station-observation window. `days` defaults to 14;
`from` and `to` can supply the exact window. `groupBy` accepts `provider`,
`model`, `station`, `conversation`, `task`, or `day`. `pageSize` accepts 1–100;
`cursor` advances the receipt drilldown without changing the aggregate.
`localOnly=1` excludes configured peer Stations. The normal response is
`{success: true, data: {window, rows, coverage, receipts, nextCursor?}}`.

The local aggregate selects at most 500 usage observations independently from
the page. Source observation limits and the separate global 500-logical-receipt
limit are disclosed as partial coverage. `localOnly=1&includeAggregate=1`
adds bounded `aggregateReceipts` for leaf Station transfer, after logical
replacement/deduplication. Context occupancy alone does not produce a token
receipt or consumed-usage coverage.

Cumulative token identities survive engine-process restarts. A cumulative cost
identity spans one running total: a resumed Claude process continues its
predecessor's total, while a restart without resume or a lower figure starts
another. `sourceSequence` orders
same-Station/thread observations when ingestion timestamps tie. Sparse
cumulative updates retain earlier measured dimensions; unsupported combined
model/pricing attribution stays unknown or unpriced. The window records
observations, not a billing statement or precise consumption dates. See
[Profile measurement scopes](../guides/monitoring.md#profile-usage-and-paired-people).

### Get Achievements

`GET /api/analytics/achievements` returns
`{success: true, data: achievements}` from the same refreshed aggregate snapshot. The achievement
schema and unlock rules belong to that owner, not a fixed list in this page. Cost
milestones with unavailable measurement carry `measurementUnavailableReason`,
omit numeric progress, and remain locked; a reported zero remains eligible.

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
(see [attachment storage](config.md#chat-attachments)). The route requires the
`orchestration:read` pairing tier.

The response deliberately **does not name the image's type**: the store is
addressed by bytes alone and holds no MIME type, and two attachments with
different declared names can share one digest. The declared type lives on the
attachment metadata in the event, and the client applies it when it builds the
Blob. The response uses `application/octet-stream` and `nosniff` to request
inert handling rather than serve the caller-supplied MIME type as active content.

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

Every JSON response the runtime writes itself, success or refusal, carries the
response header `x-station-envelope: 1`
(`STATION_ENVELOPE_HEADER` in `@kontourai/station-contracts/http`), and CORS
exposes it. Because there is no universal envelope, a reverse proxy or gateway
can answer with JSON in a Station shape; the header is how a client tells
Station's own answer from one written in between. The header is set by
[one middleware](../../src-server/runtime/bootstrap/runtime-http.ts) around
every handler. The refusals Station writes outside that app set it
themselves: the [virtual application ingress](../../src-server/services/connections/virtual-application.ts)
(its admission refusals, and the 502 that replaces an app answer which tried
to set a cookie) and the self-hosted broker's
[gated application](../../src-server/runtime/bootstrap/self-hosted-broker-pion-runtime.ts)
(retired trust, forbidden origin). It
describes one hop: a response relayed from another Station through
`fetchRemoteStation` leaves without it. Non-JSON bodies (event streams, files,
plain text) do not carry it. A Station older than the header never sends it,
so its absence proves nothing about such a Station.

The SDK treats a missing header as "not Station's answer" only for an origin
that has already sent it, and forgets an origin when its credential changes
or the client switches Station. One case it cannot tell apart: Stations of
different versions behind one origin (a rolling deploy, or a downgrade). Until
the origin is forgotten, the older Station's refusals read as an
intermediary's, so a queued chat message is retried instead of dropped and may
be refused again on each retry until a reload. That fails toward retrying,
never toward dropping a message.

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

`theme` is the white-label override surface: flat `--k-*` keys that are
expanded into both modes, and optional `dark` / `light` objects that override
per mode. The route passes it through unvalidated. The
[UI validation](../../src-ui/src/lib/branding-theme.ts) applies it only if
every key is one of `--k-brand`, `--k-brand-contrast`, `--k-action`,
`--k-action-contrast` or `--k-focus`, every value is `#rgb`/`#rrggbb`, and
every check from the "White-label overrides" section in
[`@kontourai/ui`'s DESIGN.md](https://github.com/kontourai/ui/blob/main/DESIGN.md#white-label-overrides)
(the package's `validateBrandOverride`) and Station's stricter text checks
pass in both modes; otherwise it applies none of it and keeps the default.
The rules and a worked provider are in
[examples/custom-branding](../../examples/custom-branding/README.md).

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

A row whose `installationReadiness.state` is `ready` also carries `commands`
(the validated command declarations, possibly empty) and an opaque
`installationGeneration`. A plugin command request echoes that generation; it
identifies the exact installed content and grants nothing. A pending or
unavailable installation omits both fields. When the manifest's command
declarations failed validation, `commands` is empty and
`commandsRejected: { reason }` says why; the plugin itself still loads.

### Plugin Command Effects

```http
POST /api/plugins/:name/command-effects
POST /api/plugins/command-effects/settlements
GET  /api/plugins/command-effects/withdrawals
GET  /api/plugins/command-effects/withdrawals/:id
POST /api/plugins/command-effects/withdrawals/:id/resolve
GET  /api/plugins/command-effects/uncaptured
POST /api/plugins/command-effects/effects/:effectId/abandon
```

A plugin command row in the palette grants nothing. Before a browser document
applies an argument-free `navigate` or `seed-composer` command it asks Station
to admit the effect. The
[command effect routes](../../src-server/routes/plugins/plugin-command-effect-routes.ts)
and [effect ledger](../../src-server/services/plugins/plugin-command-effects.ts)
own these results:

A `navigate` effect follows the built-in palette's destination behavior. A
region-surface destination (`home` or `activity`) opens as its `main` page
through the RegionModel; this is a synchronous action and does not enter
`navigate()`'s asynchronous guard flow. Route destinations use the ordinary
navigation guard predicate before navigation; a guard that would block the
route settles the effect as `aborted` with a notice instead of opening the
asynchronous discard dialog.

```json
{
  "documentId": "document-4f2c9a",
  "documentKey": "<random per-document secret, 32-256 base64url characters>",
  "requestId": "request-0001",
  "issuedAt": 1789600000000,
  "installationGeneration": "<from GET /api/plugins>",
  "commandId": "my-plugin.open-plugins",
  "target": { "kind": "destination", "destinationId": "plugins" },
  "context": { "projectSlug": "demo" }
}
```

`200` returns `{ "success": true, "receipt": { effectId, requestId, pluginId,
commandId, installationGeneration, effect } }`, where `effect` is what Station read from
the installed declaration (`navigate` with a destination id, or
`seed-composer` with a session id and text).

- **Identity.** Admission is idempotent on `documentId` + `requestId` within
  the caller's principal and `documentKey`; another principal or document key
  never collides with it.
- **Request window.** `issuedAt` is the document's clock in epoch
  milliseconds. A request more than five minutes from Station's clock, in
  either direction, is refused with `request-expired`.
- **Visibility.** A plugin the caller cannot see answers exactly as an absent
  one (`404`).
- **Person only.** Admission uses the
  [person-approval predicate](../../src-server/routes/plugins/plugin-person-approval.ts):
  internal agent tools and unconfirmed person-device callers receive `403`
  with `code: "person-approval-required"`. An unresolved principal returns `400`.
- **Requirements.** `active-chat` and `session` are satisfied only by a session
  the caller can read (the same predicate every session read uses); one it
  cannot read is `requirement-not-satisfied`, exactly like one that does not
  exist. `project` and `task` are checked against existence, the same authority
  Station's project and task routes answer any caller with.
- **Refusals.** `409` with a `reason`: `request-expired`,
  `generation-changed`, `command-not-declared`, `command-not-executable`,
  `target-mismatch`, `requirement-not-satisfied`, `permission-unavailable`,
  `capacity`, `cancelled`, or `request-conflict`. `400` is `invalid-request`;
  `503` (`unavailable`) means the ledger, grants, plugin visibility or a
  requirement check could not be read, or the admission's audit event could
  not be published.
- **Capacity.** At most 16 outstanding effects per principal, 8 per plugin and
  64 in total. A full bound refuses new admissions with `capacity`; it never
  evicts an outstanding effect.
- **Hosted deployments** refuse every route here with `403`.

The document reports how it ended each effect with
`POST /api/plugins/command-effects/settlements` and
`{ documentId, documentKey, items }`, where `items` holds 1 to 16
`{ requestId, effectId?, outcome }` entries with distinct `requestId`s and
`outcome` is `applied`, `aborted`, `cancelled` or `abandoned`. A malformed
body returns `400`. Per-item results:

| Status | Meaning |
| --- | --- |
| `settled` | This item recorded the effect's first terminal state. |
| `already-settled` | The same outcome was already recorded. |
| `cancel-recorded` | No admission exists yet (a `cancelled` without `effectId`); a later admission of that request is refused. |
| `cancel-refused` | No admission exists and this document's cancels are at capacity. Nothing was recorded; retry once the admission lands. |
| `recorded-late` | The operator already closed the effect; the first such report is recorded and audited as late, never applied. |
| `conflict` | A different terminal outcome was already recorded. Any conflict makes the response `409`. |
| `not-found` | No effect for this principal, document key, document and request, or the `effectId` does not match. |

A recorded cancel is kept for ten minutes (twice the request window): after
that no admission it could match can still be accepted. At most 16 cancels per
principal and document key, 64 per principal and 256 in total are kept; a new
cancel past a bound is refused rather than displacing one.

#### Withdrawal on lifecycle changes

Removing, updating or installing over a plugin (through `/api/plugins`,
`/api/registry/plugins`, or a plugin-backed `DELETE /api/registry/agents/:id`
or `DELETE /api/registry/layouts/:id`), and withdrawing `plugin.server` from it
(revocation, a grant or host approval against changed content), capture the
plugin's outstanding effects. The change commits at once and is never refused
or rolled back because of command effects.

- When the change captured something, the response carries
  `commandEffects: { withdrawalId, status, outstanding }`, and
  `dependencyCommandEffects` lists the same summary for dependencies the change
  removed. After releasing its locks the route waits up to two seconds for
  settlements; a response that would otherwise be `200` is `202` if any
  captured effect is still outstanding then.
- **One open withdrawal per plugin.** A later change to a plugin whose
  withdrawal is still open joins it: its newly captured effects and its cause
  are added and the same `withdrawalId` is answered. A completed or closed
  withdrawal is never reopened; a later capture starts a new one.
- When the withdrawal could not be recorded (the ledger cannot be read or
  written), the change still commits and the response is `202` with
  `commandEffectsUnavailable: true` and no summary. That is never completion.
- `status` is `completed` (every captured effect settled with document or
  Station proof), `winding-down` (effects outstanding, newest capture younger
  than 60 seconds), `indeterminate` (still outstanding after 60 seconds; not
  terminal) or `closed-indeterminate` (an operator resolved this withdrawal and
  accepted that its outstanding effects' outcomes are unknown; never a
  completed state, and a later document report is still recorded as late).
- A host approval carries the summary in its `reconciliation` projection.
  `GET /api/plugins/host-approvals/:id` re-reads it from the ledger, and the
  reconciliation never reads `completed` while the effects are outstanding
  (`winding-down`); a closed-indeterminate withdrawal makes it `incomplete`
  with a `command-effects` failure stage, as does one that could not be
  recorded.

The operator (every other caller receives `403`) lists withdrawals — every
open one, then the 16 most recent closed ones — and reads one (at most 16
outstanding effect ids).
`POST /api/plugins/command-effects/withdrawals/:id/resolve` (person only) with
`{ "disposition": "accept-indeterminate" }` is accepted only for an
`indeterminate` withdrawal (`409` otherwise) and abandons exactly its
outstanding effects.

`GET /api/plugins/command-effects/uncaptured` lists outstanding effects no open
withdrawal captured, with `abandonable: true` once one is older than 60
seconds. `POST /api/plugins/command-effects/effects/:effectId/abandon` (person
only) abandons such an effect: `404` when it is not outstanding, `409` with `reason: "captured"`
(and its `withdrawalId`; resolve that instead) or `reason: "too-recent"`.

Admissions and settlements are also recorded as
`station.plugin-command.execution/v1` operational events carrying `effectId`,
`principalId`, `pluginId`, `installationGeneration`, `commandId`, `target` and
`outcome` (never effect content), plus `settledBy` for a settlement and
`disposition: "conflict" | "late"` for a report that did not become the
effect's state. The ledger is written first: a crash between the two can leave
a recorded admission or settlement with no event.

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
`reconciliation`, plus [command effect withdrawal](#withdrawal-on-lifecycle-changes)
fields when revoking `plugin.server` captured outstanding effects.

`winding-down` returns 202. A terminal `completed`, `superseded`, or `incomplete`
reconciliation returns 200 unless withdrawn command effects are still
outstanding or could not be recorded, which returns 202. HTTP success alone
does not prove all cleanup completed. An unavailable grant store returns 503. The
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
| `/api/plugins`, plugin command admission, Project Pane catalog, layout pickers, Registry layouts, Home-role candidates/holder | Projected for the calling principal |
| Project layout list/detail | Projected with retained user-record text |
| Plugin update checks/reload, command-effect withdrawal and uncaptured-effect reads, Registry plugin available/installed lists, Registry Agent/integration installed lists | Instance operator only |

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
consent information. When an open install proposal names the source, preview
copies a local folder without its `.git` entries, refuses a local Git repository
URL, and reports `gitMetadata: "excluded"`. A folder once installed that way
stays stripped: Station records it in `plugin-source-staging.json`, so later
previews exclude its git metadata after the proposal resolves or the plugin is
uninstalled. An unreadable record fails closed.

A source-fetch refusal can be HTTP 200 with `valid: false`; inspect the body.
Invalid manifests/context or unsupported dependencies return 400; a missing
registry entry returns 404; changed registry source or trust refusal returns 409.
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
it, which means unknown. A persisted install awaiting activation returns 202
with `success: false` and `configurationActivation`, or a pending lifecycle
receipt. It is not complete solely because the HTTP request was accepted.

Consent echoes the preview's `gitMetadata`. When an open install proposal names
the source, or Station previously installed it without its git metadata, and the
approving preview kept git metadata, install returns 409 with
`consent.reason: "git-metadata"`; preview again and install from that preview.
Missing/mismatched consent returns 400, registry trust or diagnosed content-lock
conflicts return 409, and unexpected/compensation failure can return 500.
A dependency refusal is not a promise that no earlier staged/dependency effect
occurred; the [transaction owner](../../src-server/services/plugins/plugin-install-transaction.ts)
records compensation and retained-state limits.

### Check for Plugin Updates

`GET /api/plugins/check-updates` is operator-only. It reads installed names and
checks git/registry update sources. Results use the installed manifest name as
`name`, even when a registry entry ID differs. A caught top-level check failure
currently returns 200 with `{updates: []}`; that legacy result cannot prove
there were no available updates.

### Update Plugin

`POST /api/plugins/:name/update` uses the person-approval predicate and resolves
the installed identity/current generation. A managed installation selects new
retained code with `dataPolicy: "preserve"`; this is not an in-place `git pull`
of its selected bytes. Its update path supplies no new operator consent, so
changes requiring a preview decision must be completed through preview/install.
Missing update source or managed update refusal returns 409; pending lifecycle
or activation returns 202.

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
A pending activation returns 202 with `success: false` and its receipt. Inspect
the outcome before retrying or declaring cleanup complete.

### Serve Plugin Bundle (JS)

`GET /api/plugins/:name/bundle.js` returns JavaScript with `Cache-Control: no-cache`
when the [bundle reader](../../src-server/routes/plugins/plugin-bundles.ts) can
capture current, contained bytes. Unavailable/missing bytes return 404.

### Serve Plugin Bundle (CSS)

`GET /api/plugins/:name/bundle.css` returns text/css for present bytes. The current
handler returns an empty 200 when its reader returns no CSS, including unavailable
reads. That result is not proof of a complete CSS-free installation.

### Get Plugin Permissions

`GET /api/plugins/:name/permissions` returns `declared`, `granted`,
`contentBinding`, and `withheld` for the captured installation. Missing runtime
artifact returns 404; unreadable grants return 503.

### Grant Plugin Permissions

`POST /api/plugins/:name/grant` accepts `{permissions: [...]}` for declared,
grantable permissions. Trusted permissions require the isolated host approval
channel and are refused here with 403. An accepted response can include
`granted`, `withdrawn`, and reconciliation: binding a new decision can withdraw
old permissions, so a grant request is not necessarily an additive-only effect.
Winding reconciliation returns 202.

### Plugin Fetch Proxy (Scoped)

`POST /api/plugins/:name/fetch` is currently disabled. It checks the named
`network.fetch` grant, then returns 403 because plugin execution identity is not
yet verifiable. A grant does not make this endpoint an operational HTTP proxy.

### Unscoped Plugin Fetch Proxy

`POST /api/plugins/fetch` returns 403 requiring a named route. The development CLI
proxy is a separate implementation; neither production route provides the
successful proxy response previously shown here.

### Reload Plugin Providers

`POST /api/plugins/reload` is operator-only. It reconciles installation
projections, quiesces server modules/subscriptions, prepares and publishes the
provider generation, and reconciles Agent state. A pending projection or runtime
activation returns 202 with `success: false`. Completed responses include
`loaded`; a failed quiescence/reload returns 500. It is not a raw unconditional
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
not itself reload providers. Current-artifact checks can return 409, including
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
Otherwise it calls the Agent registry provider (which copies a plugin tree into
the plugins directory, so a paired device needs the `coding:exec` grant here
too) and returns its result. A
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
credential-binding configuration can refuse replacement with 409. Provider
installation success does not prove connection, enablement, or Agent attachment.

### Uninstall Integration from Registry

`DELETE /api/registry/integrations/:id` returns the provider's uninstall result.
After provider success it attempts to delete the local definition; that deletion
error is currently caught, so success is not proof that local cleanup completed.

### Sync Integration Registry

`POST /api/registry/integrations/sync` awaits provider sync and returns
`{success: true}`.

### Manage marketplaces

`GET /api/registry/sources` lists connected sources for the Station operator.
All source-management methods require `access:manage` credential scope as well
as the operator principal check. Ordinary catalog browsing retains its read
scope; a standard paired credential cannot enumerate host source configuration
or trigger source refresh.
`POST /api/registry/sources` accepts `{displayName, adapter, location}` where
`adapter` is `directory`, `github` or `manifest`. Directory and local manifest
locations are absolute paths on this Station. Public GitHub repository URLs use
its default branch and discover nested directories containing `SKILL.md`.
Manifest URLs require HTTPS. Credentials in URLs are refused; private sources
and other index formats need a future credential-aware adapter.

`PATCH /api/registry/sources/:id` accepts `{enabled}`;
`POST /api/registry/sources/:id/refresh` returns current status;
`DELETE /api/registry/sources/:id` removes a user-added source. Installed
packages and their historical attribution remain. Plugin-owned sources are
managed through the plugin's existing enable/disable/revoke lifecycle.

[The source manager](../../src-server/providers/registries/registry-source-manager.ts)
keeps versioned configuration and last successful catalog snapshots in
`config/registry-sources.json`: a regular file bounded to 8 MiB, 32 user-added
sources and 32 retained snapshots, each with at most 512 rows. Corrupt,
unsupported, oversized and nonregular configuration is refused without
replacing the existing bytes. Offline plugin rows use current local installed
inventory and source ownership aliases. Provider visibility and generation fences remain
owned by the existing provider registry. Source status is `ready`, `stale`,
`error`, `disabled` or `unknown`; it includes checked/last successful times and
an explicit error when refresh fails. Cached data is discovery evidence;
installation always revalidates the selected source.

### List Available Skills (Registry)

`GET /api/registry/skills` preserves same-name entries from independent sources.
Each item has `catalog: {sourceId, itemId, revision, kind}` and an opaque `id`
that clients pass unchanged to inspect/install. `catalogSourceName` is the
host's source label; `source` retains the provider's original attribution.
The response includes per-source status and `partial: true` when a source fails.
Successful independent results remain visible. A cached snapshot is marked
`stale`; when every available source has failed and there is no snapshot,
the response is 503 with `success: false`, rather than an empty successful list.
A successful empty catalog from an independent source remains a successful
partial observation; source availability is determined from the read outcome,
not its row count. Plugin catalogs use the same failure and partial-result rule.

The built-in [GitHub Skill provider](../../src-server/providers/registries/github-skill-registry.ts)
resolves a branch to one immutable commit/tree and verifies blob hashes.
Discovery supports nested Skill directories and refuses ambiguous names,
truncated trees and unreadable required files. Its budgets are 512 Skills,
8192 tree entries, four concurrent Markdown reads, 1 MiB per blob and an
8 MiB blob budget per discovery/acquisition. Each commit/tree JSON response
has a separate 2 MiB bound. Operations have a 60-second ceiling and requests
have a 15-second ceiling. An installed package has at most 256 files. Portable path checks and
exclusive staging-directory/file creation still refuse filesystem aliases.
These checks do not qualify Windows/native execution.

Readable reserved-name and unsupported-format documents remain inspectable with
`unsupported-skill-name` or `unsupported-skill-format`; installation is refused.
Inspection uses `GET /api/registry/skills/:id/content` with the opaque selection
ID and returns the original instructions. Bad required metadata, duplicate
names, unsafe names and incomplete discovery fail the source rather than
silently hiding entries. A bare name is supported only when one source matches.

### Install Skill from Registry

`POST /api/registry/skills/install` accepts `{id}` and returns SkillService's
result. It attempts a Skill reload after success; a caught reload failure does
not change the install result. `prototype` and `constructor` return a 400 envelope
with `code: "unsupported-skill-name"` before SkillService or staged filesystem
effects. `__proto__` is rejected by the route's directory-name schema with its
ordinary validation 400 envelope before the custom reserved-name code runs. The
provider and SkillService retain their independent storage-name guards.

An unsupported-format package raises a typed refusal at the GitHub acquisition
owner before package bytes are written. Existing SkillService cleanup removes its
transient stage; the API returns 400 with `code: "unsupported-skill-format"`, without
a published or leftover package. An empty parent directory can remain. A local source can still install while an
independent GitHub source is offline. Refusing the selected source never tries
an alternative with the same name.

SkillService copies the selected complete directory, including binary assets and
executable files, through its existing validated staging/publication path. It
revalidates the selected catalog/package revision before publication. Changed
sources return 409 and require fresh inspection; blob/path/acquisition failure
prevents publication. The install record retains source ID, item ID, catalog
revision, source location, installed tree digest and installation time under
`provenance.catalog`. Ordinary same-name installation remains a conflict.
Only files inside the selected directory are copied; sibling references do not
automatically install another Skill. Packages with multiple Skills/dependencies
use ordinary Agent Plugin packaging and its existing dependency lifecycle.

`POST /api/registry/skills/:id/update` resolves the installed provenance to the
same current source, stages/validates the replacement, and retains the existing
package on refusal. A missing source or provenance cannot choose another source.
The marketplace's Open skill action returns to the existing installed Library.

### Uninstall Skill from Registry

`DELETE /api/registry/skills/:id` returns SkillService's removal result and uses
the same reload behavior. Package-owned read-only Skills retain their owner's
mutation rules.

### List Available Plugins (Registry)

`GET /api/registry/plugins` is operator-only and returns
`{success: true, data}` with catalog installation status.

### List Installed Plugins (Registry)

`GET /api/registry/plugins/installed` retains the existing registered-provider
availability projection. Managed marketplace installation is reflected on
`GET /api/registry/plugins`; the canonical installed inventory remains
`GET /api/plugins`. These plugin reads are operator-only where specified by
the existing visibility owner.

### Install Plugin from Registry

`POST /api/registry/plugins/install` resolves a source-qualified selection to its
exact current provider/catalog revision (legacy IDs still require a unique match)
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
person-gated removal transaction. Pending runtime activation returns 202 with
`success: false` and `configurationActivation`; normal completion returns 200.

---

## Scheduler

The [scheduler routes](../../src-server/routes/operations/scheduler.ts) call
[SchedulerService](../../src-server/services/scheduling/scheduler-service.ts),
which aggregates registered providers and routes job operations to their owner.
This personal scheduler surface returns 404 in hosted mode. Typed invalid
schedules return 400, conflicts 409, unavailable durable storage 503, and other
thrown failures 500.

### List Scheduler Providers

`GET /scheduler/providers` returns `{success: true, data}` where each row has
`id`, `displayName`, `capabilities`, and `formFields`. It is not an array of
provider-name strings.

### Subscribe to Scheduler Events (SSE)

`GET /scheduler/events` relays serialized scheduler events and sends named
`ping` keepalives every 30 seconds. The provider/event owner determines the event
payload; a live frame is not a durable completed-run receipt.

### Scheduler Webhook Receiver

`POST /scheduler/webhook` accepts JSON and broadcasts it through SchedulerService,
returning `{success: true}`. Invalid JSON returns 400. This is an authenticated
route under the scheduler policy, not a public arbitrary-event ingress or an
instruction to execute a job.

### List Scheduled Jobs

`GET /scheduler/jobs` returns `{success: true, data: jobs}`. Rows use the
[SchedulerJob contract](../../packages/contracts/src/scheduler.ts), including
job `name` and provider-neutral schedule information. Provider read failures
propagate rather than becoming a fabricated empty schedule.

### Get Scheduler Stats

`GET /scheduler/stats` returns `{success: true, data: {providers, summary}}`.
Summary includes total jobs, total recorded runs, and a rounded success-rate
percentage derived from provider job statistics (zero when no runs exist).

### Get Scheduler Status

`GET /scheduler/status` returns `{success: true, data: {providers}}`. Each entry
contains the provider's status plus its ID and display name; this is not one
universal `{running, provider}` object.

### Preview Cron Schedule

```http
GET /scheduler/jobs/preview-schedule?cron=0%209%20*%20*%20*&count=5&timezone=America%2FDenver
```

`cron` is required, count defaults to 5, and timezone is optional. The shared
schedule validator rejects invalid expressions/zones; the service uses
Ephemeris to return ISO timestamps under `{success: true, data}`. An omitted
zone uses the scheduler's UTC interpretation. Include a zoned job's timezone
when previewing it.

### Get Job Logs

`GET /scheduler/jobs/:target/logs?count=20` returns `{success: true, data}` from
the owning provider. `providerId` can select the provider explicitly; count
defaults to 20. These are provider run-log records, not arbitrary server log
files.

### Read Run Output

The old `/scheduler/runs/output` path is not registered. Use:

```http
POST /api/runs/output
```

Send the **RunOutputRef returned by the run**, with `source`, `providerId`,
`runId`, `artifactId`, and `kind`; do not send a filesystem path.
[RunService](../../src-server/services/orchestration/run-service.ts) currently
reads scheduled output on this path. SchedulerService resolves the reference
back to the recorded run/artifact and asks that provider to read it. Hosted
scheduled output is unavailable. A readable result is
`{success: true, data: {content}}`; a missing supported result returns 404,
while typed storage failure returns 503. Other malformed/unresolvable references
can reach the handler's 500 error path.

### Create Job

```http
POST /scheduler/jobs
```

```json
{
  "name": "daily-summary",
  "prompt": "Summarize the project status.",
  "agent": "station",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "timezone": "America/Denver" }
}
```

`name` and `prompt` are required. Use either legacy `cron` or the `schedule`
union, not both. Other schedule variants are `{kind: "every", everyMs}` and
`{kind: "at", timeMs, deleteAfterRun?}`. The
[request schemas](../../src-server/routes/schemas/schema-definitions/scheduler.ts)
apply prompt limits and schedule validation. The response is
`{success: true, data: {output}}`, where output is the provider's result text;
it is not proof that a future run completed.

### Update Job

`PUT /scheduler/jobs/:target` accepts supported partial job options, including
that schedule union, and returns `{success: true, data: {output}}`.

### Run Job Now

`POST /scheduler/jobs/:target/run` awaits the service's manual-run result.
Current receipts distinguish `completed`, `failed`, `refused`, `deferred`, and
`indeterminate`. The response retains `data.output` for older clients and adds
`data.receipt` only when it has a nonempty canonical run ID.

Completed runs return 200. Deferred and indeterminate runs return 409 with their
respective codes; failed/refused outcomes return 422. An indeterminate result
means work may have started: inspect its run rather than automatically replaying
the request.

### Enable Job

`PUT /scheduler/jobs/:target/enable` returns `{success: true}` after provider
enablement. It does not mean the job has run.

### Disable Job

`PUT /scheduler/jobs/:target/disable` returns `{success: true}` after disabling
future scheduling through the provider. It is not an in-flight cancellation
receipt.

### Delete Job

`DELETE /scheduler/jobs/:target` returns `{success: true}` after provider removal.
Use the [SDK scheduler client](../../packages/sdk/src/client/scheduler.ts),
`station schedule`, or corresponding station-control tools for supported
operator operations. SSE and webhook retain their separate HTTP transport roles.

### Open File with System Handler

The former `POST /scheduler/open` route is not registered. Scheduled output is
now opened in the [job-detail preview](../../src-ui/src/components/scheduler/JobDetail.tsx)
using its RunOutputRef and `/api/runs/output`; this does not ask the server to
open an arbitrary path in an OS application.

## System

The [system factory](../../src-server/routes/system/system.ts) mounts status,
update, and resource-posture handlers under `/api/system`. These are server
observations, not physical native-window or device verification.

### Get System Status

`GET /api/system/status` returns a plain status object. It includes prerequisites
and `prerequisitesState`, configured/detected providers, CLI observations,
external-engine readiness, capability summaries, recommendation, build/server
identity when available, and device presentation.

Prerequisite discovery is cached for 60 seconds and refreshed asynchronously under
a 2-second budget. `pending`, `ready`, and `stale` describe that cache. Some
legacy boolean probes collapse failure/timeout to false, so false alone is not
always an observed absence. The broad top-level `ready` is an OR of detected or
configured paths; it is not proof that the user's chosen Agent/model can finish
a chat turn. Use the more specific readiness and model evidence.

`engineId` selects engine capability semantics; `engineConnectionId` identifies
a public Agent App connection. Do not derive one from the other. See the
[status owner](../../src-server/routes/system/system-status-routes.ts).

### Verify Bedrock Credentials

`POST /api/system/verify-bedrock` (also `/api/system/verify-managed-runtime`)
performs `ListFoundationModels` with an AWS SDK Bedrock client. Its optional
body region wins over app-config region, then `us-east-1`. This legacy probe
uses the SDK's default credential resolution; it does not reproduce every
selected Model connection's auth mode.

The response is plain `{verified: true, region}` or `{verified: false, error}`.
A caught verification failure still returns 200. Successful listing proves that
request worked, not a completed inference turn or universal account model access.

### Check for Core App Update

`GET /api/system/core-update` branches on
[install provenance](../../src-server/routes/system/install-provenance.ts):
source checkout, desktop bundle, prebuilt archive, or unknown. Read
`installKind`, `applyMethod`,
server identity, provenance issue, and unavailable reason as well as
`updateAvailable`.

For a source checkout, the handler fetches upstream and compares commits. If no
upstream is set, it can fetch the current branch from origin and set its tracking
branch; this GET is not a filesystem-inert observation. No usable upstream
returns `noUpstream: true`. A failed check can return 200 with `error` and
`updateAvailable: false`; that is not proof the installation is current.
Desktop bundles check their recorded channel source; unknown provenance cannot
check or apply an update reliably. A prebuilt archive fetches the signed public
manifest its install records and verifies it against the pinned keys for its
ring (`releaseCheck`: `verified`, `unreachable`, `unverified`, or
`not-recorded`). Its `applyMethod` is `service-update` only when the fixed
service launcher supervises this server (`installKind: "archive-service"`);
otherwise it is `station-upgrade` (update on the host) or `reinstall`.

### Apply Core App Update

`POST /api/system/core-update` also branches on provenance. A source checkout
refuses supervised execution (`service-managed` or `supervised`) and conflicting
live sibling instances before update work. Otherwise it pulls fast-forward,
checks the repository-owned dependency lifecycle, installs dependencies, builds,
and schedules restart with a health watchdog. A missing installer/build failure
returns 500 **after the pull may already have landed**; it does not roll back the
checkout or claim all dependency effects were undone.

A successful source response includes `restarting: true`, hash, and an expected
instance/build/deadline receipt. It is not restart completion. Read
`GET /api/system/core-update/restart-status` for the recorded outcome.

The retained desktop-bundle apply path is macOS-only and requires the recorded
source checkout, matching origin, and owned installer. It starts that installer
detached and returns 202 with `updating: true` and a log path. That is initiation,
not installation or relaunch proof. A launcher-supervised archive writes an
update request and returns 202 with `serviceUpdate: {requestId}`; the service
stages, trials, and may roll back the release afterward, so 202 is not update
proof. It returns 409 when another update is in flight or needs an operator,
when no newer verified release this host and launcher can run is found, or for
any other archive. `GET /api/system/core-update/service-update` reads that
install's progress from its runtime files, or `{state: "unavailable"}` when the
server is not launcher-supervised. Unknown/ineligible provenance returns 409.
See the [update owner](../../src-server/routes/system/system-update-routes.ts)
for exact result branches.

### Get Server Capabilities

`GET /api/system/capabilities` returns the runtime label, WebSpeech STT/TTS
hints, geolocation/timezone context hints, `scheduler: true`, and deployment
capabilities. The voice/context entries here are fixed declarations in the
status handler, not live browser permission/API probes or discovery of every
registered voice provider. Their `configured: true` does not prove a particular
device can record or play audio.

### Discovery Beacon

`GET /api/system/discover` is a retained beacon-shaped **authenticated read**
under the current system route policy. Its handler sets a wildcard CORS header,
but the runtime's origin and credential gates run first; it is not the public
Station handshake. The body is `{station: true, name: "Project Station", port}`,
with port derived from the request URL and a historic 3141 fallback when absent.
Use the public well-known handshake for credential-free Station discovery.

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
client origin. The [approval handler](../../src-server/routes/agents/invoke.ts)
returns 404 when it cannot resolve an authorized pending request. In hosted
mode the entry must be bound to a session of the caller's tenant. Outside
hosted mode the
[registry](../../src-server/services/approvals/approval-registry.ts) lets any
caller that reaches this route settle a pending entry by its ID. The exception
is a request acting for a Project member: the
[Agent audience gate](../../src-server/runtime/bootstrap/agent-audience-gate.ts)
refuses it with `403 member_agent_turns_unavailable`.

The current [inline approval handler](../../src-ui/src/hooks/useToolApproval.ts)
uses orchestration for parts carrying an approval thread ID, including the exact
request-event identity. It falls back to this retained registry route only when
that thread ID is absent. This endpoint is not a universal responder for every
external-engine approval.

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


---

### Global Conversation Lookup

`GET /api/conversations/:id` returns `{success: true, data}` or 404 when not found.
The [lookup handler](../../src-server/routes/chat/conversations.ts) checks personal
Project storage, then file-memory adapters, then the authorized orchestration
reader. Hosted mode skips the two personal storage branches. File-memory Agent
attribution comes from the stored resource ID, with the adapter key as fallback;
response shape can also include Project and fork-provenance fields.

`GET /api/conversations/:id/read?limit=&cursor=` returns one page of a
conversation's transcript: `{conversationId, access, notice, messageCount,
messages, nextCursor}`. `limit` is 1 to 50 (default 20); anything else is
refused with `conversation_read_limit_out_of_range`, and a page's serialized
messages never exceed 64 KB. Pass `nextCursor` back as `cursor`; it is checked
only after the read is admitted. A station-control caller that is not a bound
operator is further limited to its own conversation, its scope, or a
conversation a person referenced in its conversation, and reads as the
session's owner; a bound operator keeps the operator's reach. An id Station
has no record of answers `conversation_not_found`; see the
[read route](../../src-server/routes/chat/conversation-reference-read.ts).

### Agent Conversation Title

`POST /api/conversations/:id/agent-title` with `{title}` is the route behind the
station-control `rename_session` tool. It answers only a station-control tool
call with a verified caller (anything else gets `403`
`station_control_caller_required`), and a store conversation only: a native
Claude or Codex conversation answers `runtime_title_unsupported`, and
`POST /api/search` hits are mostly those. Unless the caller is a bound operator
it reaches only a conversation the calling Session's owner owns (another
person's reads as `404`); a bound operator caller is not limited to one owner's
conversations, as with `DELETE /agents/:slug/conversations/:id`. A title is one
line of 1 to 80 characters with no control, line or paragraph separator, bidi
embedding, override or isolate, zero-width space or byte-order-mark character
(the zero-width joiner and non-joiner are allowed); anything else is a `400`,
refused rather than truncated (leading and trailing spaces are trimmed). It stamps
`titleSource: 'agent'` in the same serialized step that checks the stored title:
a title with `titleSource: 'user'` answers `409` `person_title` and is left as
it was, and a native Claude or Codex conversation answers `409`
`runtime_title_unsupported`. The success body is
`{success: true, data: {conversationId, title, titleSource: 'agent'}}`. The
person's rename stays `PATCH /agents/:slug/conversations/:id`, which stamps
`titleSource: 'user'`.

## Additional System Routes

### Get Runtime Info

`GET /api/system/runtime` returns `{runtime}` for the server's implementation
framework. It is not an inventory of external engines.

### List Skills

`GET /api/system/skills` returns `{success: true, data}` from SkillService, or an
empty list when that service is not supplied to this handler.

### Get Terminal Port

`GET /api/system/terminal-port` returns `{success: true, port}` with the runtime
base port plus 1. It reports the configured number, not proof the listener is
bound or that this caller can open a terminal.

### Get Voice Port

`GET /api/system/voice-port` returns the analogous configured base plus 2.
Provider/device capability and WebSocket admission are separate from this
number. Both handlers are in the [status owner](../../src-server/routes/system/system-status-routes.ts).

## UI Commands

### Dispatch UI Command

```http
POST /api/ui
```

```json
{ "command": "navigate", "payload": { "path": "/settings" } }
```

The [UI command handler](../../src-server/routes/projects/ui-commands.ts) accepts
a local absolute navigation path and emits `ui:navigate`. Invalid paths and
unknown commands return 400. Hosted mode refuses navigation with 403, as does a
request whose derived audience is explicitly unavailable.

In personal mode, a principal-scoped agent command addresses that principal's
clients; an unrestricted operator command can address the personal listeners.
The [event relay](../../src-server/routes/orchestration/events.ts) applies that
audience. `{success: true}` means the event was accepted, not that a client
received it or changed its screen. With no listener, acceptance can still succeed.

---

## Additional Analytics

### Clear Usage Data

```http
DELETE /api/analytics/usage
```

Returns `{success: true, message: "Usage stats reset"}` after resetting the
aggregate stats file to a valid empty accumulator. It does not delete conversations,
monitoring logs, or invocation receipts; later updates/rescans can rebuild
statistics from retained sources; the next active usage read also rebuilds it. See the
[aggregator reset](../../src-server/analytics/usage-aggregator.ts).

---

## Independent Review Evidence

The [review routes](../../src-server/routes/evidence/reviews.ts) submit and read
independent-review evidence for an exact Project Git range. Explicit reviewer
lists contain one to eight entries; the contract also supports
`selection: {kind: "repo-map"}` with an empty reviewer list for owner-resolved
selection. Do not mix the two forms.

```http
POST /api/projects/:projectSlug/reviews
```

```json
{
  "requestId": "review-operation-id",
  "mode": "initial",
  "target": {
    "kind": "git-range",
    "projectSlug": "project-slug",
    "baseRevision": "origin/main",
    "headRevision": "HEAD"
  },
  "implementerAgentSlug": "implementer-agent",
  "reviewers": [{
    "reviewerId": "reviewer-1",
    "executorAgentSlug": "reviewer-agent",
    "lens": { "id": "correctness", "instructions": "Review incorrect behavior and missing failure handling." }
  }]
}
```

The [module](../../src-server/services/evidence/review-evidence-module.ts) resolves
host-authoritative actor identities and Git revisions, provisions an exact
[detached worktree](../../src-server/services/evidence/git-review-workspace-source.ts),
and validates finding locations against the reviewed head. Read-only access is
an execution policy enforced through the
[review executor](../../src-server/services/evidence/orchestration-review-executor.ts)
and supported engine boundary, not a property inferred from the directory name.
The current runtime composition requests the executor's default Codex provider
and carries each reviewer's Agent slug as attribution; the request is not a
promise to dispatch arbitrary reviewer engines.

`requestId` is the durable idempotency identity. The envelope is
`{success: true, data: status}` for recorded outcomes: completed uses 201, running
202, rejected 400, and indeterminate 409. A completed `result` contains
`receipt`, optional Flow-evidence attachment disposition, and cleanup result.
Reviewer findings remain evidence input; the receipt is not approval, pass,
exception, or gate completion. A cleanup result can retain the workspace when
shutdown was not confirmed.

The [SDK helper](../../packages/sdk/src/client/reviews.ts) defaults each HTTP
request to 30 seconds. After submission failure it reads status; if that read
also fails, it retries the same request ID once. It polls a running status every
500 ms and honors the caller's AbortSignal. This is a per-request timeout, not a
30-second deadline for the whole review. Terminal rejected/indeterminate status
is surfaced as a typed error, not a new automatic review with another ID.

Delta mode adds `delta: {priorReceiptId, claimedFindingIds}`; every claimed prior
finding must receive exactly one assessment. Reads are:

```http
GET /api/projects/:projectSlug/reviews
GET /api/projects/:projectSlug/reviews/requests/:requestId
GET /api/projects/:projectSlug/reviews/:receiptId
GET /api/review-evidence
```

The [protected store](../../src-server/services/evidence/review-receipt-store.ts)
refuses identity collisions and capacity exhaustion rather than evicting old
evidence. The aggregate selects up to the newest 512 receipt references across
at most 256 Project slugs. Unreadable Projects appear in `unavailableProjects`;
Projects whose workspace is missing contribute no receipts. Use the returned
coverage, not an empty receipt array alone, when assessing availability.

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

### Client API protocol admission

Clients using the SDK (including CLI requests through that seam), the pairing
client, and the UI health probe declare `X-Station-Client-Protocol`. The
[protocol contract](../../packages/contracts/src/environment-security.ts)
accepts one decimal integer from 1 to 9999, without a sign or leading zero.
Absence means legacy protocol 1; a malformed value returns
`400 {error: {code: "client_protocol_invalid", message}}`.

For paired-scope HTTP routes and the public pairing request, access-request,
and exchange, a value below the advertised `minClientProtocol` returns
`426 {error: {code: "client_protocol_unsupported", message, clientProtocol,
minClientProtocol, protocolVersion, serverVersion}}` before credential checks.
Both refusals emit `station.auth.failure` with the refusal code as reason;
only the parsed protocol is recorded, never the raw header. This compatibility
signal grants no authority, and passing it does not skip authentication.
A separate direct-socket-peer audit limiter bounds emission to 10 audits per
60-second window by default, using `RuntimeAuthFailureLimiter` and its
1,024-peer cap. The cap evicts live entries, so refusals from more than 1,024
distinct peers can reset a peer's count and let it emit more than 10 audits in
one window; memory stays bounded either way. Exhaustion suppresses only audits; every refusal still receives
400/426. Protocol refusals neither consult nor consume the authentication
budget, so correcting the header permits account verification even after many
refusals from the same proxy or NAT.

The public handshake and proof remain reachable. The landing page, `/doc`,
`/ui`, and integration icons are exempt because navigation and image requests
cannot attach this header. Other capability families, attested internal
loopback callers, and the separate terminal/voice WebSocket listeners are
outside this HTTP check. Exemptions follow the capability table, not a blanket
exception for every iframe, image, or link request. See the
[admission owner](../../src-server/security/client-protocol-admission.ts) and
[threat model](../security/remote-access-threat-model.md#client-api-protocol-admission-2962).

### CORS

The running Station uses the exact browser origins assembled by
[resolveStationBrowserOrigins](../../src-server/security/station-browser-origins.ts):
configured additions, its bound-port loopback origins, native shell origins, and
specific bound-host origins. The CLI adds its UI listener origins. Other origins
are refused before route dispatch. This is not the permissive helper used when
HTTP security is absent, and it does not allow every localhost port. Origin
admission does not replace authentication or scope. See
[environment settings](env-vars.md#server).

The preflight allow-list includes `X-Station-Client-Protocol`. Cross-origin
browser callers send it only after observing
`compatibility.capabilities.clientProtocolHeader >= 1` on that host's public
handshake. The UI forgets the prior origin observation before re-handshaking;
non-OK responses, invalid JSON and transport errors leave it cleared.
Older or unobserved hosts receive an unlabelled request, interpreted
as protocol 1. Same-origin requests, Node callers and host-owned transports
can carry it without that preflight condition.

---


## Engine accounts and usage

`GET /api/connections/agent/:id/accounts` projects the default account plus saved
profiles for Claude and Codex: opaque references, labels, CLI-verified auth state,
observed login mechanism and the account in use. It requires `engine:login`,
credential-management access or a verified operator. It returns no paths,
commands, environment or CLI diagnostics.

`GET /api/connections/agent/:id/account-usage?profileRef=<ref>` reads only the
selected profile's provider quota. Omit the reference to inspect the connection's
default account. This token-backed read requires `access:manage`; an engine-login
grant alone does not admit it. The result is either normalized quota windows,
plan, fetched time and provider exhaustion verdict, or an explicit unknown reason.
Both variants can include optional `metadata`: Codex identity/credits/model and
reset-credit facts, Claude extra usage/spending/weekly breakdown/limit annotations, and bounded response-shape `capture`
(source, credential storage kind, unmapped/excluded field paths, truncation). Windows optionally carry
`durationSeconds`, `resetAfterSeconds`, `allowed`, `limitReached`, `model` and
`meteredFeature`. Raw response values for unmapped fields are never returned;
full quota metadata is not persisted; only bounded allowance observations are retained. See the [capture inventory](../guides/connections.md#sign-an-engine-profile-in-from-a-device)
for scope and live-verification limits.

The optional `history` contains bounded hourly allowance observations for the
selected profile. `status: unavailable` reports persistence failure without
making the live limits unreadable. Full metadata and identity remain live only.

`GET|POST|DELETE /api/connections/agent/:id/account-login?profileRef=<ref>` requires
an existing saved profile and `engine:login` or a verified operator. No default
account login is admitted. POST `{}` starts the observed provider-owned login;
POST `{code}` relays a Claude browser code to its CLI stdin. GET projects status;
DELETE cancels. The server checks current authority before private work and
publication. Credentials and private CLI output are never returned. Refused
starts return a safe reason, with Codex outcomes when available.


`GET /api/analytics/usage-rollup?provider=codex&credentialProfileRef=<ref>` filters
attributed account receipts before aggregation. An empty `credentialProfileRef`
selects the default profile; omitting it includes all accounts. An engine filter
is required. Older/source-home usage without `accountKey` remains unattributed.

`GET /api/analytics/usage-rollup` accepts `provider=claude|codex` and `localOnly=1`
for engine activity. Filtering precedes folding and pagination, while coverage
remains explicit. Without a credential-profile filter, this is Station engine
history across accounts. A profile filter selects attributed receipts and
excludes unattributed usage; neither view is a provider billing statement.

## Read engine sign-in profiles

```http
GET /api/connections/agent/:id/device-code-profiles
```

This dedicated read requires a paired device's explicit `engine:login` grant
or a verified Station operator credential. It returns
`{success: true, data: {profiles: [{ref, label?, authState, mechanisms}]}}`.
`authState` is `authenticated`, `unauthenticated` or `unknown`; `mechanisms`
contains only observed `device-code` support. References and labels identify
existing profiles, not provider account identity. Host paths, commands,
environment variables, recovery policy and diagnostic details are excluded.

Authority is rechecked around awaited reads and before publishing the result;
revocation refuses an in-flight read. Profile management and manual enrolment
retain their separate authority requirements. The operator exception covers
only this read and GET/POST/DELETE of the existing profile device-code login
leaf; it does not add `engine:login` to the operator's default scope set.
See [profile sign-in](../guides/connections.md#sign-an-engine-profile-in-from-a-device).

## Opt-in native Device proof binding management

```http
GET /api/pairing/native-device-bindings/:bindingId
POST /api/pairing/native-device-bindings/:bindingId/approve
```

The native proof pilot mounts these routes only when its supported provider and
native connector are configured. Both require a current operator credential and
the `access:manage` tier; Device credentials, native proofs, account membership
and home possession cannot approve a binding.

POST accepts `{operation: "create" | "revoke", candidate}` with the exact
`NativeDeviceBindingCandidateV1` tuple and matching path ID. GET projects public
historical binding data plus `currentDeviceBinding`, which says nothing about
account or Project authority. Responses use `Cache-Control: no-store`. Missing
readback does not establish cancellation of an ambiguous approval request.
See [deployment authentication](../guides/deployment-authentication.md)
for the pilot's scope and remaining native-client limitations.

The same opt-in composition mounts a separate
[protected Device self-read](../../src-server/routes/system/native-device-proof-self-receipt-routes.ts):

```http
GET /api/auth/native-device-bindings/:bindingId/receipt
HEAD /api/auth/native-device-bindings/:bindingId/receipt
```

It requires the owning, currently paired ordinary Device's bearer and
`orchestration:read`; an account-bound Device can read before account sign-in.
Operator credentials, cookies, delegation grants and native request proofs do
not substitute for that bearer. The `NativeDeviceProofSelfReceiptV1` response
contains only the public binding tuple, historical approval/revocation state
and current Device-binding status. A missing ID and another Device's ID both
return `404 not_found`; corrupt storage returns `503 unavailable`. Responses
are not cached. Revoking the Device bearer removes self-read access, while
binding revocation or replacement remains observable by its active owner.
This read grants no account, Project or runtime authority and does not activate
a native client or authorize provisional-key deletion after an unknown outcome.
Endpoint errors include `error.version =
station-native-device-proof-self-receipt-error/v1`. Only this versioned
`not_found` response establishes a binding lookup absence; an unrelated route
or proxy error is an unavailable observation.

The desktop and mobile [native relay owner](../../src-desktop/src/native_relay_redemption.rs)
also registers the main-window `station_native_device_binding_self_receipt`
command. Its inputs are only a saved profile name and expected revision; it
reads the fixed endpoint using the current host-authorized Device bearer and
compares the complete candidate tuple. Results distinguish fresh Station
receipts from cached observations; cached positive history is
`previously-confirmed-current` with its original observation timestamp.
The command preserves the key on missing or unknown outcomes. The host peer and
account owners require its positive current-owner observation, while ordinary
route selection does not invoke it automatically. Source registration is not an
executed native IPC or packaged acceptance receipt.

The [peer owner](../../src-desktop/src/native_application_peer.rs) registers
prepare/open/read/sign/close commands. The host mints the nonce and handle,
verifies the exact Station-signed transcript and permits one bounded Device
request proof. The renderer supplies no identity claims, hashes, signing input
or connected assertion. Browser RTC remains renderer-owned.

The separate [account owner](../../src-desktop/src/native_account_operations.rs)
registers challenge/key preparation, complete local username/password exchange
body preparation, canonical GET/HEAD member-read account headers, and fixed
invitation-acceptance and native-continuation revocation requests. It constructs
account claims using independent key custody and current host owners, with
bounded one-exchange handles, replay/expiry and post-sign key fencing. These
structured commands do not mint a principal or replace the server's current
provider/Device/Project checks. See [native account continuation](sdk.md#native-station-account-continuation-opt-in)
for the typed provider and account-body-before-Device-signing ordering.

The selected native relay member route permits only bounded Station observations
and Project/shared-work reads, plus its fixed account operations. Ordinary SDK
mutations are refused; operator and compute surfaces are unsupported. Native
continuation revocation retires that continuation and its provider session,
without retiring Device custody. These are source-composed contracts, not a
fresh native enrollment, physical-device, or published application receipt.

A separate `STATION_NATIVE_ENROLLMENT_PILOT=1` composition mounts the seven
`POST /.well-known/station/v1/relay/native-enrollment/` leaves: `begin`, `login`,
`register`, `finalize`, `activate`, `status`, and `cancel`. The runtime requires
the Device-proof pilot, configured native relay and supported pending account
provider. Private current Pion provenance and an approved native installation
surface admit bootstrap requests; after `begin`, candidate proof fences each
ceremony operation. Public route classification does not waive those checks.
Operator-only surface
approval and pending-enrollment approval live under
`/api/pairing/native-relay-surfaces` and `/api/pairing/native-relay-enrollments`.
See [native enrollment](../design/native-relay-enrollment.md) for credential
sealing, activation, cancellation, recovery and evidence limits.
---


## Decide a pending paired-device request

A current operator, qualifying local-grant credential, or Device explicitly
promoted with `access:approve` can use these exact routes:

- `GET /api/pairing/requests`
- `POST /api/pairing/requests/:requestId/confirm`
- `DELETE /api/pairing/requests/:requestId`

The promotion satisfies the pending-request route scope without granting
`access:manage`. Authority is rechecked before publishing a decision. It does
not admit other Device-management routes or verified-person/account binding.
Ordinary Device presets do not include the promotion.

## Operator passkey administration (host)

`GET /api/pairing/operator-passkeys` lists enrollment availability, active
passkeys (metadata only: id, label, relying-party ID, origin, transports,
timestamps) and pending enrollment requests **without their codes**.
Each pending request carries `requester` (`kind`, the first eight characters of
`deviceId`, `pairedAt`, `scope`) from the pairing registry, beside the
device-chosen `deviceLabel`. `POST .../requests/inspect` takes
`{ "code" }` and returns that without confirming. `POST .../requests/approve`
takes `{ "code", "device"? }`; `device`, when sent, must be a prefix (at least
four characters) of the requesting device's id or nothing is confirmed (409
`device_mismatch`). `POST .../requests/deny` takes `{ "code" }` and also
withdraws a confirmed request whose passkey is not yet created. Bodies over 1 KiB
are refused (413). `DELETE /api/pairing/operator-passkeys/:id` revokes
a passkey. Only the operator credential is accepted; a paired device holding
`access:manage` is refused (401 `authentication_required`, pinned by a test that lets the device reach the handler). Errors: `invalid_code` (404), `device_mismatch` (409), `device_gone` (409, the requesting device was revoked or unpaired after it asked; pending requests also show its current scope and `active`), `rate_limited`
(429, with `retryAfterMs`), `passkey_not_found` (404), `enrollment_unavailable`
(503, `STATION_TRUSTED_CONSENT_ORIGIN` unset), `store_unavailable` (503, the passkey store cannot be opened privately). Each error carries one fixed message per code, and an unexpected failure returns `internal_error` (500) with a generic message and no cause text. The browser half is served on the
consent origin under `/operator/passkeys/enroll`; see the
[enrollment guide](../guides/operator-passkeys.md). Owner:
[host routes](../../src-server/routes/operator-passkeys/operator-passkey-host-routes.ts),
[service](../../src-server/services/identity/operator-passkey-enrollment.ts).

## Bind a paired device to its verified person

```http
POST /api/pairing/requests/:requestId/confirm
```

```json
{ "bindVerifiedIdentity": true }
```

This explicitly approves a **verified Tailscale-person binding** for a pending
Device request. The [confirmation route](../../src-server/runtime/routes/runtime-routes.ts)
requires a current operator credential or a qualifying local-grant credential;
ordinary paired-device approval, UI-bootstrap locality, or an internal token
alone cannot approve this binding. The request must have server-verified
Tailnet identity. The server chooses the subject; the body cannot supply one.

Invalid fields/types return 400 and insufficient authority returns 403. This
verified-person binding is unavailable in hosted mode (409
`person_binding_unavailable`). Ordinary personal Device requests can still be
approved without a body and remain device-only. Account/relay enrollment that
requires an account binding cannot use that ordinary path. The separate
`bindAccountIdentity` option is mutually exclusive with `bindVerifiedIdentity`.

A successful binding response includes `personBindingApproved: true`; callers
must require that acknowledgement. The subsequent one-time exchange persists
the binding with the Device credential, including provider/subject and approval
provenance. A Tailscale-person binding changes identity resolution; it does not
add wire scope or Project membership, or relabel existing history.

The [principal owner](../../src-server/runtime/bootstrap/orchestration-request-principal.ts)
uses that approved binding on direct requests and rejects a conflicting live
identity. Devices bound to the same provider/subject resolve to the same person;
revoking a Device removes that grant from active authority.

The [pairing panel](../../packages/connect/src/react/DevicePairingPanel.tsx) offers
**Recognize this device as …**, and
`station environment access approve <request-id> --bind-person` carries the same
explicit choice through the [CLI owner](../../packages/cli/src/commands/environment.ts).
See [Project membership and enrollment](../design/project-membership.md) for the
separate account-binding and membership paths.


### Review an immutable Task output

In personal Station, `POST /api/tasks/:taskId/room/output-feedback` accepts
`{proposalId, occurredAt, target: {outputId, digest, taskCreatedAt}, review, text}`.
`digest` is the retained output's `sha256:` value, `taskCreatedAt` identifies the
Task incarnation, and `review` is `comment`, `changes-requested` or `accepted`.
The server derives the human principal and requires current room message-write
authority. Agents cannot append this body. A fresh statement must resolve an
output in that Task and Project with the exact digest and Task incarnation.

The statement enters the same ordered, attributed room history and stream as
conversation messages. `accepted` means that reviewer accepted this version;
it does not change Task status, approve a workflow, or establish quality. Room
history labels feedback from a different Task creation time as an earlier Task
version; retained review never establishes acceptance of a replacement Task.
Use the same proposal ID and unchanged payload after an uncertain response.
Current authority is rechecked before a duplicate receipt is returned; exact
retries survive output deletion and room-record retention. Changed content
under that ID conflicts. Fresh statements about a deleted output are refused.

Rooms retain existing v2 record bytes. The first output review and later writes
use v3; a durable per-room database trigger rejects v2 inserts after that room
has adopted v3, including after its feedback records have expired. Legacy
readers may be unable to read a room once it contains v3 records.

The Task output UI offers review only after authorized downloaded bytes match
the selected version's length, ETag and SHA-256 digest. Supported plain-HTTP
browser connections use the pinned portable SHA-256 implementation when
SubtleCrypto is absent. Text/JSON previews are
bounded and safe PNG previews retain the existing download policy. Other media
remain download-only; loading bytes does not prove a person inspected them.
Drafts and uncertain retries are guarded when hiding or deleting the output.
Invited/public result reads currently omit output feedback: their human-history
projection includes conversation messages only. Invited/public participation,
browser acceptance and installed delivery require separate evidence from these
source contracts.
