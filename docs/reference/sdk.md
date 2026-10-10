# @kontourai/station-sdk

Primary reference for plugin developers. General runtime imports come from
`'@kontourai/station-sdk'`; opt-in voice-session runtime and test helpers use
documented SDK subpaths.

The SDK wraps core app contexts and exposes them through stable React hooks, UI components, typed API functions, and extension registries. Plugins never import from internal app packages directly.

The [package export map](../../packages/sdk/package.json) owns importable
subpaths; a source file or Station's internal bundler alias is not a public
entry point. Exports select TypeScript/TSX source and host components may also
need CSS, React and a Query Client. See the [package README](../../packages/sdk/README.md)
for source distribution and a checked authoring example.

## Agent development entry

`@kontourai/station-sdk/agent` is the React-free Agent authoring and execution
entry. The SDK root and owning UI subpaths remain the plug-in UI surface;
`/client` remains the broader React-free Station API entry. See
[Agent development](../guides/agent-development.md) for the complete journey and
[ADR 0021](../adr/0021-separate-plugin-and-agent-sdk-surfaces.md) for the boundary.
This source addition requires a published version that exports `/agent`.

| Group | Exports |
| --- | --- |
| Authoring and addressing | `AgentSpec`, `AgentId`, `agentId`, `ExecutionTarget`, `ExecutionAgentRef`, `executionProfileAgentId`, `executionBindingAgentId`, `environmentId`, `ClientRequestOptions` |
| Catalog and definitions | `fetchAgentCatalog`, `getAgent`, `createAgentDetailed`, `updateAgentRaw`, `deleteAgentRaw` |
| Foreground execution | `sendExecutionMessage`, `continueExecutionMessage`, `handoffExecutionMessage`, `getConversationHandoffStatus` |
| Durable delegation | `discoverDelegationOptions`, `delegateTask`, `observeDelegatedTask`, `observeDelegatedTaskEvents`, `continueDelegatedTask`, `listDelegatedTasks`, `lookupDelegationAttempt` |
| Decisions and interruption | `respondToDelegatedTaskRequest`, `interruptDelegatedTask`, `respondToRequest`, `interruptTurn` |
| Session observation | `getOrchestrationSession`, `getOrchestrationSessionEventPage`, `getOrchestrationSessionEventWindow`, `getOrchestrationConversationEventWindow`, `getConversationUsageTree` |
| Outputs | `listSessionOutputs`, `inspectSessionOutput` and their contract types |
| Failure handling | Canonical HTTP/authority errors, `ChatHttpError`, `ForegroundMessageIndeterminateError`, `DelegationApiError`, `SessionOutputsRequestError` |

These are explicit re-exports of the existing clients, with unchanged arguments,
return values, and errors. Every operation receives an explicit `apiBase` and
per-call authority options. The [entry source](../../packages/sdk/src/agent/index.ts)
owns the exact export list; operation documentation below and the
[Session API](session-api.md) own behavior details. There is no automatic create
retry, credential singleton, engine loop, or new Agent definition schema.

---

## Setup

The React-free `/client` entry exports
`readConversation(apiBase, conversationId, query?, options?)` for compact,
paginated conversation history. `query` accepts `cursor`, `aroundMessageId` and
`limit`. Its `ConversationReadPage` contract preserves message Session/model
attribution and optional versioned continuity provenance. Provider handoffs
remain one Conversation with linked execution Sessions; explicit fork ancestry
is separate. Missing or unavailable provenance means unknown. Parent references
do not grant read access. See the [Session API](session-api.md) for continuity
and authorization limits. This export requires a published version containing it.

`fetchSSE` accepts `initialLastEventId` for a replacement stream. It sends that
cursor as `Last-Event-ID` on the first request and continues updating the cursor
from accepted SSE frames during transport retries. Callers should provide the
last event they applied for the same server authority.

Trusted plugin Workspace Panes are wrapped in the canonical `SDKProvider` graph
by the host, on both direct routes and placed Pane hosts. No plugin-side mock
provider is required. Project identity comes from the server-issued Pane
occurrence, not ambient navigation or a parsed URL.

The host binds plugin header attribution to each provider boundary. It never
installs whichever plugin rendered last as global request identity. Header
attribution is not an authorization grant. `useSDK()` exposes that bound
identity; the pure `getPluginHeaders` utility is available on the existing
`@kontourai/station-sdk/client` entry. Legacy imperative calls without a bound
identity remain unqualified.

`LayoutProvider` is a compatibility wrapper over the supplied SDK context. It
does not infer Agent prefixes or select a default Agent. Layout-global actions
and default-Agent migration remain separately tracked by #1372.

```tsx
// Core app wraps your plugin automatically:
<SDKProvider value={sdkContextValue}>
  <YourPlugin />
</SDKProvider>
```

```tsx
// Compatibility wrapper for an explicitly supplied legacy context:
<LayoutProvider sdk={sdkContextValue} layout={layoutConfig}>
  <YourWorkspacePlugin />
</LayoutProvider>
```

---

## Account-recovery allowance preference

`useSetCredentialRecoveryAutomaticPolicyMutation` forwards optional
`allowancePreference: { windowId, minimumRemainingPercent }` to the existing
credential-recovery policy endpoint. Omit the field to preserve the saved
preference, or pass `null` to clear it. The mutation does not enroll accounts,
probe quota by itself, apply credentials, or prove a recovery succeeded. See
[the policy and evidence boundaries](../guides/connections.md#prefer-allowance-that-expires-sooner-during-account-recovery).

## Credential-profile device-code login

The `@kontourai/station-sdk/device-code-login` subpath exports
`useEngineLoginProfilesQuery(connectionId, requestScope)`,
`useDeviceCodeLoginQuery(target, enabled)`, `useStartDeviceCodeLoginMutation()`
and `useCancelDeviceCodeLoginMutation()`. A target contains `connectionId`,
`profileRef` and an explicit `requestScope` (`apiBase`, `authorityKey`). Hooks
use the authenticated transport and partition status by that authority and
profile. A host Query Client and a matching current SDK transport authority
are required.

`useEngineLoginProfilesQuery` returns `EngineLoginProfiles`: profile references,
optional display labels, authentication states and observed device-code support.
It uses the dedicated sign-in read, never the credential-management or manual
enrolment endpoints. Its cache is partitioned by current request authority;
failed reads stay visible and are not retried automatically. `EngineLoginProfiles`
is exported from the same subpath.
The profile-index hook and DTO are available in repository source and
scheduled for the next minor package release.

The status query treats an absent login as `null` and polls every two seconds
only while starting, awaiting approval or verifying. Mutations are never
retried automatically; after settlement they re-read status so an indeterminate
request does not imply that nothing started. `DeviceCodeLoginRefusal` preserves
the server's message, named outcome when present and HTTP status. Verification
links must use HTTPS without embedded credentials. The device's `engine:login`
grant is required by the server; hosts should observe current authority before
offering the action. See [profile sign-in](../guides/connections.md#sign-an-engine-profile-in-from-a-device).

## Hooks

Use hooks inside the host's React provider tree. Query hooks return a React
Query result, with values in `data` and separate loading/error state; they do
not return the data array itself. A hook being exported also does not prove
that the default Station host supplies its optional context.

### Immutable output review

`@kontourai/station-sdk/project-task-rooms` exports
`appendProjectTaskRoomOutputFeedback(apiBase, input, options?)` and
`useAppendProjectTaskRoomOutputFeedbackMutation(taskId, taskCreatedAt, scope)`.
The client input contains `taskId`, `proposalId`, `occurredAt` and a
`ProjectTaskRoomOutputFeedback` body. Preserve all fields for an uncertain
retry; mutation retries are disabled. The hook requires captured connection
authority and matching Task incarnation before sending, refuses stale late
settlement, and invalidates room history only under current authority.

`useProjectTaskRoomDiscoveryQuery(taskId, {requestScope, taskCreatedAt})` and
`useTaskOutputsQuery(taskId, {requestScope, taskCreatedAt})` partition reads by
connection authority and Task incarnation and refuse stale settlement.
The optional scoped configuration is used by Station's output review surface;
legacy unscoped callers keep their existing behavior. See the
[review HTTP contract](api.md#review-an-immutable-task-output) for authority,
idempotency, compatibility and the meaning of reviewer acceptance.

### Task room agent requests

`@kontourai/station-sdk/client` exports `fetchTaskRoomAgentRequests`,
`submitTaskRoomAgentRequest`, `TaskRoomWorkProtocolError` and
`TaskRoomWorkNotSentError`. Submission takes `(apiBase, taskId, projectSlug,
taskCreatedAt, input, options?)`; input contains `operationId`, `agentId` and
`prompt`, with optional `context: { version: 'station.task-room-context/v1', digest }`.
The request-list result includes `contextVersion` and an authorized brief snapshot
(or `null`) on supporting servers. Submission negotiates that version, forwards
only the reference, and verifies that the acknowledgement retains its digest and
Task incarnation. It does not substitute a newer brief on a retry.
Optional `executionAgentId`, `expectedDefinitionFingerprint`, `modelId` and
`providerOptions` carry explicit execution intent. Acknowledgements must retain
the selected binding/model/fingerprint and the canonical options digest. A
changed engine, model or options cannot replay a prior operation as success.
Raw provider options are not persisted in the request journal.
A fresh versioned request-list read precedes the additive delegation
create field, so an older Station never silently receives an ordinary
delegation instead. The response must match the Task and submitted intent.
The server also checks the expected Task incarnation.

`@kontourai/station-sdk/project-task-rooms` exports
`useTaskRoomAgentOptionsQuery(projectSlug, scope, enabled?)`,
`useTaskRoomAgentRequestsQuery(taskId, taskCreatedAt, scope, enabled?)` and
`useSubmitTaskRoomAgentRequestMutation(taskId, taskCreatedAt, projectSlug, scope)`.
The captured scope requires `apiBase`, `authorityKey` and `isCurrent()`; absent
or stale scope never falls back to the ambient connection. Request caches
include connection authority, Task identity and incarnation. Request cards
poll every five seconds and can be refreshed explicitly; journal changes are
not currently published through room SSE. Mutation retries are disabled.
Send refreshes Project-scoped delegation options and requires the selected
agent to be ready before the version negotiation and create.

`TaskRoomWorkNotSentError` identifies a failed preflight with no create sent,
or an explicit pre-invocation context refusal from a supporting server. Refresh
the brief before starting a new intent; preserve a prior unknown request when
a retry itself was not sent.
After the create starts, an error can mean the execution already exists.
Retain the exact operation and intent for an explicit retry or inspection;
never generate a replacement operation automatically. A retry preflight failure
proves only that retry was not sent; it does not resolve a prior unknown create. Server non-success
envelopes throw HTTP errors rather than returning every refusal union arm.
`dispatched` records acknowledgement, not result quality, Task completion or
customer acceptance.

The existing `useAppendProjectTaskRoomHumanMessageMutation(taskId, config?)`
accepts an explicit `{ requestScope, taskCreatedAt }` config for the mounted
Task composer. When provided, it sends through the checked JSON transport,
includes `expectedTaskCreatedAt` in the message body, refuses missing/stale
scope and rejects late success after authority loss. The server checks the
expected incarnation at the history grant's commit admission. Legacy callers
omitting config still use the ambient API base; other room read/edit hooks
retain their existing contracts. An old receiver that rejects the additive
message field cannot silently accept it for a different Task.

These personal-Station clients do not establish invited,
remote or anonymous-public participation. See [request ownership and limits](../design/task-room-agent-requests.md).


### Default host bindings and custom hosts

The [default SDK adapter](../../src-ui/src/core/SDKAdapter.tsx) is delivered
through [the plugin Pane boundary](../../src-ui/src/workspace-panes/PluginWorkspacePaneSDKBoundary.tsx).
`SDKProvider` forwards the supplied value without filling missing slots.
It also does not initialize the module-global API base used by legacy helpers;
Station's adapter does that. A custom host must configure that base separately
or use client functions that take an explicit API base and request options.

| Surface | Current default Station binding |
| --- | --- |
| Agents, navigation, toast, auth | Bound host contexts |
| Layout list/detail | Bound list and selected-layout projection |
| `useApiBase` | Returns `{ apiBase }`, not a string |
| Create/send/open chat | Bound host callbacks; see their UI identity/async distinctions below |
| `useActiveChatActions(id)` | Forwards the host's unbound store-actions object; the supplied id is not bound to those actions |
| `useConversations(agentSlug?)` | Forwards the adapter's captured list; the argument is not forwarded to the core query |
| `useConfig`, `useConversation`, `useConversationMessages`, `useActiveChatState` | Corresponding methods are not supplied; calling them through this adapter fails |
| Model, stats, workflow and keyboard contexts; slash-command/tool-approval hook slots | Not supplied by this adapter |

The unbound hooks remain exported custom-host contracts, not deprecated or
removed APIs. A custom `SDKProvider` may implement their slots. Default plugin
examples should use an available query or bound host action instead; do not
interpret an unavailable hook as empty data. Query alternatives still require
the host Query Client and the server's normal access policy.

The default-host gaps and their caller-level acceptance criteria are tracked
in [#2780](https://github.com/kontourai/station/issues/2780). That recommendation
does not require every custom host to provide every optional slot.

### Scoped coding file mention queries

`@kontourai/station-sdk/coding-file-mentions-query` exports
`useCodingFileMentionCandidatesQuery`, `fetchCodingFileMentionCandidates`,
`CodingLocation`, `CodingFileEntry`, and `CodingFileMentionCandidates`. This
subpath is the metadata lookup used by Station's chat composer; it returns file
metadata rather than file contents.

The hook accepts `{ projectSlug, workingDir }`, a search string, and an `ApiRequestScope`
extended with `isCurrent()`. Its cache identity includes the exact API origin
and opaque authority key. The request is cancelled or its result withheld when
that captured authority is no longer current, so a reconnect cannot rebind an
old result to a new account. Results are bounded to 200 entries. `partial: true`
means the server stopped at its scan/result budget and the caller should ask the
user to refine the path.

```tsx
import { useCodingFileMentionCandidatesQuery } from
  '@kontourai/station-sdk/coding-file-mentions-query';

const candidates = useCodingFileMentionCandidatesQuery(
  { projectSlug: 'example', workingDir: '/workspace/project' },
  'src/chat',
  requestScope,
);
```

The returned `CodingFileEntry` contains `name`, a `path` relative to the selected
working directory, and
`type: 'file' | 'directory'`, with optional size, modification time, and bounded
children. A selected path is still subject to the server's workspace
containment and authorization checks; query metadata does not grant file
access.

### Conversation input-origin support

`OrchestrationSessionSummary.inputOrigin` is a closed, optional server-issued
union. The current supported arm is `delegation`. The orchestration read model
derives it from the same persisted `session.started` / `session.configured`
metadata that produces `OrchestrationSessionSummary.delegation` in
`src-server/services/orchestration/orchestration-session-state.ts`. Missing or
unrecognized origin evidence leaves the member absent; clients must not infer
it from a local tab's source label or a reported device surface.

Schedule and voice attribution are not currently projected onto conversation
summaries. Scheduled occurrences are projected as independent run IDs by
`src-server/services/orchestration/run-projection.ts` and read through
`run-service.ts`; that projection carries no durable conversation identity.
Voice effects are retained in `voice_turn_runs` by
`src-server/services/orchestration/event-store.ts`; `voice-session.ts` records
the provider session/prompt/turn tuple and uses the Agent slug as `sourceId`,
not a Station conversation ID. Until those ledgers publish an authorized,
durable conversation join, their `inputOrigin` remains absent. Browser
microphone dictation follows the ordinary foreground-message path and does not
prove a voice-session origin.

### Agent Hooks

#### `useAgents(): AgentSummary[]`

Returns all available agents.

```tsx
const agents = useAgents();
const myAgent = agents.find(a => a.slug === 'my-agent');
```

#### `useAgent(slug: string): AgentSummary | undefined`

Returns a single agent by slug.

```tsx
const agent = useAgent('my-agent');
```

Agent operations take explicit canonical Agent IDs. A Layout or Pane slug does
not supply an Agent prefix or a default execution binding; the former
`useResolveAgent` description is not a supported current hook contract.

---

### Layout Hooks

#### `useLayouts()`

Returns the host's layout list. Station's default adapter supplies the current
bound/selected Project's layout query data, not every layout in the installation.

---

### Project Hooks

#### `useProjects()`

Returns the same query result as `useProjectsQuery()`, including its authorized
personal/member view union in `data`.

#### `useProject(slug: string)`

Returns the `useProjectQuery(slug)` result, not a Project directly. This legacy
full-configuration query does not accept member-only views; use the explicit
Project view API described below for guests.

---

### Conversation Hooks

#### `useConversations(agentSlug?: string): Conversation[]`

Calls the host's supplied conversation-list function. The current Station
adapter captures that list without forwarding this argument; use
`useConversationsQuery(agentSlug)` when an explicit Agent query is required.

#### `useConversation(conversationId: string): Conversation | undefined`

Custom-host slot for one conversation. It is not bound by the current Station
adapter; export presence is not a working default read path.

#### `useConversationMessages(conversationId: string): Message[]`

Custom-host message slot, currently unbound in Station's default adapter.

---

### Chat Hooks

#### `useCreateChatSession(): (agentSlug: string, name: string) => string`

Returns a host function that creates a local Dock entry and its UI ID. It does
not itself start provider execution or establish a durable server Session.

```tsx
const createSession = useCreateChatSession();
const sessionId = createSession('my-agent', 'My Agent');
```

#### `useOpenConversation()`

The default callback requires `conversationId`, `agentSlug` and `agentName`;
it also accepts optional Project/execution/hydration context and returns
`Promise<string | null>`. A null result means message hydration failed. Opening
a Dock entry is not proof that continuation is authorized; use canonical
conversation resolution and current server execution evidence, not mutable
Agent defaults, when a host supplies that context.

#### `useSendMessage()`

Returns the host's asynchronous callback. Its first four arguments are the
local Dock entry ID, canonical Agent ID, optional conversation ID and content;
the host also accepts attachments and other current send context. A send can
queue or refuse work; awaiting it is not a receipt of provider completion.

#### `useActiveChatActions(sessionId: string)`

Calls the host action slot. The default adapter currently forwards unbound
store actions rather than binding the supplied ID; do not assume a stable
per-session stop/clear interface from this compatibility wrapper.

#### `useActiveChatState(sessionId: string)`

Custom-host state slot; currently unbound in Station's default adapter.

#### `useSendToChat(agent: QualifiedPluginAgentId | AgentId): (message: string) => void`

Convenience hook. Returns a function that creates a session, shows Chat, and sends a message — all in one call. Showing Chat opens the dock, except in a layout whose centre is Chat (the built-in Coding layout on desktop), where it shows that Chat page and leaves the dock alone.

Name an Agent your plugin contributes as `'<plugin>:<agent>'`. The hook derives
the Agent's identity from it and sends only when the named plugin contributed
that Agent; a reference naming another plugin is refused. A clean Agent id from
`agentId()` in `@kontourai/station-contracts/agent-identity` also works. When
no Agent matches, the function warns and sends nothing.

```tsx
const sendToChat = useSendToChat('my-plugin:assistant');
sendToChat('Summarize this account');
```

---

### Navigation Hooks

#### `useNavigation(): SDKNavigation`

Returns the navigation a plugin may read and drive: `pathname`,
`selectedProject`, `selectedProjectLayout`, `selectedAgent`,
`activeConversation`, `activeChat`, `activeTab`, `isDockOpen` and
`isDockMaximized`, plus `navigate`, `setProject`, `setLayout`, `setLayoutTab`,
`setConversation`, `setActiveChat` and `setDockState`.

#### `useDockState(): { isOpen: boolean; setOpen: (v: boolean) => void; toggle: () => void }`

Convenience wrapper around `useNavigation()` for controlling the chat dock.

```tsx
const { isOpen, toggle } = useDockState();
```

---

### Auth & Config Hooks

#### `useAuth(): SDKAuthState`

Returns the current auth state.

```ts
type AuthStateExcerpt = {
  status: 'valid' | 'expiring' | 'expired' | 'missing' | 'not-configured' | 'loading';
  user: { alias: string; name?: string; title?: string; email?: string; profileUrl?: string } | null;
  expiresAt: Date | null;
  provider: string;
  renew: () => Promise<void>;
  isRenewing: boolean;
}
```

#### `useConfig()`

Custom-host configuration slot, currently unbound in the default adapter.
`useConfigQuery()` is the explicit server-read query surface.

#### `useApiBase(): { apiBase: string }`

Returns the current host's API-base object. `useSDK().apiBase` is the string
projection; do not interpolate the whole object into a URL.

---

### Connection Hooks

#### `usePairedDevicesQuery(apiBase?: string)`

Returns a query whose data is the current inbound paired-device registry from
`GET /api/pairing/devices`. Device names are current read-time values; do not
copy them into session or event records. An authorization or response failure
is a query error, not an empty device list.

#### `useConnectionsQuery()`

Returns the merged Connections list used by the Connections hub. The result includes both model and runtime rows from `GET /api/connections`.

#### `useModelConnectionsQuery()`

Returns model/provider-backed connections from `GET /api/connections/models`.

Use this when you need provider readiness, editable provider config, or provider-scoped `config.modelOptions`.

<a id="useruntimeconnectionsquery"></a>

#### `useEngineConnectionsQuery()`

Returns engine connection rows from `GET /api/connections/agents`, under
`['connections', 'engines']`. The previously documented `useRuntimeConnectionsQuery` name is
not a current export.

Rows can expose model-catalog metadata on `runtimeCatalog`, including:

- `source` — `live`, `cached`, `built-in`, or `none`
- `models` — live or cached catalog entries
- `builtInModels` — Station's bounded built-in entries when live enumeration is unavailable
- `reason`, `fetchedAt`, and `truncated` — catalog status and completeness metadata

Current callers include `ConnectionsHub`, `AgentConnectionView`, `EnginePicker`
and `AgentEditorForm`. Built-in candidates are not proof that an engine currently
offers a model; preserve the catalog source and availability when presenting them.

```tsx
const { data: engineConnections = [] } = useEngineConnectionsQuery();

const codexConnection = engineConnections.find((c) => c.config.engineId === 'codex');
const catalog = codexConnection?.runtimeCatalog;
const observedModels = catalog?.models ?? [];
const catalogSource = catalog?.source ?? 'none';
```

#### `useContributedModelManifestQuery()`

Reads the contributed model subset (`station.fleet-contribution/v1`) from
`GET /api/connections/model-inventory`. It is not the complete launchable model
inventory. The non-React `fetchContributedModelManifest()` returns the same body.
The route requires `inference:invoke`; the `read-only`, `standard` and
`delegation` pairing presets do not grant it. Use an explicitly approved
`inference` grant. Connection save, delete, health-test and smoke mutations
invalidate the query.

#### `useAgentConnectionQuery(id: EngineConnectionId)`

Returns a single connection from `GET /api/connections/:id`.

Agent detail views use the branded engine namespace. Model detail views can use
`useConnectionQuery(id)` for a generic connection read.

#### Agent connection mutations

`useSaveAgentConnectionMutation()`, `useDeleteAgentConnectionMutation()`, `useTestAgentConnectionMutation()`, and `useSmokeAgentConnectionMutation()` accept `AgentConnectionView` or `EngineConnectionId`, never an unbranded string.

The writable payload stays on the existing editable fields (`name`, `enabled`, `config`). The read-only `runtimeCatalog` projection should not be treated as user-editable input.

#### Model connection mutations

`useSaveModelConnectionMutation()`, `useDeleteModelConnectionMutation()`, `useTestModelConnectionMutation()`, and `useSmokeModelConnectionMutation()` own the Model connection surface. Keeping these operations separate prevents an engine identity from being accidentally routed through a Model edit path.

---

### Model Hooks

#### `useModels()`

Custom-host model-list slot, currently unbound by the default adapter.

#### `useAvailableModels()`

Custom-host model-availability slot, also unbound by the default adapter. The
explicit model query surfaces below are separate from these compatibility hooks.

---

### Knowledge Hooks

#### `useKnowledgeDocs(projectSlug: string, namespace?: string)`

Returns a query whose `data` is the project's `KnowledgeDocumentMeta[]`,
optionally filtered by namespace.

#### `useKnowledgeNamespaces(projectSlug: string)`

Returns a query whose `data` is the project's `KnowledgeNamespaceConfig[]`.

#### `useKnowledgeSearch(projectSlug: string, query: string, namespace?: string)`

Returns a query result whose `data` contains semantic search results from the
selected Project/namespace.

---

### Notification Hooks

#### `useToast(): SDKToast`

Returns `{ showToast, dismissToast }`. `showToast` takes either spelling and
returns the toast id:

```tsx
const { showToast } = useToast();
showToast('Saved', 'success');
showToast({
  message: 'Saved',
  type: 'success',
  duration: 8000,
  actions: [{ label: 'View', onClick: openNotes }],
});
```

Types: `'info' | 'success' | 'warning' | 'error'`. The object form takes one
`action`, several `actions`, or both.

#### `useNotifications()`

Returns immediate-toast `notify` plus server-backed `schedule` and `dismiss`
methods. The example uses only `notify`; it does not create an inbox, push or
scheduled notification. Server methods still require the host's transport and
request authorization. `dismiss` currently awaits `fetch` without checking its
HTTP status, so its resolved promise is not proof of successful deletion.

```ts
type Notifications = ReturnType<typeof useNotifications>;
```

```tsx
const { notify } = useNotifications();
notify('Saved!', { type: 'success' });
```

#### `useNotificationPreferencesQuery(apiBase?: string)`

Reads `GET /api/notifications/preferences`: how far notifications may
interrupt beyond the inbox (agent notification level, quiet hours,
per-surface minimum urgency and hidden content, escalation delay). Operate
tier; Station's own agent tools and delegated Stations are refused. A saved
document the server cannot read is a query error, not the defaults.

#### `usePatchNotificationPreferencesMutation(apiBase?: string)`

`PATCH`es a `NotificationPreferencesPatch`: only the named fields change,
server-side in one step, so a mute and a settings edit never lose each other.
A map entry of `null` removes it; `quietHours: null` turns quiet hours off.
Prefer this over a read-modify-write `PUT`.

#### `useUpdateNotificationPreferencesMutation(apiBase?: string)`

`PUT`s a complete `NotificationPreferencesV1`; the server refuses a partial or
unknown-key document. `GET` returns an `ETag`; a raw `PUT` with `If-Match`
is refused `412` if the document changed since. Shapes and defaults come
from `@kontourai/station-contracts/notification-preferences`.

---

### Slash Command Hooks

These optional custom-host slots are not bound by the default Station adapter;
calling either hook there throws.

#### `useSlashCommands(): SlashCommand[]`

Returns all registered slash commands.

#### `useSlashCommandHandler()`

Returns the handler function for processing slash command input.

---

### Tool Approval Hook

The default Station adapter does not supply this optional hook slot. A custom
host must supply it before use; exporting the hook does not grant tool approval.

#### `useToolApproval()`

Returns the tool approval state and actions (approve/reject pending tool calls).

---

### Stats Hooks

These require an optional stats context absent from the default Station
adapter. Use the query APIs when appropriate for that host.

#### `useStats()`

Returns aggregate usage statistics.

#### `useConversationStats(conversationId?: string)`

Returns stats for a specific conversation.

---

### Keyboard Hooks

These require optional host slots absent from the default Station adapter.
The following registration example describes a custom host that supplies them.

#### `useKeyboardShortcut(key: string, callback: () => void, deps?: any[]): void`

Registers a keyboard shortcut for the lifetime of the component.

```tsx
useKeyboardShortcut('cmd+k', () => setOpen(true));
```

#### `useKeyboardShortcuts()`

Returns all registered keyboard shortcuts.

---

### Workflow Hooks

`useWorkflows` requires the optional workflows context, which the default
Station adapter does not supply. `useAgentWorkflowsQuery` is a separate query
API rather than that context hook.

#### `useWorkflows(agentSlug?: string): Workflow[]`

Returns workflows, optionally filtered by agent.

#### `useAgentWorkflowsQuery(agentSlug, config?)`

Returns a query whose `data` is the agent's `WorkflowMetadata[]`.

---

### Utility Hooks

#### `useSDK()`

Returns `{ apiBase, pluginName, getPluginHeaders }`, not the entire provider
context. `pluginName` may be empty; header attribution is not an authorization
grant. Prefer scoped client operations for protected data.

#### `useUserLookup(alias: string | null): { data: any; loading: boolean; error: string | null }`

Looks up a user by alias via the user directory. Returns `null` data when alias
is `null`. This legacy hook decodes JSON without checking HTTP status, so an
error response can appear in `data` rather than `error`. It uses the ambient
API base and direct `fetch`; its effect discards a late result after cleanup
but does not cancel the request or capture `ApiRequestScope`.

```tsx
const { data, loading } = useUserLookup('jsmith');
```

#### `useServerFetch(): (url: string, options?) => Promise<{ status, contentType, body }>`

This exported helper is not a working proxy through the current Station server.
Its legacy plugin-name getter is empty, so it calls `/api/plugins/fetch`, which
returns 403. The named `/:name/fetch` route also refuses after checking grants
because plugin execution identity is not yet verifiable. Declaring
`network.fetch` alone does not enable either route.

```tsx
const serverFetch = useServerFetch();
// This rejects against the current Station server.
await serverFetch('https://api.example.com/data');
```

The CLI preview server has a separate development proxy; that does not establish
production support. See the [hook](../../packages/sdk/src/hooks/operations.ts),
[legacy identity getter](../../packages/sdk/src/api-core.ts), and
[server refusal](../../src-server/routes/plugins/plugin-public-routes.ts).

---

## Query Hooks

### Unified search (backend and SDK slice)

`searchStation(apiBase, request, { requestScope, signal? })` queries `POST /api/search` with the
closed `station.unified-search/v1` request from
`@kontourai/station-contracts/unified-search`. The response retains each source's
owner, availability, restriction and partial-result state; unavailable does not
mean empty. `resolveSearchOpen(apiBase, locator, { requestScope, signal? })` performs a fresh
read-only `POST /api/search/resolve-open`, returning `resolved`, `not-found`
(also authorization denial), or `unavailable`. It does not navigate or execute
work. Message locators require the exact `matchedEventId`; never substitute a
legacy navigation anchor or follow a Session's current child. Both helpers are
available from the React-free `/client` export and declare POST transport as
read-only. Both require a host-captured scope matching `apiBase`, rejecting absent
or mismatched scopes before transport. Older servers return `UnifiedSearchRequestError.kind: 'unsupported'`
on 404/405, never fabricated empty results.

Import `searchStation`, `resolveSearchOpen`, and `UnifiedSearchRequestError`
from `@kontourai/station-sdk/client`. The root `@kontourai/station-sdk` entry
exports `useUnifiedSearchQuery` and `unifiedSearchQueries`; its hook loads the
existing client entry on demand, preserving captured request scope and abort
signal across that asynchronous boundary.

`readSearchMessage(apiBase, { sessionId, matchedEventId, continuation? },
{ requestScope, signal? })`, from `@kontourai/station-sdk/client`, reads a page
of the exact canonical event's prompt or completed output. Every page is
reauthorized; text is never read from the search index. Pages contain at most
4,096 Unicode code points, with an existing 128 KiB source allowance and the
same isolated reader deadline. The opaque continuation binds Session/event,
content and recorded metadata; changed content refuses continuation instead of
splicing revisions. Missing Agent identity is optional, never a default Agent.
The read-only inspector does not adopt, resume, fork, or send to a Session.

The palette's explicit **Workspace search (this Station)** mode consumes local
Task/message results and this exact inspector. Command/legacy remote search is
preserved as a separate mode; only the selected mode dispatches search queries.
This is a local tracer, not completion of the broader multi-source search issue.

`useUnifiedSearchQuery(request, { requestScope, enabled? })` is the protected
React wrapper. A host-captured `ApiRequestScope` is required: no scope means no
request and no data. Query keys include exact API base and authority epoch;
authority changes fence delayed responses through the existing credential
resolver. Cached snippets are hidden until a fresh successful read, and while
refetching or after failure; they never authorize opening. `unifiedSearchQueries`
exposes the same scoped key for explicit invalidation. Only personal Tasks and authorized indexed messages are
searched; hosted Task reads are restricted until a tenant-owned Task store is
composed. Files, receipts, external projections and arbitrary plugin sources
are not supported by this initial runtime composition.

The [SDK parser](../../packages/sdk/src/client/unified-search.ts),
[HTTP routes](../../src-server/routes/search.ts),
[runtime composition](../../src-server/services/search/runtime-search.ts),
[canonical message reader](../../src-server/services/orchestration/transcript-search-queries.ts),
and [palette](../../src-ui/src/components/search/WorkspaceSearchPalette.tsx)
show the request-to-inspection path.

These React Query wrappers define operation-specific keys and freshness policy.
Many legacy readers resolve an ambient API base; protected readers require an
explicit captured scope. The generic wrapper does not add authority, validate a
response, or partition an arbitrary caller-supplied key. Follow each operation's
scope contract rather than assuming every SDK query is interchangeable.

### `useAgentsQuery(config?)`

Reads the Agent catalog under `['agents']`. `data` projects its Agent array;
`catalogState` and `catalogAsOf` retain whether it is a current or older
observation. A displayed cached row is not by itself current launch admission.

### `useAgentToolsQuery(agentSlug: string | undefined, config?)`

Fetches tools for an agent. Disabled when `agentSlug` is undefined.

### `useModelsQuery(config?)`

Fetches the model catalogue from `GET /api/models` under the `model-catalog`
cache key. Do not treat this legacy catalogue as every engine's live model list;
connection-specific model catalogues have their own queries.

### `useModelCapabilitiesEnvelopeQuery(config?)`

Fetches the Bedrock model-capability catalogue with its provenance:
`{ capabilities, source: 'bedrock', complete }`. `complete: false` means the
catalogue could not be read, so `capabilities` is unknown rather than empty.

Use the envelope when the distinction between a complete empty catalogue and
unavailable enumeration matters. The list-only hook below cannot express
"not queryable"; `complete: false` is not evidence that a model is unsupported.

### `useModelCapabilitiesQuery(config?)`

List-only view over `useModelCapabilitiesEnvelopeQuery`, sharing its cache
entry. Cannot express "not queryable".

<a id="useprojectlayoutsqueryprojectslug-string-config-1"></a>

### `useProjectLayoutsQuery(projectSlug: string, config?)`

Fetches layouts for a project.

### `useProjectLayoutQuery(projectSlug: string, layoutSlug: string, config?)`

Fetches a single project layout.

### `usePersonalLayoutsQuery(config?)`

Lists the caller's own Boards — Layouts owned by a principal rather than a
project. Cache key: `['me', 'layouts']`. No parameter names the owner, because
no URL in this family does: the server resolves it from the request's own
authentication.

### `usePersonalLayoutQuery(layoutSlug: string | undefined, config?)`

Fetches one of the caller's own Boards. Cache key:
`['me', 'layouts', layoutSlug]`. Disabled when `layoutSlug` is undefined.

### `useCreatePersonalLayoutMutation(options?)`

Creates a Board. Invalidates `['me', 'layouts']` on success.

### `useUpdatePersonalLayoutMutation(options?)`

Patches a Board (`{ layoutSlug, update }`); omitted fields keep their stored
values. Invalidates the list and that Board's own key.

### `useDeletePersonalLayoutMutation(options?)`

Deletes a Board. Invalidates the list and REMOVES that Board's own cache entry
rather than invalidating it — refetching a record that no longer exists would
park a 404 under a key nothing should read again.

### `usePromotePersonalLayoutMutation(options?)`

Moves a Board into a project (`{ layoutSlug, projectSlug }`), where it becomes
that project's Layout under the same id. Invalidates `['me', 'layouts']`,
removes the Board's own key, AND invalidates
`['projects', projectSlug, 'layouts']` — the record crosses a scope boundary,
so a cache that refreshed only one side would tell two stories about it.

### `useConversationsQuery(agentSlug: string | undefined, config?)`

Fetches conversations for an agent. Disabled when `agentSlug` is undefined.

### `useBrandingQuery(config?)`

Fetches the branding provider's answer (`appName`, `logo`, `theme`,
`welcomeMessage`). `theme` is `unknown`: the white-label overrides exactly as
the provider returned them, unvalidated, so parse them before use (see
[examples/custom-branding](../../examples/custom-branding/README.md) for the
shape and rules). An error answer rejects rather than resolving as no branding.

### `useConfigQuery(config?)`

Fetches app configuration.

### `useStatsQuery(agentSlug, conversationId, config?)`

Fetches conversation stats. Disabled when either param is undefined.

### `useConversationUsageTreeQuery(conversationId, apiBase?, config?)`

Fetches the conversation's usage with its children (`getConversationUsageTree`,
[`GET /api/orchestration/conversations/:conversationId/usage-tree`](session-api.md#conversation-usage-tree-get-conversationsconversationidusage-tree)).
Enabled by default; disabled for an empty id or `config.enabled: false`. It
polls only when `config.refetchInterval` is set. A 404 (no conversation you
can read) and a 422 (a tree past its bound) reject with `StationHttpError`,
are not retried, and stop the poll.

### `useUsageQuery(config?)`

Fetches the retained Station-wide usage snapshot. Usage, period usage, receipt
rollup, achievement, and Insights hooks poll every 30 seconds while observed,
refetch on stale mount/focus, and accept caller configuration overrides. Active
server reads refresh the lifetime snapshot at most once a minute. A request's
success is not proof of complete provider reporting; retain source coverage and
snapshot metadata. A rescan invalidates all analytics and Insights queries.

### `useAchievementsQuery(config?)`

Fetches achievement data.

### `useProjectsQuery(config?)`

Fetches all projects. Hosts selecting among Station authorities should pass
`{ requestScope, requireRequestScope: true }`. The scoped cache key includes
the API base and authority key, and the HTTP reader refuses a response if that
authority changes before the body is consumed. With `requireRequestScope`, a
missing scope uses an isolated inert key and never exposes an older unscoped
cache entry.

### `useProjectRunLocationsQuery(config?)`

Fetches `GET /api/projects/run-locations` through `listProjectRunLocations`:
each Project's `ProjectRunsAt` by slug, or an empty map for a shared member. It
takes the same scoped configuration as `useProjectsQuery` and keys under
`[PROJECT_RUN_LOCATIONS_QUERY_KEY_PREFIX, …]` (`'project-run-locations'`),
outside `'projects'`, so a host that persists `'projects'` reads does not
replay a folder answer across reloads. The Project list does not carry run
locations, so mount this only where one is shown and fall back to the stored
folder until it answers. Station's start composer reads it through
`ProjectsContext`'s `useScopedProjectRunLocationsQuery`, with a 30-second
`staleTime` and `refetchOnMount: true` (Station's client default is `false`),
only while the composer is open.

### `useProjectQuery(slug: string, config?)`

Fetches a single project by slug. It accepts the same scoped configuration as
`useProjectsQuery`; the authority follows the slug in the key so existing
`['projects', slug]` invalidation prefixes still reach every scoped detail.
Unscoped callers retain the legacy key and ambient API-base behavior for
compatibility. Station's main-app Project list/detail consumers capture this
scope through `ProjectsContext`.
The host scope includes Connect's connection authority generation, plus a native
binding or the browser relay's account-continuation scope when applicable. A
direct browser cookie-account change that leaves the connection generation
unchanged is not independently detected by that scope. The durable cache
namespace below additionally uses the server's observed principal; that
observation still has to be refreshed after an account change.

### `useProjectIdentityQuery(slug: string, config?)`

Reads a Project's portable identity for personal-peer placement (#480). It
accepts the same scoped configuration as `useProjectQuery` — the cache key
carries the API base, authority key and slug, so a late identity response
for a previous Home or authority can never satisfy the current selection,
and `{ requireRequestScope: true }` disables a missing-scope read. Without that
flag, legacy calls retain the ambient API base. Station's
`useScopedProjectIdentityQuery` supplies the flag. Callers
that know the local Project record they selected should also pass
`expectedProjectId`: it joins the cache key and validates the response's
`association.localProjectId`, so a same-slug delete/recreate (or a stale
server answer) never delivers the previous incarnation's portable id or
resources as success — the read surfaces a typed
`ProjectIdentityIncarnationMismatchError` and recovers through the
ordinary refetch when fresh data carries the correct association. Omitted,
the hook keeps its prior slug-keyed behavior. The identity carries the
portable Project id plus its public repository
labels/ids (no checkout paths, no credentials); the declared
execution-root repository, else a sole repository, selects the executable
resource, while multiple repositories require an explicit choice. Only a
404 read carrying the not-prepared code is a verified not-prepared Project
(prepare one explicitly before placing it); a 404 without that code — an
older Station, a proxy, or a Project that no longer exists here — stays
unavailable with retry, never an absence claim or speculative setup help.
A denied, failed or malformed read refuses visibly and never reads as
absence. Offer eligibility stays unverified until an authorized
controller-side offer query exists — the receiving Station confirms on
submit. Placement itself is supported only through the portable
delegation intent (`project-portable`) dispatched by the delegation
launcher; the foreground thread-execution path has no portable admission
in this slice, so a non-portable Project workspace resolved onto a paired
Station is refused rather than run as an unrelated same-slug Project, and
the thread-default environment picker preserves — but no longer newly
offers — paired-Station selections.

### `useDelegateOrchestrationTaskMutation(apiBase?, options?)`

Dispatches one delegated task. The mutation variable is backwards
compatible with the original published shape — a plain `DelegateTaskInput`,
which resolves against the hook's `apiBase` default and the ambient
authority exactly as before. The recommended form is the per-invocation
envelope — `{ input, apiBase?, requestScope? }`. When the mutation function
begins, it copies the supplied address and authority before transport awaits:
a later authority rotation refuses instead of sending the old intent under new
credentials. Treat mutation variables as immutable after calling `mutate` or
`mutateAsync`; this wrapper does not snapshot the whole input at that public call.
The public request body stays exactly the input (prompt, target, optional
parent task) in both forms; the scope is transport-only and never sent.

### Durable Project query identity and startup seeding

A verified host may additionally supply `durableAuthorityId` to Project list,
detail and reorder configuration. Use the same non-empty identifier for readers
and mutations, derived from the server-observed environment, principal and public
grant. It replaces only the live authority-key segment in the data key; the API
base remains in the key and `requestScope` still guards dispatch and response
consumption. Never use an activation epoch, credential value or token hash as a
durable identity. Omitted or empty identifiers preserve prior live-key behavior.

The Station shell uses separate query clients and IndexedDB keys for verified
identities. Returning to a home requires a fresh observation for that activation;
a cached successful observation cannot activate old data during revalidation.
Failed or unsupported observations use fresh nonpersisted contexts. Other-home
copies and the old singleton blob remain on disk without being adopted into an
unverified identity. Mutations are neither saved nor hydrated from these snapshots.
This does not make connection evidence a substitute for account authentication or
qualify every legacy query, mutation, draft or queue path.

The internal [boot module](../../packages/sdk/src/boot.ts) implements
`fetchBootPayloadAt(apiBase)` and
`seedBootPayloadGuarded(queryClient, payload, startedAt, isCurrent)` for Station's
host. `/boot` is not in the package export map; external consumers must not
infer an importable subpath from this source file. The host captures the
origin and request authority before fetching; its guard verifies both that
captured authority and the destination client. Seeding checks it before every
cache write and preserves newer individual reads.

The [SDK Project queries](../../packages/sdk/src/query-domains/workspaceProjects.ts),
[host Project context](../../src-ui/src/contexts/ProjectsContext.tsx),
[authority namespace](../../src-ui/src/lib/authorityNamespace.ts), and
[query-client owner](../../src-ui/src/contexts/AuthorityQueryContext.tsx)
separate live request admission from persisted data identity.

### `useProjectConversationsQuery(projectSlug: string, limit?, config?)`

Fetches recent conversations for a project. Default limit: 10. This legacy
reader can turn a non-OK response or invalid/failed envelope into `[]`; an empty
result does not distinguish no conversations from those failures. Transport or
JSON-decoding failures can still reject. See `fetchProjectConversations` below.

### `useRenameConversationMutation()`

Renames a conversation and invalidates that agent's conversation list on success.

### `useDeleteConversationMutation()`

Deletes a conversation, invalidates that agent's conversation list, and removes its cached message query on success.

### `useCreateProjectMutation()`

Creates a new project. Invalidates `['projects']` on success.

### `useUpdateProjectMutation()`

Updates a project. Invalidates `['projects']` on success.

### `useDeleteProjectMutation()`

Deletes a project. Invalidates `['projects']` on success.

### `useCreateLayoutMutation(projectSlug: string)`

Creates a new layout within a project. Invalidates project layouts on success.

### `useAddLayoutFromPluginMutation(projectSlug: string)`

Adds a layout from an installed plugin to a project. Invalidates project layouts on success.

### `useAddProjectLayoutFromPluginMutation()`

Adds a layout from an installed plugin to any project by passing `{ projectSlug, plugin }`.
Invalidates `['projects']` and the target project's layout list on success.

### `useKnowledgeDocsQuery(projectSlug, namespace?, config?)`

Fetches knowledge documents for a project, optionally filtered by namespace.

### `useKnowledgeStatusQuery(projectSlug, config?)`

Fetches the knowledge index status for a project.

### `useKnowledgeSearchQuery(projectSlug, query, namespace?, config?)`

Performs semantic search across a project's knowledge base.

### `useKnowledgeNamespacesQuery(projectSlug, config?)`

Fetches knowledge namespaces for a project.

### `useKnowledgeDocContentQuery(projectSlug, docId, namespace?, config?)`

Fetches the content of a specific knowledge document as a `string`. Disabled when `docId` is null.

### `useKnowledgeTreeQuery(projectSlug, namespace, config?)`

Fetches a namespace's directory tree as one root `KnowledgeTreeNode`; its
`children` are the top-level entries.

### `useKnowledgeFilteredQuery(projectSlug, namespace, filters, config?)`

Fetches the namespace's `KnowledgeDocumentMeta[]` matching `filters`, such as
`{ metadata: { status: 'draft' } }`.

### `useKnowledgeScanMutation(projectSlug)`

Requests the directory scan with optional extensions/include/exclude patterns
and invalidates document/status queries. A completed file-store scan is not
proof that every root is indexed for semantic search; indexing has separate
owners described in the [Knowledge guide](../guides/knowledge.md).

### `useKnowledgeSaveMutation(projectSlug, namespace?)`

Saves/uploads a document to the knowledge base.

### `useKnowledgeDeleteMutation(projectSlug, namespace?)`

Deletes a single knowledge document.

### `useKnowledgeBulkDeleteMutation(projectSlug, namespace?)`

Bulk-deletes knowledge documents.

### `useGitStatusQuery(location, config?)`

Accepts `{ projectSlug, workingDir }`, not a bare path. Disabled unless both
fields are nonempty. The request carries both to `/api/coding/git/status`;
the server owns Project/path admission. A response with `success: false`
currently becomes `null`, so that value is not proof of a clean repository.

### `useGitLogQuery(location, count?, config?)`

Accepts the same `{ projectSlug, workingDir }` location. Default count: 5;
disabled unless both fields are nonempty. A `success: false` envelope currently
becomes `[]`, which does not establish an empty repository history.

### `useProviderCommandsQuery(provider, config?)`

Reads `/api/orchestration/providers/:provider/commands`; disabled for a missing
provider. Station's slash-command caller selects `'acp'` after checking the
Agent catalog's `engineConnectionType`. This is provider-level command data,
not an Agent-specific durable catalog. The previously documented
`useAcpCommandsQuery` is not a current SDK export.

### `useAgentInvokeMutation(agentSlug: string)`

Agent invocation mutation returning a `useMutation` result. Use its completion
and error state; `mutate` being non-awaiting does not make effects fire-and-forget
or authorize an automatic retry.

```tsx
const { mutate } = useAgentInvokeMutation('my-agent');
mutate('Summarize this document');
```

### `useInvokeAgent<T>(agentSlug, content, options?, config?)`

Invokes an agent from a query function and caches the result. Cache key:
`['invoke', agentSlug, content, options]`. This is effectful, not an inert read;
query lifecycle/refetch policy can invoke it again. Prefer an explicit mutation
for a user action rather than treating this helper as an exactly-once command.

```tsx
const { data, isLoading } = useInvokeAgent('my-agent', 'Summarize this', {
  schema: { type: 'object', properties: { summary: { type: 'string' } } },
});
```

### `conversationQueries.list(agentSlug)`

Shared query-factory entry for agent conversation lists. Use this when a feature needs `useQueries` or other query-factory composition without reintroducing inline transport logic.

### `useApiQuery<T>(queryKey, queryFn, config?)`

Station's config-change event invalidates Trust bundle/report and Task answer
support queries within the current authority's query client. Trust readers
refetch invalidated data when remounted; Task answer support retains its
existing fresh-authorization mount policy. Disabled observers remain disabled.
Trust requests carry cancellation through API-base resolution and transport.
See [Trust query owners](../../packages/sdk/src/query-domains/trustBundles.ts)
and [the config-change consumer](../../src-ui/src/hooks/useServerEvents.ts).

Generic query hook for a caller-owned async function. It passes an AbortSignal;
the function must use it and handle HTTP status, response validation and
authority. The following host-supplied reader must already implement those
checks for the captured `requestScope`:

```tsx
const { data } = useApiQuery(
  ['my-data', requestScope.apiBase, requestScope.authorityKey],
  (signal) => readCustomData(requestScope, signal),
);
```

### `useApiMutation<TData, TVariables>(mutationFn, options?)`

Mutation hook with optional cache invalidation on success.

It does not turn a raw `fetch` callback into an authenticated, validated or
exactly-once operation. Here `saveCustomData` is a host-owned writer that
captures its destination and validates the response; it is not an SDK export.

If the success callback throws after the request completes, the caller receives
that error and the configured caches are still invalidated.

```tsx
const mutation = useApiMutation(
  (vars: { name: string }) => saveCustomData(requestScope, vars),
  { invalidateKeys: [['agents']] }
);
mutation.mutate({ name: 'new-agent' });
```

<a id="useinvalidatequery-querykey--void"></a>

### `useInvalidateQuery(): (queryKey) => Promise<void>`

Returns a stable function that invalidates matching query-key prefixes. Its
promise comes from React Query's invalidation; callers can await that operation
instead of assuming the request completes when invalidation is scheduled.

### `useQueryClient`

Re-exported from `@tanstack/react-query` for direct cache access.

---

## API Functions

Imperative API calls — use in event handlers, slash commands, or anywhere hooks aren't available.

### Turn steering and acknowledgement retries

`steerOrchestrationTurn({ threadId, text, turnId?, clientInputId?, apiBase? })`
sends input to an open turn. With an ID it uses the protected `steerTurnOnce`
wire command, which older servers reject before invocation. Without an ID it
retains legacy behavior. Use one stable `clientInputId` per intent and retain
its original Session, turn and text when retrying an acknowledgement. The server
journals the adapter attempt before invocation and returns a confirmed same-ID
result without sending it again. `outcome: 'indeterminate'` means delivery cannot
be confirmed; retain the input for review and do not automatically send it as a
new turn. Before retrying uncertain input, call
`inspectOrchestrationSteerInput({ threadId, text, turnId?, clientInputId, apiBase? })`.
A confirmed result retires the pending message; `indeterminate` or an unsupported
lookup keeps it held. Only `not-received` permits a protected same-ID first
attempt. A successful save of the pending identity precedes a composer mutation;
a failed save prevents engine invocation. Unsupported, busy, and no-active-turn outcomes remain
explicit. See [Session API steering](session-api.md#lifecycle-control-commands) for the public
command and engine-specific interruptive fallback; Station's composer offers a
conservative safe-waiting fallback separately from native steering.


`sendMessage`, `streamMessage`, `invokeAgent`, `invoke`, `callTool` and
`fetchConfig` are legacy ambient-base helpers using direct `fetch`. They do not
automatically use the host's native or encrypted broker transport. For those
hosts, choose client/Session operations that cover the required workflow and
accept an explicit API base and current request options.

### `resolveConversationOpen(conversationId, apiBase?): Promise<ConversationOpenResolution>`

Resolves one inventory row under the server's request-derived authority before
a caller treats it as a writable Session. The discriminated result is
`resolved`, `missing-session`, or `unavailable`; only the `resolved` arm can
carry a current Session identity and a server-derived
`canContinue` decision. Transport, rejection, and invalid wire failures throw a
typed `ConversationOpenResolutionFailure` rather than degrading to an empty
chat.

Import this exceptional-path API from
`@kontourai/station-sdk/conversation-open`. Keeping it on a dedicated subpath
prevents the parser and transport from joining the initial application bundle
through the root SDK barrel.

### `sendMessage(agentSlug, content, options?): Promise<any>`

Posts to the framework's `/agents/:id/text` route and returns its JSON response.
This is not the canonical orchestration chat/Session API and does not dispatch
an arbitrary external-engine Agent. Use the bound chat actions or the
[Session API](./session-api.md) for that workflow. Request authorization,
available runtime Agents and provider configuration still apply.

```ts
interface SendMessageOptions {
  model?: string;
  conversationId?: string;
  userId?: string;
  attachments?: Array<{ type: string; content: string; mimeType?: string }>;
}
```

```ts
const result = await sendMessage('my-agent', 'Hello', { conversationId: 'abc' });
```

### `streamMessage(agentSlug, content, options?): Promise<void>`

Posts to the framework's `/agents/:id/stream` route. `onChunk` receives decoded
transport chunks, including SSE framing; the helper does not parse them into
message text or canonical Session events. Transport chunk boundaries are not
event boundaries. `onComplete` means the response body ended, not that a
canonical turn-completion receipt was observed.

```ts
interface StreamMessageOptions extends SendMessageOptions {
  onChunk?: (chunk: string) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}
```

```ts
await streamMessage('my-agent', 'Explain this', {
  onChunk: (chunk) => rawStreamParser.feed(chunk),
  onComplete: () => rawStreamParser.end(),
});
```

`rawStreamParser` is caller-supplied and must understand the framework's event
format. For Station's user-facing chat, prefer its canonical Session stream.

### `invokeAgent(agentSlug, content, options?): Promise<any>`

Invokes an Agent without creating a Dock entry. Supply a JSON Schema object,
not a Zod instance, in `schema`. The named-Agent route adds it to the prompt and
attempts to parse JSON from the response; it does not validate the result against
that schema, and parsing failure leaves the response as text. Runtime
permissions and provider/approval behavior still apply. An
indeterminate invocation error means work may have started and is not a safe
automatic-retry signal.

```ts
const result = await invokeAgent('my-agent', 'Extract the title', {
  schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
});
```

### `invoke(options: InvokeOptions): Promise<any>`

Runs an invocation without a named Agent or Dock entry, with optional tool steps.
It selects `model`, then app `invokeModel`, then app `defaultModel`. A supplied
JSON Schema triggers a separate structured-output pass; `structureModel` falls
back through the app setting to the invocation model. This can involve more than
one provider call. `invoke` returns only the response; `invokeWithRunReceipt`
also returns available `runId`/`relatedRunIds` for the native-invocation ledger.

```ts
interface InvokeOptions {
  prompt: string;
  schema?: any;
  tools?: string[];
  maxSteps?: number;
  model?: string;
  structureModel?: string;
  system?: string;
}
```

```ts
const result = await invoke({
  prompt: 'What is 2+2?',
  schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
});
```

The [SDK calls](../../packages/sdk/src/api-agent-runtime.ts),
[named-Agent handler](../../src-server/routes/agents/invoke-agent.ts), and
[global handler](../../src-server/routes/agents/invoke-global.ts) have different
structured-output paths. An invocation receipt is not a chat Session.

### `callTool(agentSlug, toolName, toolArgs?): Promise<any>`

Calls the Agent tool route and unwraps its operation response. Server policy,
tool routing and response handling still apply; this is not a policy bypass or
a guarantee that the provider's raw wire payload is returned unchanged.

```ts
const data = await callTool('my-agent', 'get_account', { id: '123' });
```

### `fetchConfig(): Promise<any>`

Reads `/config/app` and returns the JSON envelope, including its `success` and
`data` fields. Unlike `useConfigQuery`, it does not unwrap `data`. This legacy
helper uses direct `fetch` with plugin headers, not the scoped client transport.

### `createChatSession(agentSlug: string, sessionId: string, title?: string): Promise<void>`

This exported compatibility function currently rejects with
`createChatSession must be implemented by core app`. The default shared runtime
does not replace it. Use the bound `useCreateChatSession` or `useLaunchChat`
host action for the Dock; do not present this export as a working imperative
Session-creation API.

### `fetchAvailableLayouts(): Promise<any[]>`

Reads and validates the layout-source catalog used when adding layouts to
Projects. Entries retain their lifecycle/availability fields; catalog presence
does not mean a layout is installed and ready to load.

### `fetchProjectConversations(projectSlug: string, limit?: number): Promise<any[]>`

Fetches recent conversations for a project, with a default limit of 10. The
underlying [legacy helper](../../packages/sdk/src/api-knowledge-utils.ts) uses
`allowFailure`, returning `[]` for HTTP refusals, false or malformed envelopes,
or missing `data`. Network and JSON-decoding errors still reject. Consumers
must not use this helper's empty array as proof that the Project has no history.

### `addProjectLayoutFromPlugin(projectSlug: string, plugin: string): Promise<any>`

Adds a layout from an installed plugin to a project.

### Knowledge API Functions

Project Knowledge reads and writes use the active Station's authenticated
transport. A saved encrypted broker route never sends Knowledge documents or
rules through a direct Station HTTP request.

#### `fetchKnowledgeDocs(projectSlug: string, namespace?: string): Promise<any[]>`

Lists knowledge documents for a project.

#### `fetchKnowledgeStatus(projectSlug: string): Promise<any>`

Gets the knowledge index status for a project.

#### `fetchKnowledgeDocContent(projectSlug: string, docId: string, namespace?: string): Promise<string>`

Gets the content of a specific knowledge document.

#### `fetchKnowledgeNamespaces(projectSlug: string): Promise<any[]>`

Lists knowledge namespaces for a project.

#### `searchKnowledge(projectSlug: string, query: string, namespace?: string): Promise<any[]>`

Performs semantic search across a project's knowledge base.

#### `uploadKnowledge(projectSlug: string, filename: string, content: string, namespace?: string, metadata?: Record<string, any>): Promise<any>`

Uploads a document to the knowledge base.

#### `scanKnowledgeDirectory(projectSlug: string, options?: { extensions?: string[]; includePatterns?: string[]; excludePatterns?: string[] }): Promise<any>`

Triggers a directory scan to ingest documents.

#### `updateKnowledgeNamespace(projectSlug: string, nsId: string, data: any): Promise<any>`

Updates a knowledge namespace configuration.

#### `deleteKnowledgeDoc(projectSlug: string, docId: string, namespace?: string): Promise<any>`

Deletes a single knowledge document.

#### `bulkDeleteKnowledgeDocs(projectSlug: string, ids: string[], namespace?: string): Promise<any>`

Bulk-deletes knowledge documents.

#### `fetchAcpCommands(agentSlug: string): Promise<AcpSlashCommandDescriptor[]>`

This previously documented API is not a current SDK export. Use
[`useProviderCommandsQuery`](#useprovidercommandsqueryprovider-config) for the
current provider-level command list; Station's caller selects the ACP provider
after checking the Agent's engine connection.

#### `fetchAcpCommandOptions(agentSlug: string, partial: string): Promise<AcpSlashCommandDescriptor[]>`

This previously documented API is not a current SDK export. The current external-engine
interface has no per-keystroke command-option channel, and Station's slash
command hook supplies only the command catalog. See
[the caller](../../src-ui/src/hooks/useSlashCommands.ts) and
[ACP command support](../guides/acp.md#slash-commands).

---

## Portable Project identity

The React-free `@kontourai/station-sdk/project-identity` entry point exports
`getProjectIdentity`, `prepareProjectIdentity`, `attachProject`, and
`updateProjectExecutionRoot`. Each takes
an explicit Station API base and `ClientRequestOptions`; pass the authenticated
request scope and credential options for that particular Station. Identity reads
use the Project family's read permission; preparation and attachment require its
operate permission. These operations do not grant remote access or membership.

`parseProjectPortableIdentity(value)` on
`@kontourai/station-sdk/project-identity` validates imported portable snapshots
using the same closed rules as identity response reads. The CLI's identity and
attachment commands consume it before calling the existing `attachProject` API.
Unknown fields and local binding data are refused; receiver authorization and
live checkout validation remain at the receiving Station.

`getProjectIdentity(apiBase, slug, options)` reads an existing portable identity
without writing. A legacy Project with no identity returns an error until
`prepareProjectIdentity` explicitly derives one. The local Project ID remains
unchanged. A `ProjectPortableIdentity` snapshot contains the portable ID,
repository references and timestamps; it contains no checkout path or grant.

```ts
import {
  attachProject,
  prepareProjectIdentity,
} from '@kontourai/station-sdk/project-identity';
import type { ClientRequestOptions } from '@kontourai/station-sdk/client';

async function attachProjectOnStation(
  source: { apiBase: string; slug: string; options: ClientRequestOptions },
  destination: { apiBase: string; options: ClientRequestOptions },
) {
  const { identity } = await prepareProjectIdentity(
    source.apiBase, source.slug, source.options,
  );
  return attachProject(destination.apiBase, {
    name: 'Example',
    slug: 'example',
    workingDirectory: '/srv/projects/example',
    identity,
  }, destination.options);
}
```

When supplied, `workingDirectory` must already exist on that Station and satisfy
the primary resource. The field is optional: omitting it uses the local Project
creation default and does not verify a checkout. Attachment does not clone,
synchronize files, copy credentials
or move a room's authority. The server publishes the new local Project and its
identity together; the result distinguishes `created` from an unchanged
`existing` attachment. Its association contains the shared `portableProjectId`
and the receiver-owned `localProjectId`/`localProjectSlug`.

A same-slug Project with different identity or configuration is a conflict; a
matching Git remote never merges existing Projects or private history. Changed
configuration needs its existing explicit update/bind operation. Multiple local
names are not an automatic execution-selection policy. A timed-out write may
have committed: inspect the requested local association before deciding on a new
operation. A read cannot recreate a deleted Project.

The SDK validates the returned version, resource shape and association and
captures attachment input before asynchronous work. An incompatible or older
server produces an error, never an ordinary local-creation fallback. The full
portable target picker, shared-member authorization and cross-machine execution
admission remain separate consumers of this identity API.

`updateProjectExecutionRoot(apiBase, slug, input, options)` sets a declared
resource and repo-relative directory, or clears the selection with `null`.
`input.expectedIdentity` and `input.expectedLocalProjectId` must come from one
current identity view; a concurrent Project or identity change returns a conflict. The mutation
is idempotent and does not inspect, create, or bind a checkout. The selected
directory is verified only when execution later resolves it on that Station.

See the [client](../../packages/sdk/src/client/project-identity.ts),
[route](../../src-server/routes/projects/project-identity-routes.ts),
[identity service](../../src-server/services/projects/project-identity-service.ts),
and [execution resolver](../../src-server/services/execution-target/execution-target-resolver.ts).

## Project access administration and account entry

For a verified virtual transport, `@kontourai/station-sdk/application-session`
exports `createApplicationSessionKey`, `ApplicationSessionClient` and the low-level
proof builder. Keep the non-extractable key in dedicated credential custody, never
in a Project manifest or ordinary query cache. Pass the actual client origin, the
verified Station id and the existing scoped Device transport:

```ts
import { ApplicationSessionClient, createApplicationSessionKey } from '@kontourai/station-sdk/application-session';

const key = await createApplicationSessionKey();
const accounts = new ApplicationSessionClient(apiBase, verifiedStationId, clientOrigin, deviceRequestOptions, key);
const continuation = await accounts.establish({ username, password });
const accountHeaders = await accounts.headers(continuation, { method: 'GET', url: requestUrl });
// Send with the SAME Device request scope and authenticated encrypted transport.
// accounts.renew(continuation) preserves authorityKey; accounts.revoke signs out.
```

For a browser already signed in on the Station's same HTTPS origin, call
`accounts.adoptCookies()` with a key from `createApplicationSessionKey()`. The
browser sends its existing `__Host-station-device` and provider cookies through
`credentials: 'same-origin'`; the SDK never reads or copies cookie values into
JavaScript. Adoption returns a short-lived account continuation and a bounded,
read-only alias for that same approved Device. Keep the alias with its
continuation and send both on each protected request.
`accounts.revokeAlias(alias, continuation)` revokes that alias only and leaves
the provider account session and parent Device grant intact. Cookie adoption
requires direct same-origin HTTPS; a virtual transport has no cookie authority
and cannot run this step.

Calling `establish()` without credentials uses native HTTPS cookie exchange;
virtual-only login requires its separately advertised provider capability. The
relay forwards headers/body and respects response backpressure; it does not own
account cookies, proof verification or membership logic. See the
[application-session protocol](../guides/deployment-authentication.md#application-sessions-over-virtual-transports)
for expiry, origin, replay and revocation behavior.

### Native Station account continuation (opt-in)

`@kontourai/station-sdk/application-session-native` is the opt-in native v1
account-continuation client for Station's own native installation surface. It
consumes the `station.application-session-native/v1` contract and a
**caller-supplied encrypted application-channel transport**
(`NativeApplicationSessionTransportV1`); the client itself never opens an HTTP
connection, never touches cookies, and never holds a broker bearer. The account
proof key must be independent of the native broker route proof key. The client
accepts the portable `ApplicationSessionSigner`;
`createApplicationSessionKey()` supplies a non-extractable WebCrypto P-256 key.
Signer custody is a caller responsibility, not attested by the facade. The
caller owns the trust snapshot: exact Station ID, canonical HTTPS Station
audience (or loopback HTTP for a local fixture), full approved native surface,
and the approved Device ID; the
snapshot is re-read before every operation and any mismatch (Station, audience,
surface, device, key thumbprint, expiry, replayed challenge, reused JTI) fails
closed.
Exchange proofs sign the exact JSON serialization of provider credentials that
Station forwards to the configured provider; request
proofs bind method, path, audience, surface, device, continuation nonce and
credential hash with a one-use JTI. Provider, Device, and Project authority
remain separate: the continuation is not a bearer or Device grant, and this
client implements no provider/Device/Project authority.

The constructor also accepts `NativeApplicationSessionProofProvider`, identified
by `kind: station-native-host-proof-provider/v1`. Its `prepareExchange` operation
takes only opaque challenge data and local username/password credentials and
returns the complete host-prepared exchange body plus matching proof header.
`requestHeaders` takes opaque continuation data and a canonical GET/HEAD
target from the fixed Station health and member Project read inventory. The client checks the returned signature, public key, target, nonce,
hashes, body order and headers before dispatch. The ordered host credentials
body is retained: its hash must match Node's `JSON.stringify` of the credentials
the server parses, including Unicode. Other provider credential shapes are
unsupported by this native provider path.

Prepare the account exchange body before application-channel body freezing;
the later Device proof binds that complete body, including the account proof.
Native IPC uses these structured operations, never an adapter for `sign(bytes)`.
The native account operation handle is bounded, owner/epoch-fenced and allows
one exchange. An unknown exchange outcome requires an explicit new context and
challenge; it is not retried automatically. Expiry hints cannot extend host
lifetimes. Provider sessions, replay, Device binding and Project membership are
still verified by the server. This interface alone does not enable sign-in or
qualify a packaged/native IPC journey. Station now composes it through the
[production account bridge](../../src-ui/src/platform/native/nativeAccountSessionBridge.ts),
[selected connection owner](../../src-ui/src/platform/native/nativeRelayConnectionOwner.ts),
and [ApiBaseContext](../../src-ui/src/contexts/ApiBaseContext.tsx). The ordinary
[account panel](../../src-ui/src/views/connections-hub/RelayRouteProfiles.tsx)
uses that owner for sign-in, typed invitation acceptance and remote logout.
Public scope lives only in the process and partitions the
[ephemeral member shell](../../src-ui/src/views/native-relay/NativeRelayMemberShell.tsx);
authority loss clears its cache. Those source consumers and a reachable
simulator UI entry do not establish a fresh or physical native journey.

```ts
import { NativeApplicationSessionClient } from '@kontourai/station-sdk/application-session-native';

const accounts = new NativeApplicationSessionClient(encryptedTransport, () => trustedSnapshot, key);
const continuation = await accounts.exchange({ username, password });
const headers = await accounts.headers(continuation, { method: 'GET', path: '/api/projects' });
```

The native preparation RPC returns `contextExpiresAtMs`, the host's actual
preparation deadline clipped to its captured routing grant. The production
bridge requires this closed DTO field and passes it to the proof provider.
The SDK captures that optional provider deadline once, clamps the continuation
and public account expiry to the earlier host/server deadline, and refuses
later read, invitation-acceptance or revoke preparation at that deadline. A
delayed sign-in never extends the host context. Compatibility SDK signers
without a native context deadline retain their existing behavior; production
native RPCs always supply it. Removing local account scope does not remove
Device custody.

The host proof provider may implement `prepareInvitationAcceptance({continuation, token})`.
`NativeApplicationSessionClient.prepareInvitationAcceptance(continuation, token)`
validates the exact token-only body and host account signature, rejects reused
JTIs or changed targets, and returns frozen body/headers for **only**
`POST /api/account-auth/accept-invitation`. It does not broaden the existing
GET/HEAD `requestHeaders` operation or accept generic signing bytes.
`requestHeaders` remains limited to Station health/authority, Project list/detail and
Project-scoped shared-work document/history/publication. Only well-known/status/
identity observations may omit account material; authority and member reads
require the current separate account, and invalid supplied account material
never falls back to Device-only access. Send the prepared invitation
body through the current native application transport: the separate Device
proof authenticates its exact bytes, and the server independently rechecks the
real account, Device binding and invitation/membership owner. No browser Origin
or cookie conversion is part of this request.

The optional host operation `prepareRevocation({continuation})` and client
`prepareRevocation(continuation)` return a frozen empty body and validated proof
headers for only `POST /api/account-auth/continuations/native/revoke`. The server
requires the current native Device and separate account continuation, removes
that exact continuation before awaiting actual provider revocation, and confirms
that provider session is no longer valid before returning `{revoked: true}`.
Device custody and grants remain intact. The native bridge's `logout()` clears
local account scope even when the remote outcome is uncertain; a rejected or
lost acknowledgment never means remote logout completed. Its `retire()` remains
local removal only. A new account context is required for reauthentication.

The native bridge parses invitation acceptance into
`ProjectInvitationAcceptance` from the shared `project-membership` contract:
exact Station/local/portable Project scope and `grantsDeviceAccess: false`.
An arbitrary HTTP 200 or a foreign Station response does not confirm membership.

### Fresh relay enrollment proof helpers

`@kontourai/station-sdk/relay-enrollment` exposes `createRelayEnrollmentKey`,
`restoreRelayEnrollmentKey`, `createRelayEnrollmentLoginProof`,
`createRelayEnrollmentFinalizeProof`, `digestRelayEnrollmentBundle`, and
`createRelayEnrollmentActivationProof` for the versioned fresh relay-account
ceremony. The signing key is non-extractable
P-256 custody, and the proof binds the Station, configured client Origin,
enrollment attempt, key thumbprint, nonce, method, path, purpose, and short
expiry. Keep the key in platform credential custody. The login proof authorizes
only a provider-side candidate identity; the operator must still approve the
account binding, and the server separately activates a narrow Device after a
signed delivery acknowledgment. The SDK helper does not transport cookies,
Device credentials, or continuations.

```ts
import {
  createRelayEnrollmentKey,
  createRelayEnrollmentLoginProof,
} from '@kontourai/station-sdk/relay-enrollment';

const key = await createRelayEnrollmentKey();
const proof = await createRelayEnrollmentLoginProof(key, challenge, {
  method: 'POST',
  url: `${stationOrigin}/.well-known/station/v1/relay/enrollment/login`,
  clientOrigin,
});
```

The enrollment wire shapes live in
`@kontourai/station-contracts/relay-enrollment`. This proof is distinct from
application-session proof and cannot establish an ordinary authenticated
account session. If finalize delivery is uncertain, do not retry finalize or
expect the same secret bundle to be returned: Station discards that inert
attempt and the client starts a fresh enrollment. Activation ACK may be retried
only with the same signed proof; Station returns the stored receipt only when
its digest matches the committed ACK.

### Native Device request proof (protocol foundation)

`@kontourai/station-sdk/native-device-proof` exports
`createNativeDeviceRequestProof`. It accepts a caller-supplied signer whose
private P-256 Device key remains in native host custody, a trusted approved
Device binding, and the exact method, path with query, and transmitted body
bytes. Its compact ES256 JWS binds that request to the Station audience, Device
and binding IDs, native route surface, **separate** Device-key thumbprint,
unique Pion peer nonce, one-use JTI and a 30-second expiry. The route key in
`surface.keyThumbprint` is not the Device key. The 16 KiB body limit matches
the current application-channel pilot. The helper never receives a Device
bearer, account continuation, broker secret or provider credential.
The canonical path may contain up to 2,048 characters, but the complete compact
JWS must fit 4,096 characters. A combination of long path and surface fields
can exceed that aggregate bound; the helper refuses it before invoking the signer.

The source-opt-in server pilot under #2893 stores operator-approved bindings,
verifies the JWS and exact body against private native peer provenance, consumes
replay state before dispatch, and applies independent current Device, account
and Project authorization. The source-opt-in native producer permits only
fixed account challenge/exchange/revoke, invitation acceptance, neutral Station
health observations, and member Project/shared-work document/history/publication
reads. Each write control has a separate fixed host preparation operation; the
read signer remains GET/HEAD only. Operator configuration, terminal, catalog,
and contribution writes are excluded. Source and focused runtime checks do not
establish a packaged or physical-device native journey.

`listProjectViews(apiBase, options)` and `getProjectView(apiBase, slug, options)`
from `@kontourai/station-sdk/client` return either the personal/operator Project
shape or a validated `MemberProjectView` from
`@kontourai/station-contracts/project`. The member variant has
`kind: 'member-project'`, `version: 'station.member-project/v1'`, identity/display
fields and effective `actions`; it excludes local paths, provider configuration
and other private Project settings. Unknown versions, additional fields and
malformed member data are refused. `useProjectsQuery` uses this union for the
catalogue. Legacy `listProjects`, `getProject` and the full-configuration
`useProjectQuery` refuse member views; callers that support guests must choose
the view API and narrow its variant before using full-configuration fields.
The first account-bound Device profile exposes only the `view` action; it does
not imply edit, execution or administration support.

`@kontourai/station-sdk/project-shared-tasks` exposes the first bounded shared
Task read surface. `listProjectSharedTasks(apiBase, slug, options)` returns only
Tasks an operator explicitly published for the caller's current Project scope.
`readProjectSharedTaskHistory(...)` returns bounded `human-message` bodies with
human or agent attribution; this body-kind filter does not mean every author is
human. Structured tool events, attachment metadata and room
write authority are excluded. Human messages and shared documents are returned
verbatim without redaction and may themselves contain paths, secrets, or other
private text. `readProjectSharedTaskDocument(...)` returns the current text
snapshot. Each response is limited to one MiB and validated without extra
fields. The current server reports an incomplete history page as `unavailable`.
Callers also treat `hasMore`, gap, stale or invalid-cursor results as incomplete;
unavailable and too-large results retain their named states. None is an empty
complete history, and none permits inferring private records.
`getProjectSharedTaskPublication(...)` gives a member
`{ kind: 'shared', publication }`, where `publication` is the same summary the
list returns for that Task. An unshared, stale, unknown or other-scope Task
refuses with the same not-found error, so a member cannot tell those cases
apart. Member pages read history and document only after that publication
matches the listed item.

These reads require the current account-bound Device, account session and active
Project membership. Station rechecks the exact Project, publication and Task
incarnation during admission and before response delivery, so membership,
Device or publication revocation closes an in-flight read. A Project membership
does not publish every Task. Project owner/admin publication remains pending;
the initial management surface requires current Station operator authority.

Operators can use `getProjectSharedTaskPublication`, `shareProjectTask`, and
`unshareProjectTask` from the same SDK subpath. Only an operator's publication
review also reports `unshared`; sharing and unsharing stay operator-only. Capture one `ApiRequestScope`
before review and pass it to the read and mutation. The review returns the full
Station/local/portable Project scope plus the exact Task id and creation time.
Send that identity back unchanged when publishing or revoking; revocation also
requires the current `shareId`. A same-slug Project replacement, replaced Task,
rotated share, or changed request authority refuses the command. Refresh after
any refusal instead of retrying stale review data. Older operator integrations
may still issue the original bodyless PUT; UI management uses the review-bound
form.

`@kontourai/station-sdk/relay-management` exposes
`getRelayManagementCapabilities`, `getRelayManagement`, `approveRelaySetup`,
`revokeRelaySetup`, `createRelayInvitation`, `approveRelayDevice`, and
`denyRelayDevice`. Pass the selected Station API base and one captured
`ClientRequestOptions.requestScope` throughout review and mutation. Responses
are strictly validated and bounded to 256 KiB, with a 35-second timeout. Setup
links must match their route, approvals must match the Station/enrollment, and
pending Devices must name that Station. `createRelayInvitation` also takes the
reviewed route, recipient setup and a `RelayInvitationLifetime`; it validates
the returned installation binding and requested expiry before returning the
link. Lifetimes are `5m`, `15m`, `1h`, `24h` and `never`; the UI chooses `24h`.
Every invitation remains single-use.

This published SDK leaf consumes the canonical codec from
`@kontourai/station-shared/native-relay-link`, not the private Connect package.
Connect's existing codec entry remains a compatibility re-export; the move
adds no parser, trust decision or native secret-custody capability.

These clients require current operator or explicitly promoted `relay:manage`
authority. Native management POSTs use a dedicated fixed host account operation;
generic account read preparation remains GET/HEAD only. The closed Project
access leaves still require Project IAM. This scope adds no terminal, Agent,
or shared-Task publication authority. Account-bound management requires the
exact native relay leaves, current Device/account binding and session, and
separate `relay:manage`. Credential-only account-bound Devices remain refused;
capabilities are neutral false without management authority. Source availability
is not release or physical-device qualification.

`@kontourai/station-sdk/project-access-client` exports `getProjectAccess` and
`changeProjectAccess`. Both take the selected Station API base, local Project
slug and explicit `ClientRequestOptions`. Reads return the acting principal,
exact Station/local/portable Project scope, members and invitations. Commands
enable sharing, invite or revoke invitations, change a member, or transfer
ownership. Capture the returned scope and member revision for writes; do not
reconstruct authority from a slug or email. Enabling requires the expected local
Project ID and current Station operator authority.

`@kontourai/station-sdk/project-access` also exports `useProjectAccess(slug,
requestScope)`. Its query keys include the selected Station and authority, and
its mutations capture that scope before asynchronous work. Do not persist
administrative projections or invitation tokens in application caches. Project
administration grants no Station settings, device or compute authority.

Cookie-authenticated callers (the guest administration journey) additionally
pass `expectedActor` on the invite, invitation-revoke, member-change, and
transfer commands: the principal id the acting page was rendered for. The
server compares it against freshly authenticated authority before committing
and refuses with `forbidden` on mismatch, so a page whose HttpOnly cookies
were replaced in another window cannot commit its stale intent as the new
principal. The field is optional; omitting it preserves existing operator
behavior. It grants nothing — it is a comparison against authenticated
authority, never authority granted by a client claim.

`@kontourai/station-sdk/account-authentication` exports
`getAccountAuthentication(apiBase)`, `getAccountSession(apiBase, { signal? })` and
`runAccountOperation(apiBase, endpoint, body, invitation?)`. These use the fixed
account namespace with account cookies and explicitly omit ambient operator
bearers. Use the account page's own browser origin. A session read returns
`null` for an unauthenticated account; an unavailable or incompatible service
remains an error. Choose operations from the provider descriptor; the optional
invitation argument is registration eligibility, not authentication or membership.
Abort the session read when its Station or expected account context changes;
delivery after that boundary must not repopulate guest authority or query data.
The [deployment authentication guide](../guides/deployment-authentication.md)
defines the provider interface and separate invitation-acceptance operation.

`getAccountAuthentication` on `@kontourai/station-sdk/account-authentication`
may return `externalLogins` alongside the primary password or redirect login.
Each choice supplies `id`, `displayName`, a declared Station `startPath`, and an
optional `available` flag. A false flag means the configured choice is unavailable.
To begin, call `runAccountOperation(apiBase, choice.startPath, {}, invitation)`;
the successful operation returns `{ url }` for browser navigation. Keep the
invitation in its dedicated header and validate the returned destination before
navigation. Never attach a personal/operator credential to this account operation.

Station chooses provider/callback/return parameters from operator configuration;
clients cannot supply arbitrary OAuth parameters. See the [deployment guide](../guides/deployment-authentication.md#optional-oidc-choices-with-local-accounts)
for configuration, callback verification and the independent Device continuation.

The same account-authentication entry exports `getProjectInvitationPreview(apiBase,
token)`. It uses a POST body, validates the minimal Project/inviter/role projection,
and rejects incompatible role/action combinations. Keep the proof out of query
cache keys and persisted data. Preview success does not authenticate a person,
consume the invitation or grant membership.

An invitation command's `email: null` explicitly creates a single-use link for
any authenticated holder. A string restricts acceptance to that verified email;
do not silently omit or clear a requested restriction. The descriptor may select
`username-password` login so local account registration needs no email service.

`@kontourai/station-sdk/local-accounts` exports `getLocalAccounts(apiBase,
options)` and `changeLocalAccount(apiBase, accountId, action, options)` for current
Station operators. Actions disable/enable sign-in, revoke sessions or create a
one-time recovery link. Capture the selected Station request scope, require
explicit confirmation and keep recovery links out of persisted caches. External
providers return a guidance projection instead of local account controls.

`@kontourai/station-sdk/authority-observation` exports
`getAuthorityObservation(apiBase, options)` for the closed, credential-bound
answer to "what authority is this request acting as": the current public home
identity, the server-resolved effective principal (kind+id only, no contacts),
and the verified grant tier (operator, or paired Device with its public Device
id and granted scopes). The read is authorization-neutral — it describes
authority and grants nothing — and fails closed on absent, conflicting, or
revoked authority, never a guessed identity. Pass the SAME `ClientRequestOptions`
(request scope, credential, headers) as the caller's other protected requests;
validate the closed shape before caching or comparing the public identity tuple.

The account/Project boundary is implemented by the
[application-session client](../../packages/sdk/src/client/application-session.ts)
and [service](../../src-server/services/identity/application-session-service.ts),
[relay enrollment helpers](../../packages/sdk/src/client/relay-enrollment.ts)
and [service](../../src-server/services/identity/relay-enrollment-service.ts),
[Project access client](../../packages/sdk/src/client/project-access.ts)
and [membership service](../../src-server/services/projects/project-membership-service.ts),
and [shared Task routes](../../src-server/routes/projects/project-shared-tasks.ts).
The separate [account client](../../packages/sdk/src/client/account-authentication.ts)
and [authority reader](../../packages/sdk/src/client/authority-observation.ts)
keep account login and the current request's observed authority distinct.

## Plugin Query Hooks

React Query wrappers for plugin management. Use these instead of raw `useQuery`.

Direct and registry install mutations return `PluginInstallResult` from
`@kontourai/station-contracts/plugin`. The same type is returned by
`requestPluginRegistryInstallAction` and `requestRegistryCatalogAction('plugins', ...)`;
other catalog tabs retain their existing `InstallResult` contract.
`result.permissions?.dependencies` is the current installed dependency permission
status, not the preview requirement list. An absent status on an older server is
unknown; it must not be replaced with an empty list or inferred from preview.
Each present dependency row has an `id` and typed `pendingConsent` permission/tier
entries. Trusted permissions still require separate host-owned approval.

### Marketplace source hooks

`useRegistrySourcesQuery()` reads `GET /api/registry/sources` through the current
SDK request scope. Source reads and actions require `access:manage` plus the
Station operator principal; the hooks do not grant that authority.
`useRegistrySourceActionMutation()` accepts `{action, id?,
source?}` with `add`, `enable`, `disable`, `remove` or `refresh`; `add` supplies
`{displayName, adapter, location}`. Mutations invalidate Registry queries.
`useRegistrySkillContentQuery(id)` inspects the unchanged opaque catalog
selection ID and is disabled without an ID. These hooks use the existing
React Query/request authority rather than a separate marketplace cache.

Published `RegistrySource`, `RegistryCatalogSelection`, `SkillRegistryProvider`
and `PluginRegistryProvider` types live in `@kontourai/station-contracts/catalog`.
A provider's catalog metadata is untrusted publisher input. Source identity,
selection/revision binding and current plugin visibility remain host-owned;
registering a provider neither installs its content nor grants permission.
Skill providers can expose `getPackageRevision` and enforce its value in
`install`'s `expectedPackageRevision`. Plugin providers resolve fresh package
source/claims through the existing installer and applied trust policy.
`getCatalogSnapshot()` can return `PluginRegistryCatalogSnapshot`: the item
rows, package source/claim pairs and revision from one fresh observation.
Station manifest providers use that observation together; metadata and claims
remain untrusted until the existing acquisition authority verifies them.

### `usePluginsQuery(config?)`

Fetches all installed plugins. Cache key: `['plugins']`.

### `usePluginUpdatesQuery(config?)`

Checks for available plugin updates. Cache key: `['plugin-updates']`.

### `usePluginLocalSourcesQuery(config?)`

Imported from `@kontourai/station-sdk/plugin-local-sources-query`, not the
root barrel. For each Project whose folder is the source of an installed local-folder
plugin, whether the folder still holds the installed code:
`PluginLocalSourceStatus` from `@kontourai/station-contracts/plugin`, with
`status` `unchanged`, `changed` or `unknown` (and a `reason` for `unknown`).
It names the plugin and the Project, never a host path. Operator-only: any
other viewer receives an empty list. Reinstalling a `changed` source is the
ordinary preview, consent and `usePluginInstallMutation` with
`dataPolicy: 'preserve'`; this query decides nothing. Cache key:
`['plugin-sources']`.

### `useRegistryPluginsQuery(config?)`

Fetches plugins available in the registry. Cache key: `['registry-plugins']`.

### `usePluginSettingsQuery(pluginName, config?)`

Fetches plugin settings schema and current values. Disabled when `pluginName` is undefined.

### `usePluginChangelogQuery(pluginName, config?)`

Fetches changelog metadata for a plugin. Disabled when `pluginName` is undefined.

### `usePluginProvidersQuery(pluginName, config?)`

Fetches provider override state for a plugin. Disabled when `pluginName` is undefined.

### `usePluginInstallMutation()`

Installs a plugin from a source URL. Invalidates plugins, layouts, and agents caches on success.

For verified registry acquisitions, carry the preview's optional
`registryTrustRevision` in root and dependency consent. The normal SDK/CLI/UI
paths forward it; it is an opaque precondition, not caller-supplied verification.
The server obtains the claim and signing policy from host owners and returns
`registry-trust-refused` with a closed reason when the review or continuity no
longer matches. See [registry trust policy](../design/registry-trust-policy.md).

`consent` is required (archive#4288). It records the operator's decision from
the preview they read: the permission set the preview derived, the digest of
the bytes it staged, and the dependency ids it resolved. The server re-derives
the current requirements and compares the approval with its staged copy,
refusing when they disagree.
When an open install proposal names the source, or Station previously
installed it without its git metadata, the preview reports
`gitMetadata: "excluded"`; echo it in `consent`. The server refuses with HTTP
409 (`consent.reason: "git-metadata"`) an install of such a source whose
consent omits it, and asks for a fresh preview.
Source acquisition and scratch staging can already have occurred; refusal is
not a promise that no filesystem work happened.

The consent body binds reviewed bytes and revisions, but by itself does not
prove that a person read the preview. Request authorization and trusted
host-owned approval are separate checks; an arbitrary Station credential is
not sufficient for every lifecycle operation. A recorded trusted grant also
does not prove runtime activation: inspect reconciliation and current status.

```tsx
const { mutate } = usePluginInstallMutation();
mutate({
  source: 'https://github.com/org/my-plugin.git',
  skip: ['agent:plugin:chat'],
  consent: {
    registryTrustRevision: preview.registryTrustRevision,
    grantRevision: preview.grantRevision,
    permissions: preview.permissions.required,
    contentDigest: preview.contentDigest,
    ...(preview.gitMetadata ? { gitMetadata: preview.gitMetadata } : {}),
    dependencies: preview.dependencies.map((entry) => entry.id),
    dependencyApprovals: preview.dependencies.flatMap((entry) =>
      entry.consent
        ? [{
            id: entry.id,
            registryTrustRevision: entry.consent.registryTrustRevision,
            grantRevision: entry.consent.grantRevision,
            permissions: entry.consent.permissions,
            contentDigest: entry.consent.contentDigest,
            dependencies: entry.consent.dependencies,
          }]
        : [],
    ),
  },
});
```

### `usePluginPreviewMutation()`

Previews a plugin before installing. Returns manifest, components, conflicts,
resolved dependencies, the derived `permissions` (`required`, `autoGranted`,
`pendingConsent`), the `contentDigest` of the copy it staged and, for a source
an open install proposal names or one Station previously installed without its
git metadata, `gitMetadata: "excluded"`. Lifecycle-bearing
dependencies additionally carry their own `consent` object, binding their
permissions and bytes before installation.
The hook returns the server's preview body; an invalid preview is a returned
`valid: false` result, not necessarily a rejected promise. Check that result
before accessing review fields or constructing consent.

```tsx
const { mutate } = usePluginPreviewMutation();
mutate('https://github.com/org/my-plugin.git');
```

### Retained plugin recovery

`usePluginRecoveryPreviewQuery(name, config?)` reads the retained selection through
`GET /api/plugins/:name/recovery-preview`. `requestPluginRecoveryPreview(name)`
provides the same read without a hook. The React-free client entry exports
`previewPluginRecovery(apiBase, name, options?)` and
`recoverPlugin(apiBase, name, input, options?)`; use the normal Station credential
and origin options. No local paths or internal runtime imports are required.

The preview carries the exact installation, retained content digest, opaque
`recoveryRevision`, current `grantRevision`, optional `registryTrustRevision`, permission review, skipped components,
and dependency installation/consent rows. A signed retained package reuses its
original journal-bound verification under the same applied policy, without
contacting its registry/source; ready retained children carry their own trust
revision. These are review preconditions, not permission grants. Show the review and obtain an explicit decision before calling
`usePluginRecoveryMutation()`. Its input is `{ name, recoveryRevision, consent }`;
recovery consent requires the fresh grant revision, including each dependency
approval. Never derive approval merely from a cached preview or retry an old
consent automatically.

```ts
import { previewPluginRecovery, recoverPlugin } from '@kontourai/station-sdk/client';

const preview = await previewPluginRecovery(apiBase, name, requestOptions);
// Present preview.permissions and preview.dependencies in your application's
// review UI. Continue only with the operator's explicit selected permissions.
const result = await recoverPlugin(apiBase, name, {
  recoveryRevision: preview.recoveryRevision,
  consent: {
    registryTrustRevision: preview.registryTrustRevision,
    contentDigest: preview.contentDigest,
    grantRevision: preview.grantRevision,
    permissions: operatorDecision.permissions,
    dependencies: preview.dependencies.map(({ id }) => id),
    dependencyApprovals: preview.dependencies.map(({ id, consent }) => ({
      ...consent, id,
      permissions: operatorDecision.dependencies[id],
    })),
  },
}, requestOptions);
// A 202 receipt with configurationActivation.status === 'pending' is retained
// work awaiting activation. It is not completed installation or a retry signal.
```

Recovery continues retained bytes and their data scope; it does not fetch missing
dependencies or adopt unrelated installations. A changed selection/decision yields
HTTP 409; unavailable grant evidence can yield 503. Surface the error and require
a fresh preview and decision. `PluginRecoveryResult` preserves the existing
`PluginInstallResult` plus the acceptance-time `configurationActivation` receipt.
The mutation disables retries and refreshes plugin, recovery, layout, Agent, and
Project queries after an accepted response, including pending activation. A network
failure does not prove that the server had no effect; inspect current state before
asking for another recovery decision.

Follow the [client](../../packages/sdk/src/client/plugins.ts),
[mutation hooks](../../packages/sdk/src/query-domains/plugin-mutations.ts),
[install/recovery routes](../../src-server/routes/plugins/plugin-install-routes.ts),
and [transaction owner](../../src-server/services/plugins/plugin-install-transaction.ts).

### `usePluginUpdateMutation()`

Updates an installed plugin. Invalidates plugins cache on success.

### `usePluginRemoveMutation()`

Removes an installed plugin. Invalidates plugins and layouts caches on success.

### `usePluginSettingsMutation()`

Saves plugin settings and invalidates that plugin's settings cache on success.

### `useRevokePluginPermissionMutation()`

Durably withdraws plugin permissions and returns the effective `granted` set
plus runtime `reconciliation` truth. `completed` means the affected runtime
generation retired; `winding-down` names an owned continuation; `superseded`
means a newer grant/install generation won; and `incomplete` names stages that
need another idempotent revoke attempt. Station's Plugins surface uses that
same mutation for its **Check cleanup** and **Retry cleanup** actions; retrying
preserves the complete pending lifecycle-permission vector.

### `usePluginProviderToggleMutation()`

Toggles plugin provider overrides (enable/disable specific providers).

```tsx
const { mutate } = usePluginProviderToggleMutation();
mutate({ pluginName: 'my-plugin', disabled: ['auth'] });
```

### `usePluginRegistryInstallMutation()`

Requests installation or removal of a registry plugin. Installation of
lifecycle-bearing code requires the reviewed preview consent and any conflict
skip decisions; the mutation does not create approval on the caller's behalf.

```tsx
const { mutate } = usePluginRegistryInstallMutation();
mutate({ id: 'my-plugin', action: 'install', consent: reviewedConsent, skip: reviewedSkips });
```

### `useReloadPluginsMutation()`

Triggers `/api/plugins/reload` and invalidates plugin, layout, agent, and project caches.

### `waitForAgentHealth(slug, options?)`

Polls the Agent health read, defaulting to 15 attempts separated by 2,000ms.
Returns the first `healthy` response or `null` after exhausted attempts,
swallowing individual request errors. There is no enclosing deadline or abort
option, so the spacing alone does not establish a 30-second completion bound.
This is a runtime health observation, not proof of a provider-backed turn.

---

## Components

Host-themed UI components. Styling varies by component: inline styles, CSS
assets and host variables can all participate. Importing a component does not
install the Station theme or prove a layout/accessibility result.

### `Button`

```tsx
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'success' | 'ghost'; // default: 'primary'
  size?: 'sm' | 'md' | 'lg';                               // default: 'md'
  loading?: boolean;
}
```

```tsx
<Button variant="secondary" size="sm" onClick={handleClick}>
  Run
</Button>
```

### `Pill`

Inline label/tag component.

```tsx
interface PillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'error'; // default: 'default'
  size?: 'sm' | 'md';                                                  // default: 'md'
  removable?: boolean;
  onRemove?: () => void;
}
```

```tsx
<Pill variant="success" removable onRemove={() => removeTag(tag)}>
  {tag}
</Pill>
```

### `Spinner`

```tsx
<Spinner size="sm" />   // size: 'sm' | 'md' | 'lg', default: 'md'
```

```tsx
<Spinner color="#fff" />
```

### `LoadingState`

Inline loading indicator with message.

```tsx
<LoadingState message="Fetching data..." size="sm" />
// size: 'sm' | 'md', default: 'md'
```

### `FullScreenLoader`

Full-viewport loading screen with rotating phrases.

```tsx
<FullScreenLoader
  message="Loading..."       // static message; overrides phrases if set
  phrases={['Loading...']}   // rotating phrases (default: built-in list)
  interval={2500}            // ms between phrase changes, default: 2500
  showLogo={true}            // show /favicon.png, default: true
/>
```

Additional props include `tipMessages`, `label`, `action` and optional
`progress` (a measured fraction from 0 to 1). Without `progress`, the bar is
indeterminate. `action` is host-supplied UI, such as a recovery button; the
component does not perform recovery itself.

### `AutoSelectModal`

Keyboard-navigable search/select modal.

```tsx
interface AutoSelectItem<T = any> {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  metadata?: T;
  badge?: string;
  timestamp?: string;
  isActive?: boolean;
}

interface AutoSelectModalProps<T = any> {
  isOpen: boolean;
  title: string;
  placeholder?: string;
  items: AutoSelectItem<T>[];
  loading?: boolean;
  emptyMessage?: string;
  onSelect: (item: AutoSelectItem<T>) => void;
  onClose: () => void;
  renderIcon?: (item: AutoSelectItem<T>) => ReactNode;
  renderMetadata?: (item: AutoSelectItem<T>) => ReactNode;
  showCancel?: boolean;
}
```

```tsx
<AutoSelectModal
  isOpen={open}
  title="Select Agent"
  items={agents.map(a => ({ id: a.slug, title: a.name }))}
  onSelect={(item) => setAgent(item.id)}
  onClose={() => setOpen(false)}
/>
```

Keyboard: `↑`/`↓` to navigate, `Enter` to select, `Escape` to close.

### `ActionButton`

Button/link for a layout action. It reads the SDK navigation context: `external`
opens the supplied URL, `internal` calls `navigate`, and `prompt` or
`inline-prompt` calls the supplied `onLaunch`. Rendering it does not dispatch
an Agent turn without that host callback.

### `AuthStatusBadge`

Reads `useAuth()` and displays that provider's status, with a confirmation UI
for its `renew` callback. It renders nothing while loading or when the provider
is missing/`none`. This is the configured provider's auth status, not a Device
grant, account session or Project-membership verdict.

### `FullScreenError`

Full-viewport error display with optional `description`, diagnostic `detail`
and retry action. An explicit `actions` array replaces the `onRetry` and
`secondaryAction` pair. The host owns those effects and must supply safe display
text; the component does not redact diagnostics or retry on its own.

### `LayoutHeader`

Header for legacy layout tabs and actions. Supply `title` and `description`,
the relevant tab/action callbacks and the SDK navigation/auth contexts. Set
`canLaunchPrompts={false}` when the host cannot launch prompts; it hides prompt
actions while retaining internal/external links. Omitting that flag preserves
the older behavior and can leave prompt controls without a useful callback.
The retained `layoutPrompts` prop is a header input, not the current layout
manifest's field name (`skills`).

---

## Visual skill experiences

`fetchSkillExperienceInventory(apiBase, options?)` and
`fetchSkillExperienceSession(apiBase, threadId, cursor?, options?)` are available
from `@kontourai/station-sdk/client`. Both validate the returned inventory or
session projection before exposing it and preserve HTTP failure details. The
canonical reader is a static import of the client entry, so it adds the shared
validator to that bundle, and it runs only after a successful feature response;
a reader failure remains an error.
`useSkillExperienceInventoryQuery(config?)` and
`useSkillExperienceSessionQuery(threadId, config?, cursor?)` are React Query hooks from
the SDK root. The session hook remains disabled until a canonical thread exists.
The optional cursor reads older invocation snapshots; those rows do not grant
current execution authority.

An inventory entry is a preview. Starting requires `executionContract: '1.0'`
and an exact current source identity. `sendExecutionMessage` accepts the optional
`skillExperience: { identity, inputs, expectedPreviousInvocationEventId?, attachmentInputs? }`
field and refetches the installed inventory before its foreground POST.
`sendExecutionMessageWithInventory(apiBase, input, readInventory, options?)`
performs the same preflight with a caller-supplied inventory reader;
`sendExecutionMessage` passes `fetchSkillExperienceInventory`. The two live in
separate modules, so a bundle that imports only the rest of the execution
client does not also carry the validator.
`inputs` holds scalar text/choice values; attachment role arrays contain indices
into the canonical chat attachments, after supervised staging. Native role choices use
composer client IDs until the sender maps them against the actual outgoing
staged references; role membership never supplies custody or a file path. The server owns
source admission, input validation and immutable invocation snapshots. A missing
execution contract, changed source or automatic background send fails without
posting an ordinary-chat substitute.

The response history contains an immutable definition/input snapshot and current
source availability, or an explicit unavailable-snapshot row. A continuation
uses the same conversation and the exact current invocation event as
`expectedPreviousInvocationEventId`. Questions and approvals remain canonical
session requests. Definitions describe intended outputs; they do not prove
completion. See [Visual skill experiences](skill-experiences.md) for source and
authoring boundaries. These source exports require a published SDK release
before external consumers can import them.


An explicitly declared `presentation.richView` can opt into the existing
isolated plugin pane host. `createSkillExperiencePaneHost` from
`@kontourai/station-sdk/workspace-pane` supplies occurrence-bound `read`,
`answer` and `continue` methods. The shell fixes the conversation and source;
plugin code cannot choose another thread. The read's `viewJson` preserves the
public session projection and adds bounded nonsecret pending questionnaires
with their exact request/event identities. It includes neither transcript
contents, answers nor tool grants. Secret questions and tool approvals stay
with canonical conversation controls.

Rich session reads use the optional `expectedSkillExperience: { identity,
eventId }` request option; rich answers carry that same precondition through
`respondToRequest`. The server checks the current invocation and holds the
fresh `agents.invoke` grant through the operation. Ordinary user controls omit
that option. Rich continuation only prepares a declared stage and its inputs
in the existing unsent chat draft; explicit composer Send remains the execution
owner. The source-bound bundle request and current pane contribution must also
qualify before the host transfers code. The frame supplies the nonsecret
`window.__stationPaneHostOrigin` origin bootstrap; self-rendering pane code
uses it with the SDK helper. This does not establish that arbitrary React
component bundles can render in the isolated frame.

---

## Context Providers

### `SDKProvider`

Injects an explicitly supplied SDK context into a plugin tree. Station supplies
it through its plugin boundary; custom hosts and isolated tests can mount it
themselves. It forwards the value without populating missing optional slots.

```tsx
<SDKProvider value={sdkContextValue}>
  {children}
</SDKProvider>
```

### `LayoutProvider`

Compatibility wrapper over an explicitly supplied SDK context. It does not
publish ambient plugin identity or infer Agent identity from a Layout slug.

```tsx
<LayoutProvider sdk={sdkContextValue} layout={layoutConfig}>
  {children}
</LayoutProvider>
```

### `LayoutNavigationProvider`

Stores per-tab strings in browser `sessionStorage` under
`layout-<layoutSlug>-tab-<tabId>` and updates the page hash for the active tab.
Use a stable, distinct layout identity. Stored state may be restored on mount
when the hash is empty, and on tab switches. This is browser UI state, not
durable Project state; storage failures are not caught here.

```tsx
<LayoutNavigationProvider layoutSlug="my-layout" activeTabId={activeTab}>
  {children}
</LayoutNavigationProvider>
```

#### `useLayoutNavigation()`

Must be called inside `LayoutNavigationProvider`.

```ts
type LayoutNavigationExcerpt = {
  getTabState: (tabId: string) => string;
  setTabState: (tabId: string, state: string) => void;
  clearTabState: (tabId: string) => void;
}
```

`clearTabState` currently removes storage for an inactive tab, but clears only
the URL hash for the active tab. It is not a reliable way to erase that active
tab's saved string; a later restoration can read it again. Tracked in
[#2806](https://github.com/kontourai/station/issues/2806).

---

## Agent Resolver

The current exported helper is `getAgentDisplayName(id, agents?)`. It looks up
an exact canonical Agent ID and falls back to that ID. It does not parse a
namespace, infer a Layout prefix or choose an execution target.

```ts
import { getAgentDisplayName } from '@kontourai/station-sdk';
import { agentId } from '@kontourai/station-contracts/agent-identity';

const id = agentId('my-agent');
getAgentDisplayName(id, [{ slug: id, name: 'My Agent' }]); // 'My Agent'
getAgentDisplayName(id, []);                            // 'my-agent'
```

The previously documented `resolveAgentName`, `parseAgentSlug` and
`isLayoutAgent` functions are not current SDK exports. Plugin-qualified input
accepted by `useSendToChat` has its own explicit parser/contract; a colon in an
arbitrary ID is not evidence of plugin ownership.

---

## Voice

Registries and interfaces for client-side STT/TTS provider objects. Registration
is explicit; Station's built-in provider module calls it during import and
`VoiceProviderContext` subscribes to registry changes. Registering a browser
object is not server-side provider registration, credential configuration or
proof that microphone/playback works.

### `voiceRegistry`

```text
voiceRegistry.registerSTT(provider: STTProvider): () => void
voiceRegistry.registerTTS(provider: TTSProvider): () => void
voiceRegistry.unregisterSTT(id: string): void
voiceRegistry.unregisterTTS(id: string): void
voiceRegistry.getAvailableSTT(): STTProvider[]
voiceRegistry.getAvailableTTS(): TTSProvider[]
voiceRegistry.getSTT(id: string): STTProvider | undefined
voiceRegistry.getTTS(id: string): TTSProvider | undefined
voiceRegistry.subscribe(fn: () => void): () => void  // useSyncExternalStore-compatible
```

Retain the returned disposer: it is idempotent and removes the entry only while
that exact provider object still owns the ID. Direct `unregisterSTT/TTS(id)`
removes the current entry by ID. Duplicate IDs replace the old provider; this
older registry does not restore a previous provider when the replacement is
removed. `getAvailableSTT/TTS` returns registered entries without filtering
`isSupported`.

### `STTProvider` interface

```ts
interface STTProvider {
  readonly id: string;
  readonly name: string;
  readonly isSupported: boolean;
  readonly state: 'idle' | 'listening' | 'error';
  readonly transcript: string;
  startListening(opts?: STTOptions): void;
  stopListening(): void;
  subscribe(fn: () => void): () => void;
}

interface STTOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
}
```

### `TTSProvider` interface

```ts
interface TTSProvider {
  readonly id: string;
  readonly name: string;
  readonly isSupported: boolean;
  readonly speaking: boolean;
  speak(text: string, opts?: TTSOptions): void;
  cancel(): void;
  subscribe(fn: () => void): () => void;
}

interface TTSOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}
```

### `ConversationalVoiceProvider` interface

Bidirectional provider (e.g. Nova Sonic). Extends both `STTProvider` and `TTSProvider`.

```ts
interface ConversationalVoiceProvider extends STTProvider, TTSProvider {
  readonly sessionState: 'idle' | 'active' | 'error';
  startSession(opts?: ConversationalOptions): void;
  endSession(): void;
}

interface ConversationalOptions {
  lang?: string;
  region?: string;
}
```

### `ProviderCapability`

Shape used in the voice lists returned by `GET /api/system/capabilities`.
`configured` is the server's capability observation, not a successful live
provider probe. Station can register configured server entries as display
stubs whose methods warn that a plugin bundle is still needed; presence in the
registry alone does not establish a working provider. The current capability
hook does not retire its stubs when a later Station observation omits them, so
a retained selection can still appear supported after changing connections.
Lifecycle ownership for these entries is tracked in
[#2807](https://github.com/kontourai/station/issues/2807).

```ts
interface ProviderCapability {
  id: string;
  name: string;
  clientOnly: boolean;   // true = runs in browser (WebSpeech), no server config needed
  visibleOn: ('all' | 'mobile' | 'desktop')[];
  configured: boolean;   // false if server lacks credentials
}
```

### Voice-session adapters

`VoiceSessionAdapter` is a separate, provider-neutral extension seam for one
live voice interaction. It does not replace the STT/TTS registry above; those
exports remain available unchanged.

Import voice-session runtime contracts from the dedicated subpath so
applications that do not use session adapters carry no new runtime bundle
weight:

```ts
import {
  VoiceSessionManager,
  voiceSessionAdapterRegistry,
} from '@kontourai/station-sdk/voice';
```

Each adapter has a stable `descriptor` and declares optional capabilities
explicitly. The descriptor's `id` is the registry key; `name` and optional
`description` are display metadata. Capabilities are opt-in booleans:
`interrupt`, `reconnect`, `updateContext`, `textTurn`, and `audioInput`.

```ts
interface VoiceSessionAdapter {
  readonly descriptor: {
    id: string;
    name: string;
    description?: string;
  };
  readonly capabilities: {
    interrupt?: boolean;
    reconnect?: boolean;
    updateContext?: boolean;
    textTurn?: boolean;
    audioInput?: boolean;
  };
  getSnapshot(): VoiceSessionSnapshot;
  subscribe(listener: () => void): () => void;
  start(input?: VoiceSessionStartInput): Promise<VoiceSessionOperationResult>;
  stop(): Promise<VoiceSessionOperationResult>;
  interrupt?(): Promise<VoiceSessionOperationResult>;
  reconnect?(): Promise<VoiceSessionOperationResult>;
  updateContext?(input: VoiceSessionContextUpdate): Promise<VoiceSessionOperationResult>;
  sendText?(input: VoiceSessionTextTurn): Promise<VoiceSessionOperationResult>;
  sendAudio?(input: VoiceSessionAudioInput): Promise<VoiceSessionOperationResult>;
}
```

`VoiceSessionSnapshot` carries an immutable lifecycle projection. Its
`revision` is monotonic for an adapter or manager projection. It deliberately
keeps `controlSessionId` (the controlling connection) separate from
`conversationSessionId` (the conversation identity); callers must not treat
them as interchangeable. Lifecycle states are available through
`VOICE_SESSION_LIFECYCLE_STATES` and include `disconnected`, `connecting`,
`connected-idle`, `listening`, `transcribing`, `thinking`, `speaking`,
`stopping`, and `error`.

### `voiceSessionAdapterRegistry`

Use `VoiceSessionAdapterRegistry` when isolation is needed, or the exported
`voiceSessionAdapterRegistry` singleton for shared registration.

```ts
const registration = voiceSessionAdapterRegistry.register(adapter);
const active = voiceSessionAdapterRegistry.get(adapter.descriptor.id);

// Safe to call more than once. This removes only this registration.
registration.dispose();
```

Registrations are identity-scoped: disposing one handle never removes another
registration with the same descriptor ID. For duplicate IDs, the newest live
registration is returned by `get()`. Disposing that newest registration reveals
the preceding live one; disposing an older, shadowed registration does not
remove the current winner. `getAll()` returns the visible adapters and
`subscribe()` reports visible-surface changes.

### `VoiceSessionManager`

Construct a manager with a registry, select an adapter ID, then drive its
lifecycle with `start`, `stop`, `toggle`, `interrupt`, `reconnect`,
`updateContext`, `sendText`, and `sendAudio`. `sendAudio` accepts
`{ audio: Uint8Array }`; the manager serializes optional operations with its
lifecycle work. The adapter contract forbids projecting those bytes into
snapshots/results. Custom adapters must honor that contract: the manager is
not a sanitizer for arbitrary extra fields or telemetry emitted by adapters.

```ts
const manager = new VoiceSessionManager(voiceSessionAdapterRegistry);
manager.select('my-voice-session');

const result = await manager.start({
  controlSessionId: 'control-42',
  conversationSessionId: 'conversation-42',
});

if (result.ok) {
  console.log(result.snapshot.state, result.snapshot.revision);
} else {
  console.error(result.error.code, result.error.operation);
}
```

Lifecycle intent is serialized: duplicate starts coalesce, reconnect is blocked
while stop owns transport teardown, and late adapter completions cannot overwrite
newer intent. Once started, the manager retains
the exact active adapter until it stops it, even if selection changes or that
adapter's registration is disposed. A later `start()` resolves the current
selection independently.

Every lifecycle call returns `VoiceSessionOperationResult`. Successful results
contain a snapshot. Failure results contain `VoiceSessionError` with one of
`unavailable`, `unsupported`, `unconfigured`, `rate-limited`, or
`operation-failed`. `VoiceSessionError` also declares an optional `cause`;
the manager replaces thrown failures with a generic error, but it does not
sanitize an adapter's returned error object. Adapters must keep sensitive
provider details out of public errors. With no selected live adapter, an
operation returns `unavailable`; requesting an optional operation that the active adapter
did not declare and implement returns `unsupported`.

`dispose()` is terminal and asynchronous. It coalesces concurrent disposal,
cancels queued starts, and waits for an in-flight or active provider to stop.
Await its typed result before releasing host resources. A failed provider stop
leaves the manager snapshot in `error` and retains cleanup ownership; calling
`dispose()` again retries cleanup. The manager reports `disconnected` only
after cleanup succeeds.

After disposal begins, `stop()` joins the same cleanup operation (or retries a
retained failed cleanup) instead of reporting ordinary no-active-session
success.

```ts
const disposed = await manager.dispose();
if (!disposed.ok) {
  // Surface diagnostics, then retry according to host policy.
  await manager.dispose();
}
```

### Conformance testing

`createSyntheticVoiceSessionAdapter()` creates a framework-neutral adapter with
immutable snapshots, call logging, and optional deferred operations.
`runVoiceSessionAdapterConformance()` drives start, every enabled optional
operation, and stop; the fixture's `exercise()` callback emits the adapter's
intermediate states. Assert its report in the test that defines an adapter's
supported capabilities.

```ts
import { VoiceSessionError } from '@kontourai/station-sdk/voice';
import {
  createSyntheticVoiceSessionAdapter,
  runVoiceSessionAdapterConformance,
} from '@kontourai/station-sdk/testing';

const adapter = createSyntheticVoiceSessionAdapter({
  capabilities: {
    interrupt: true,
    updateContext: true,
    textTurn: true,
    audioInput: true,
  },
});

const report = await runVoiceSessionAdapterConformance({
  adapter,
  exercise: () => {
    adapter.emit({ state: 'listening' });
    adapter.emit({ state: 'transcribing' });
    adapter.emit({ state: 'thinking' });
    adapter.emit({ state: 'speaking' });
    adapter.emit({
      state: 'error',
      error: new VoiceSessionError('operation-failed', 'test failure'),
    });
  },
});

if (!report.ok) throw new Error(report.violations[0]?.message);
```

The report includes the snapshots observed and typed violations for
capability-method mismatches, identity preservation, required lifecycle
states, snapshot immutability, and monotonic revisions. These helpers have no
UI or server requirement when used with synthetic adapters. They invoke the
adapter's enabled operations; passing a real adapter can therefore have real
effects. Passing conformance establishes only the exercised contract checks,
not microphone permission, audio quality, provider health or safe data handling.

---

## Context Registry

For providers that contribute ambient message context, such as timezone or
location. Station's `MessageContextContext` subscribes to registry membership
and toggle changes; the chat send/drain callers explicitly request composed
context. Importing the SDK does not attach context to every API call.

### `contextRegistry`

```text
contextRegistry.register(provider: MessageContextProvider): void
contextRegistry.unregister(id: string): void
contextRegistry.toggle(id: string): void
contextRegistry.getAll(): MessageContextProvider[]
contextRegistry.get(id: string): MessageContextProvider | undefined
contextRegistry.getComposedContext(): string | null  // all enabled providers joined by \n
contextRegistry.subscribe(fn: () => void): () => void
```

Registration replaces the entry for an existing ID; unregister removes the
current entry by ID. Composition calls each enabled provider's `getContext`
and joins nonempty strings. It does not catch a provider exception or subscribe
to each provider's own change stream. Providers should return bounded,
appropriate context and avoid secrets that should not enter an Agent prompt.

### `MessageContextProvider` interface

```ts
interface MessageContextProvider {
  readonly id: string;
  readonly name: string;
  enabled: boolean;
  getContext(): string | null;
  subscribe(fn: () => void): () => void;
}
```

### `ContextCapability`

```ts
interface ContextCapability {
  id: string;
  name: string;
  visibleOn: Array<'all' | 'mobile' | 'desktop'>;
}
```

---

## Layout Providers

Browser data-provider factories scoped to a layout, for example a CRM data
source. These SDK functions delegate to host-injected functions. The default
`SDKAdapter` installs the core registry functions in an effect; a custom host
must arrange that binding before registration/access. They do not register a
server provider, grant permissions, or persist configuration.

### `registerProvider(id, metadata, factory)`

Registers a factory under its layout/type/ID. `layout: '*'` is a global
fallback. Registration alone does not select or instantiate it.

```ts
registerProvider('my-crm', { layout: 'sales', type: 'crm' }, () => new MyCRMProvider());
configureProvider('sales', 'crm', 'my-crm');
const crm = getProvider<MyCRMProvider>('sales', 'crm');
```

### `getProvider<T>(layout, type): T`

Resolves the configured ID, checking the named layout before `'*'`, invokes
its factory once and caches the instance. Throws when the host binding,
configuration or registered factory is missing.

### `hasProvider(layout, type): boolean`

Returns `true` when a configured ID has a registered factory. It does not call
the factory or check external service health; it returns `false` before host
function injection.

### `getActiveProviderId(layout, type): string | null`

Returns the instantiated cached provider's ID. It remains `null` after mere
configuration until `getProvider` successfully creates the instance.

### `configureProvider(layout, type, providerId)`

Sets the in-memory configured ID and drops the cached instance for this pair.
It neither invokes disposal on that instance nor validates the new ID eagerly.
The registry has no persistence or ownership-scoped unregister API; host/plugin
lifecycle code must account for those limits.

### `ProviderMetadata`

```ts
interface ProviderMetadata {
  layout: string;
  type: string;
}
```

---

## Notifications API

### `NotificationsAPI`

Imperative REST wrapper with `schedule`, `list`, `dismiss`, `action`, `snooze`,
`clearAll` and `clearActivity`. There is no `create` method. It uses the supplied
base URL and optional constructor bearer token with `fetch`; it does not
capture Station's selected-connection/native transport authority for the caller.
Use it only with a host-owned transport/authentication arrangement appropriate
to that endpoint. Request admission and delivery remain server responsibilities.

```ts
import { NotificationsAPI } from '@kontourai/station-sdk';

const api = new NotificationsAPI(apiBase);
await api.schedule({ category: 'build', title: 'Build complete', priority: 'normal' });
await api.dismiss(notificationId);
const notifications = await api.list({ status: ['pending'] });
```

Known scheduling limit: a `scheduledAt` more than about 24.9 days ahead exceeds
Node's native timer range. The current service can then retain the notification
as pending without a live wakeup until it is rescheduled or the service starts
again. See [#2810](https://github.com/kontourai/station/issues/2810); successful
creation alone does not establish future delivery.

---

## Query Factories

### Protected Basis and exact tool results

The `answer-basis`, `task-basis`, `task-tool-results`, and
`flow-gate-evaluations` subpaths expose
protected queries without importing Station app internals. React-free clients
are also exported from `@kontourai/station-sdk/client`.

- `useSessionToolResultQuery(sessionId, eventId, { requestScope })` inspects one
  exact terminal result without writing. Its content is Thread's bounded inert
  projection, not raw tool arguments or structured payloads.
- `useTaskToolResultReferencesQuery(taskId, { requestScope })` reauthorizes kept
  identities. Available rows include their published Surface `ref`.
- `useTaskFlowGateEvaluationsQuery(taskId, { requestScope })` reads only kept
  immutable Flow gate receipts. Its owner projection preserves historical
  verdict and current standing, without promoting either into a Task answer.
- `useAttachTaskFlowGateEvaluationMutation({ requestScope })` retains one exact
  Flow tuple and invalidates its retained-receipt and Basis views.
- `useAttachTaskToolResultReferenceMutation({ requestScope })` retains only the
  exact Session/event tuple in the explicitly selected Task. It invalidates
  that authority's kept-result and Basis queries; it never implies support.
- `useAnswerBasisQuery` and `useTaskBasisQuery` accept the same captured scope.
  Whole Task uses collection v4; portable MCP delivery uses page v3 with
  separate streams of up to eight answers and 16 rows each for unassociated
  items, kept results and retained Process evaluations, within a 128 KiB page.
  Retained Flow gate evaluations are not answer associations and do
  not establish Task standing. Unknown versions or a missing Process stream
  are unavailable.
- `refreshAnswerAssessmentQueries(queryClient, payload, requestScope)` is the
  `answer-basis` subpath helper for an authorized
  `answer.assessment.updated` notification. It accepts only the closed
  `{ sessionId, turnId, revision, active }` payload, tombstones matching
  scoped Basis data before refetching active observers, and never refreshes
  another authority's cache.
- `useSessionInventoryQuery` returns the same captured current-answer Basis
  projection when that scope is selected. Consumers render its standing from
  that projection and must not issue a second `useAnswerBasisQuery`. An
  `answer.assessment.updated` event tombstones only the matching scoped
  current-answer inventory cache before active observers refetch.
- `useTasksQuery` accepts `TaskDestinationQueryConfig` for a scoped Keep
  destination picker. `TaskDestinationRequestError` identifies a rejected
  destination read; both are exported from the SDK root and query barrel.

### Answer-assessment producer protocol

An assessment producer uses the existing authenticated orchestration routes;
the SDK intentionally provides no convenience client for this write protocol.
All requests address one exact `StationAnswerBinding` (`sessionId`, `turnId`,
and its answer identity), and route responses are private and non-cacheable.
The current producer module rejects hosted authority and requires a readable
answer bound to a Project in personal mode. Authentication alone does not make
every answer an eligible assessment target.

- `GET /api/orchestration/sessions/:sessionId/turns/:turnId/assessment/target`
  returns `{ expectedAnswer, profile, revision, active }`. The producer must
  copy that exact binding and profile target into its claim; do not infer either
  from displayed content. `revision: 0, active: false` means no record exists;
  a positive revision also reports inactive tombstones.
- `PUT /api/orchestration/sessions/:sessionId/turns/:turnId/assessment`
  publishes `{ expectedAnswer, publicationId, bundle, claimId,
  expectedRevision }` and returns the identity-only receipt
  `{ sessionId, turnId, revision, active }`.
- `DELETE /api/orchestration/sessions/:sessionId/turns/:turnId/assessment`
  sends `{ expectedRevision }` and returns the same receipt.

`expectedRevision` is compare-and-swap: a `409` can mean a changed revision or
a conflicting publication/binding, so read the target again before deciding
whether to retry. An exact repeat of the current active publication returns
its existing receipt; reusing its publication ID with different content conflicts.
A `404` does not disclose whether the binding, producer access, or assessment is
absent; a `503` means assessment storage is unavailable. The exact wire types
are `StationAnswerAssessmentReadTarget`, `StationAnswerAssessmentPublishInput`,
and `StationAnswerAssessmentReceipt` from
`@kontourai/station-contracts/answer-assessment`. The HTTP publish schema also
accepts an optional `reviewedSource` association, whose exact claim, revision,
Project and principal must match the publication. See the
[route schema](../../src-server/routes/orchestration/orchestration.ts) and
[assessment owner](../../src-server/services/evidence/answer-assessment-module.ts).

`ApiRequestScope` contains only `apiBase` and a non-secret `authorityKey`.
The host captures it before invocation from Connect's public request-authority
evidence, including its activation epoch. Native Station additionally qualifies
it with the exact native authorization receipt. Never put credentials in keys.
The host credential resolver must expose matching `requestAuthority` metadata
and its live `isCurrent` check. Scoped operations reject mismatches before
dispatch and after asynchronous response/body reads, including cloned bodies;
they never adopt a replacement connection. Keep captures its authority before
asynchronous mutation scheduling. A missing scope disables
`useSessionToolResultQuery` and the Flow evaluation hooks, and rejects the Keep
mutations. Legacy answer/Task Basis and kept-tool-result list hooks still allow
unscoped use; Station's connected Basis host supplies scope explicitly.

```ts
import { getSessionToolResult } from '@kontourai/station-sdk/client';

// requestScope is captured by the host, not reconstructed from a URL or title.
const result = await getSessionToolResult(
  requestScope.apiBase, sessionId, eventId, { requestScope, signal },
);
```

Ordinary unscoped SDK calls retain their existing behavior. These protections
are an explicit host contract, not a global replacement for authentication.

Follow the [connected host](../../src-ui/src/workspace-panes/ConnectedStationBasisPane.tsx),
[Basis pane](../../packages/basis-pane/src/StationBasisPane.tsx),
[tool-result hooks](../../packages/sdk/src/task-tool-results.ts),
[Flow hooks](../../packages/sdk/src/flow-gate-evaluations.ts),
[authority guard](../../packages/sdk/src/client/http.ts), and
[MCP page contract](../../packages/contracts/src/task-basis-mcp.ts).

### `agentQueries`

Query factory for imperative fetching (e.g. in slash commands). Returns React Query config objects.

Successful Agent detail reads infer `EnrichedAgentProjection`; tool reads retain
an `unknown[]` payload for callers to narrow. Conversation list factories accept
the existing array or `{ items }` response forms, and provider factories infer
`OrchestrationProviderSummary[]`. These envelope types work in Node and browser
consumers without relying on ambient `Response.json()` returning `any`. They do
not add payload validation; conversation statistics keep their existing runtime
parser, and HTTP status/error handling is unchanged.

```ts
agentQueries.agent(agentSlug)                        // GET /api/agents/:slug
agentQueries.tools(agentSlug)                        // GET /agents/:slug/tools
agentQueries.stats(agentSlug, conversationId)        // GET /agents/:slug/conversations/:id/stats
```

### `knowledgeQueries`

Query factory for file-store Knowledge operations. The namespace selects a
route segment; it is not merely a client-side filter. The underlying API helper
uses `/knowledge/ns/:namespace` when supplied and the unqualified `/knowledge`
base otherwise. Search results remain dependent on current indexing/adapter
availability; these factories do not perform indexing.

```text
knowledgeQueries.list(projectSlug, namespace?)       // GET /api/projects/:slug/knowledge[/ns/:namespace]
knowledgeQueries.search(projectSlug, query, ns?, topK?) // POST to the selected base + /search
knowledgeQueries.namespaces(projectSlug)             // GET /api/projects/:slug/knowledge/namespaces
```

---

## Conversation history windows

`fetchOrchestrationConversationEventWindow(conversationId, apiBase,
{ direction: 'newest', turnLimit: 10 })` prioritizes the latest events of the
selected turns, so a completed answer is available before a long tool-progress
history. The returned events remain in chronological order. Pass the opaque
`nextCursor` back to load preceding events, then preceding turns; merge by
event id and sequence. A turn-start anchor may repeat across pages.

The opt-in reader retains the existing 150-event and response-byte bounds.
Terminal message payloads can use up to 48,000 bytes within the bounded window;
larger payloads still carry an explicit `elided` marker and must not be presented
as complete. Tool-result previews retain their smaller allowance. Cursor mode
is preserved across requests; existing forward cursors keep their old behavior.
Older servers that do not implement `direction` retain their legacy ordering.
Live delivery remains owned by the orchestration SSE stream.

The session-scoped `fetchOrchestrationSessionEventWindow` accepts the same
option for conversations without a multi-session lineage.

## Workspace checkpoint restore

`previewCheckpointRestore(apiBase, threadId, turnId, requestScope)` returns a
short-lived, owner-bound preview for the turn's settle checkpoint. It includes
the preview id, repository root, target and currently observed tree hashes,
up to 200 changed paths with a truncation flag, and a five-minute expiry.
`confirmCheckpointRestore` submits that
exact preview with `confirmed: true` and the captured current-tree hash.

```ts
import {
  confirmCheckpointRestore,
  previewCheckpointRestore,
} from '@kontourai/station-sdk/client/checkpoint-restore';

const preview = await previewCheckpointRestore(
  requestScope.apiBase,
  sessionId,
  turnId,
  requestScope,
);
await confirmCheckpointRestore(
  requestScope.apiBase,
  sessionId,
  turnId,
  preview,
  requestScope,
);
```

The server consumes a preview once and refuses stale authority, expiry,
session/turn mismatch, workspace changes after preview, or a workspace with an
active or starting local turn. Restore changes repository files only; it does
not rewind conversation history or external tool effects. Treat an
indeterminate response as possible effect and inspect the workspace before
retrying. Previews are held in server memory, so a restart requires a new one.
See the [client](../../packages/sdk/src/client/checkpoint-restore.ts),
[route](../../src-server/routes/orchestration/orchestration.ts),
[restore service](../../src-server/services/checkpoints/checkpoint-restore.ts),
and [confirmation UI](../../src-ui/src/components/chat/CheckpointRestoreButton.tsx).

## Feedback analysis

Use `useFeedbackRatingsQuery`, `useFeedbackGuidelinesQuery`, and
`useFeedbackStatusQuery` to read the selected Station's feedback. Saving or
removing a rating through the SDK invalidates all three views. Use
`useAnalyzeFeedbackMutation` to request analysis and
`useClearFeedbackAnalysisMutation` to clear derived results while keeping ratings.

Analysis requests share one active job. Re-rating, removing feedback, clearing
analysis, or stopping the service prevents older model results from being
published. Existing model calls settle before queued work starts. Unchanged
summary prompts reuse their cached result; changed inputs are not identified by
rating count alone. Invalid model output remains an error rather than being
saved as analyzed feedback.

`POST /api/feedback/analyze` accepts an omitted body or an optional JSON object
with `maxReinforce` and `maxAvoid`, each an integer from 1 to 50. It returns 400
for invalid options or JSON, 413 for a body over 4 KiB, and 503 when analysis is
not configured. The SDK's analysis mutation uses the omitted-body form.

`POST /api/feedback/test` runs an isolated sample through the analyzer and
guideline formatter. Its response includes `isolated: true`; it does not edit
saved ratings or the profile used in conversations. It does not establish the
integrity of the saved feedback file.

See the [SDK mutations](../../packages/sdk/src/query-domains/analytics.ts),
[HTTP routes](../../src-server/routes/operations/feedback.ts),
[job owner](../../src-server/services/feedback/feedback-service.ts), and
[output parser/cache key](../../src-server/services/feedback/feedback-analysis.ts).

## Monitoring event windows

`fetchMonitoringEventWindow(start, end, signal, { limit: 1000 })` returns
`{ events, truncated }` from the historical monitoring route. Bounded viewers
must disclose truncation and that local filters apply only to loaded rows.
Narrow the time interval to inspect older activity. For older peers that omit
the flag, a full limited window is conservatively marked truncated.

`fetchMonitoringEvents(start, end, signal, filters)` retains its array return
shape and no default limit for existing export callers. Both functions reject
failed or malformed reads instead of reporting an empty history.

API-base initialization wakes pending callers when configuration is published,
with a 500 ms failure bound; later reads observe the latest configured base.
See the [request helpers](../../packages/sdk/src/query-domains/systemRuntimeRequests.ts)
and [API-base owner](../../packages/sdk/src/api-core.ts).

## Telemetry

Developer runtime queries are available from
`@kontourai/station-sdk/developer-runtime`. `useServerLogsQuery(apiBase, params,
config)` scopes its cache to the supplied host and supports an opt-in numeric
`config.refetchInterval`; it does not poll by default. Parameters include level,
text, time bounds and limit. Its result exposes bounded-scan coverage.

`@kontourai/station-sdk/resource-posture` queries retain the CPU response and
accept optional `resources` on `ResourcePostureVM`. The resource snapshot uses
the `HostResourceSnapshot` contract from
`@kontourai/station-contracts/system-status`. Consumers of older servers must
keep omitted memory/process values unknown. CPU and resource sample timestamps
are independent.

### `telemetry`

Best-effort client telemetry for plugins. `track(event, attributes?)` buffers
up to 1,000 events at a time, drops new events while full, and schedules a flush
after ten seconds. `flush()` also allows an explicit flush. Only one request is
in flight at a time, with a five-second abort deadline.

```ts
import { telemetry } from '@kontourai/station-sdk';

telemetry.track('panel.opened', { panel: 'overview' });
```

The buffer is removed before dispatch. Network failures are swallowed, HTTP
status is not checked, and events are not retried; a resolved `flush()` is not
proof of server receipt. The sender uses direct browser `fetch`, outside the
SDK's authenticated transport. The legacy imperative plugin label is currently
empty, so this helper does not establish package attribution.

With the host's raw-egress policy installed, a changed connection/account
authority drops its captured events instead of retargeting them. Browser broker
routes drop optional telemetry. Without that policy, the helper compares only
the configured API base. Do not put secrets in events or use this buffer as an
accounting record. See [telemetry](../../packages/sdk/src/telemetry.ts) and the
[identity getter](../../packages/sdk/src/api-core.ts).

---

## Layout Context

<a id="createlayoutcontext"></a>

### `createLayoutContext(config)`

Creates a plugin-owned `{ Provider, useLayoutContext }` pair. Call the factory
once for a layout, outside component rendering. Supply `layoutSlug`, optional
`projectSlug`, and `initialState`; `persist` defaults to `true`. State updates
shallow-merge partial values. The provider initially merges any parsed
`sessionStorage` value into the initial state, and later writes updates under
`layout:[projectSlug:]layoutSlug:context`.

The stored JSON is not schema-validated or partitioned by Station/account
authority. Use it for non-sensitive presentation state; a plugin that needs
stronger identity or validation must supply that design itself. Read/parse
failures fall back to initial state, write failures log a warning, and
`resetState()` removes the stored key but does not catch storage-removal errors.
This factory is independent of the SDK's `LayoutProvider`. See the
[implementation](../../packages/sdk/src/layout/context.tsx) and
[Enterprise example](../../examples/enterprise-layout/src/EnterpriseContext.tsx).

---

## Refused requests

`StationHttpError` (exported from `@kontourai/station-sdk` and
`@kontourai/station-sdk/client`) carries HTTP/envelope refusal details for the
fetcher families listed below. Branch on its fields, never on the message text:

```ts
class StationHttpError extends Error {
  readonly status: number;        // the observed HTTP status
  readonly code?: string;         // the envelope's machine code
  readonly details?: unknown;     // the envelope's `details`, as sent
  readonly retryAfterMs?: number; // `Retry-After`, delta-seconds only
}
```

The integration, review and workspace pane host-action catalog/preparation
fetchers (built on `readEnvelopeOrThrow`), plus the scheduler, skills, knowledge,
secret-binding, conversation, orchestration, plugin, Agent, execution and Task
output fetchers preserve supplied refusal fields. Project fetchers use
`unwrapProjectResponse` for the same fields. The conversation, orchestration,
Project and Agent fetchers can report a `StationHttpError` with status `200`
when the body carries `{ success: false }`. `respondToRequest`'s error still carries the failure
`receipt`. `readEnvelopeOrThrow(response)`
throws this error for a non-2xx response or a missing/false `success` value.
It checks truthiness, not a literal-boolean schema, and does not validate the
returned `data`; individual fetchers own any stronger success-payload checks.
A body that is not JSON keeps its status on a non-2xx; on a
2xx it is a protocol failure and throws a plain `Error`.

Every fetcher under `@kontourai/station-sdk/client` that throws a refusal now
builds it through the same helper (#2708); the plugin command-effect client
returns business refusals as values instead. The account, application-session,
authority-observation, checkpoint-restore, conversation pull-request link,
fleet-routing receipt, learning-source, personal Board and Project layout
delete, pull-request review, quote-source, runs and setup-import fetchers
throw a `StationHttpError` where some threw a plain `Error` before. Their
family subclasses stay and gain the refusal's fields:

| Class | Base | Gains on a refusal |
|---|---|---|
| `BoardResponseError`, `BoardProvenanceRefusedError` | `StationHttpError` | `details`, `retryAfterMs`; the provenance refusal keeps its observed status |
| `DelegationApiError` | `Error` | `status`, `retryAfterMs` (it already carried `code`, `retryable`, `details`) |
| `AnswerSupportRequestError` | `Error` | `code`, `details`, `retryAfterMs` |
| `ActionOperationProtocolError`, `LiveActivityProtocolError` | `Error` | `status`, `code`, `details`, `retryAfterMs`; absent on a malformed response |
| `AnswerBasisRequestError`, `AnswerNarrativeBindingRequestError`, `FlowGateEvaluationRequestError` | `Error` | `code`, `retryAfterMs`; the message stays fixed |

Each keeps its earlier constructor; the new form takes the helper's
`StationHttpError`. A delegation response whose body is not JSON throws a
`StationHttpError`, not a `DelegationApiError`: a page is not Station's
refusal. `getAuthorityObservation` keeps its own two sentences and reports the
refusal's `status` and `code`; branch on `status === 401`, not on the
sentence. Fetchers outside `client/` (the React query domains) are not yet on
the helper.

Some family subclasses are `StationHttpError`s too. The scheduler's
`SchedulerResponseError` and its run errors (`SchedulerRunIndeterminateError`,
`SchedulerRunFailedError`, `SchedulerRunRefusedError`) are built from the
error the envelope helper made of the response, so they keep its status,
`details` and `Retry-After`; a run error's `code` stays its own fixed value.
`PluginCollectionHttpError` is built the same way: it keeps the envelope's
`code` on the error and on its `envelope`, and keeps the refusal's `details`
and `Retry-After`.
Its constructor accepts `(failure: StationHttpError, options?: { grantsUnavailable?: boolean })`;
the earlier `(status, envelope, options)` constructor is no longer supported.
Host-action execution deliberately returns `indeterminate` after any failed or
unreadable response; it does not expose the helper's exception to the caller.

`ChatHttpError`, thrown by execution fetchers, now extends `StationHttpError`;
`serverMessage` retains the helper's message. The execution, attachment
staging, orchestration-command, steer-command and chat-stream producers set
`stationEnvelope`
to say whether Station itself answered. The body must have Station's shape (a
boolean `success` field, or an object `error` with a string `code`), and the
response must carry the `x-station-envelope` header a current Station puts on
every JSON body it writes. An HTML proxy response, or gateway JSON in
Station's shape without the header, keeps its HTTP status but sets this flag
to `false`, so status alone must not be treated as a definitive Station
refusal. A Station older than the header never sends it: until an origin has
sent the header once in this process (on any response the SDK's request
functions return), the shape alone decides, as before. That fallback is not
independent proof of the responder's identity. The desktop native transport
does not yet pass the header to the renderer, so requests it carries stay on
the fallback.
`ForegroundMessageIndeterminateError` keeps its `detail` and fixed `code`.
Both classes retain their positional constructors.

`ProjectTaskRoomProtocolError` remains a plain `Error` subclass. Its
HTTP/envelope failure form carries `status`, `code`, `details` and
`retryAfterMs`; its payload-validation form carries only the protocol message.

Some fetchers deliberately withhold the route's words and details.
On a non-2xx response, `getInputReplyContext` throws a `StationHttpError`
with a fixed generic message. The Task and Session reference reads use
`TaskToolResultRequestError`, `TaskUserInputReferenceRequestError`,
`TaskBasisRequestError`, `SessionOutputsRequestError` and
`SessionInventoryRequestError`, which remain plain `Error` subclasses.
The answer Basis, answer narrative, gate-evaluation and quote-source reads,
and the action-operation list and watch, are opaque in the same way.
These opaque errors retain the observed `status`, supplied `code` and
`retryAfterMs`, without `details`. A status of `0` is a local failure marker,
not an HTTP response status; callers must not interpret it as a server refusal.
Passing an abort signal still controls the shared transport, but these
reference fetchers can normalize a transport rejection into their generic
status-0 error rather than preserve an `AbortError`.

- `status` is the status the response actually carried. A route that answers
  `200` with `{ success: false }` produces a `StationHttpError` whose status
  is `200`, so a status check such as `status === 404` stays exact.
- `code` is the top-level `code`, else the object `error`'s own `code`
  (the runtime's `{"error":{"code":"authentication_required"}}`). A blank or
  non-string code is absent.
- `details` is present when the body carried a non-null value. For a validation refusal it
  is `{ formErrors, fieldErrors }`.
- The message is a summary — a string `error`, the object `error`'s
  `message`, then its `code`, the top-level `message`, then the fetcher's
  fallback — followed by the validation sentences, each named by its field:
  `Validation failed: command Required, name Required`. The Station CLI prints
  the same sentence. That form is for CLI and agent readers; field keys are
  not copy.
- To show a refusal to a person, read `details` with
  `envelopeReasons(details)` from `@kontourai/station-sdk/client`: the
  server's reason sentences, form-level first, each once, without keys.
  `envelopeDetailsMessage(details)` returns the field-qualified part alone
  (`command Required, name Required`), or `undefined`; the CLI builds its
  message from it.
- `apiErrorMessage(body, fallback)` and `envelopeErrorMessage(body,
  fallback)` return the shown form for a body a caller has already parsed:
  the reasons when there are any, else the summary. Their callers throw a
  plain `Error` that keeps only this text.

The [envelope helper](../../packages/sdk/src/client/api-error-message.ts) and
[transport](../../packages/sdk/src/client/http.ts) own these rules. A typed
failure does not imply that every successful payload was validated or that a
mutation is safe to retry. Read the operation's receipt and retry contract.
On the server, Station-control failures marked as MCP `isError` are read by the
[raw invoke route](../../src-server/routes/agents/invoke-agent.ts); the shared
MCP `callTool` helper still returns the protocol result for its caller to interpret.

MCP App rendering is a separate [host boundary](../design/mcp-ui-host.md), with
integration pinning, resource policy and frame isolation. Resource URL-scheme
filtering is not complete CSP source-expression validation or a guarantee of
effective browser network containment. An ordinary SDK tool call does not
establish that rendering qualification.

## Utilities

### `ListenerManager`

Base class for implementing the `useSyncExternalStore` subscribe pattern. Extend this to build custom providers.

```ts
class ListenerManager {
  readonly subscribe: (fn: () => void) => () => void;
  protected _notify(): void;
  protected _clearListeners(): void;
}
```

```ts
class MyProvider extends ListenerManager {
  private _value = 0;

  increment() {
    this._value++;
    this._notify(); // triggers React re-renders
  }

  get value() { return this._value; }
}
```

### `noopSubscribe`

A no-op subscribe function for `useSyncExternalStore` when no provider is active. Shared reference — avoids creating new functions per render.

```ts
const noopSubscribe: (fn: () => void) => () => void
```

---

## Types

Core types re-exported from `@kontourai/station-contracts/*` plus SDK-specific types.

### Core contract types

Representative SDK re-exports include `AgentSpec`, `AgentMetadata`,
`AgentUIConfig`, `AgentGuardrails`, `AgentTools`, `AgentQuickPrompt`,
`LayoutDefinition`, `LayoutTab`, `LayoutSkill`, `PluginManifest`,
`SlashCommand`, `SlashCommandParam`, `ToolDef`, `ToolMetadata`, `ToolPermissions`,
`ToolCallResponse` and `ConversationStats`. Import other domain types, such as
`LayoutConfig` and `LayoutAction`, from their owning contract subpath rather
than assuming the SDK re-exports them.

### SDK-specific types

```ts
interface AgentSummary {
  slug: string;
  name: string;
  prompt?: string;
  model?: string;
  region?: string;
  source?: AgentSource; // legacy compatibility label, not an engine discriminator
  guardrails?: AgentGuardrails;
  tools?: AgentTools;
  ui?: AgentUIConfig;
  /** The installed plugin that contributed this Agent; absent for any other. */
  plugin?: string;
}

interface Agent extends AgentSummary {}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  attachments?: MessageAttachment[];
  toolCalls?: ToolCall[];
  finishReason?: string;
}

interface MessageAttachment {
  type: string;
  content: string;
  mimeType?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: any;
  result?: any;
  status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'error';
}

interface Conversation {
  id: string;
  agentSlug: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessage?: string;
}

/** @deprecated Alias of `SDKNavigation`, what `useNavigation()` returns. */
type NavigationState = SDKNavigation;

// The root export selects the prompt-based invoke API type shown above.
type InvokeOptions = import('@kontourai/station-sdk').InvokeOptions;

interface InvokeResult {
  success: boolean;
  output?: string;
  error?: string;
  toolCalls?: any[];
}

interface LayoutComponentProps {
  agent?: AgentSummary;
  layout?: LayoutDefinition;
  activeTab?: LayoutTab;
  onLaunchPrompt?: (prompt: AgentQuickPrompt) => void;
  onLaunchWorkflow?: (workflowId: string) => void;
  onShowChat?: () => void;
  onRequestAuth?: () => Promise<boolean>;
  onSendToChat?: (text: string, agent?: string) => void;
}

type LayoutComponent = (props: LayoutComponentProps) => ReactElement;
type EventHandler<T = any> = (event: T) => void;
```
# Host transport binding lifetime

Native hosts that own an authenticated transport may opt in to
`transportBindingIsCurrent` on `ClientCredential`. The SDK checks this host
predicate before dispatch, before credential success/failure reporting, and
around SDK-owned response body reads and clones. It prevents a response from a
superseded host binding from being attributed to the current native connection.
It is intentionally separate from `requestAuthority`: a valid authenticated
recovery may advance credential generation while its host binding remains live.
Ordinary unscoped SDK calls do not gain a host binding requirement.

### Selected-route raw browser egress

Browser hosts that have features using direct XHR, fetch or WebSocket outside
the SDK transport can install `setClientRawEgressPolicyResolver` from the
`@kontourai/station-sdk/client` entry. The resolver returns the current
`ClientRawEgressPolicy`: `kind` is explicitly `direct` or `broker`, and the
policy carries the selected API base, connection id, activation epoch and an
`isCurrent()` check. `getClientRawEgressPolicy()` exposes that snapshot to
host-owned features such as telemetry. Do not infer route kind from whether a
transport callback is present.

Call `assertClientRawEgressAllowed(apiBase, channel, expectedBinding)` directly
before raw content dispatch and after any asynchronous setup. It throws
`StationRawEgressUnavailableError` for a broker route and
`StationRequestAuthorityError` when the captured connection or request scope
has changed. Normal SDK requests continue through their configured transport;
this guard exists for browser features that cannot use it. Clear the resolver
when the host connection provider is disposed.

### Package host actions

Import `useWorkspacePaneHostActionsQuery` and `useWorkspacePaneHostActionMutation`
from `@kontourai/station-sdk/workspace-pane`. The query projects a Project's
installed package actions and exact installation-bound available/default Agents.
The mutation accepts the package id, opaque installation generation, opaque
action key, and an optional explicit Agent reference from that package's
available set. Fixed action bindings always take precedence. There are no
physical package paths in this API.

The portable client exports `getWorkspacePaneHostActions`,
`prepareWorkspacePaneHostAction`, and `executeWorkspacePaneHostAction` from
`@kontourai/station-sdk/client`. Preparation returns a short-lived, actor- and
Project-bound one-shot ticket, held in memory for 60 seconds. A restart loses
unused tickets. Execution consumes it before any provider work.
Do not store or log tickets, and never retry execution automatically. An
`indeterminate` result means work may have started; use existing Activity and
conversation evidence to inspect it. An accepted result carries distinct
conversation, execution-session, and provider-turn identities.

For an external client, obtain the Station API credential through the deployment's
existing authentication flow and pass it to all three calls. Keep `apiBase`,
Project, and credential fixed for the operation. This function runs a named
installed action using its authored default or fixed Agent; it does not select
the first available Agent:

```ts
import {
  getWorkspacePaneHostActions,
  prepareWorkspacePaneHostAction,
  executeWorkspacePaneHostAction,
} from '@kontourai/station-sdk/client';

export async function runPackageAction(
  apiBase: string,
  projectSlug: string,
  credential: string,
  pluginId: string,
  actionId: string,
) {
  const options = { headers: { Authorization: `Bearer ${credential}` } };
  const catalog = await getWorkspacePaneHostActions(apiBase, projectSlug, options);
  const contribution = catalog.contributions.find(
    ({ projection }) => projection.owner.pluginId === pluginId,
  );
  const action = contribution?.projection.actions.find(({ id }) => id === actionId);
  if (!contribution || contribution.reason || action?.availability !== 'available') {
    throw new Error('Review the installed package and its Project Agent configuration.');
  }
  const prepared = await prepareWorkspacePaneHostAction(apiBase, projectSlug, {
    ...contribution.projection.owner,
    actionKey: action.key,
  }, options);
  if (prepared.state === 'unavailable') return prepared;
  return executeWorkspacePaneHostAction(apiBase, projectSlug, prepared.ticket, options);
}
```

Render an `unavailable` reason for the user to resolve, and expose the returned
Session/conversation identities for an `accepted` result. Treat a thrown catalog
or preparation error as an unavailable operation; do not downgrade to an ordinary
chat launch. For `indeterminate`, direct the user to Activity without calling
this function again automatically. Catalog availability is a display snapshot;
preparation and execution repeat authorization against the current installation.

Host actions require the package's current `agents.invoke` permission. They use
captured Project and Agent authority at provider invocation and cannot substitute
an ambient Agent, override a fixed action, or revive a retired installation.
Host actions currently admit `own-plugin-agent` references. Those package-owned
Agents may use Station's engine or an external engine, in shared or provisioned
Project worktrees; a `station-agent` reference to an arbitrary global Agent is
not admitted. Native execution preserves the configured Agent and model. Its
private relay verifies the runtime generation and repeats admission immediately
before the model call. Provisioning binds the exact Session, Project and working
directory. The native relay uses that directory for Project context, Bash
children and relative file operations; explicit MCP resource roots keep their
configured meaning.

A host-created Session retains server-stamped `workspacePaneHostAction` metadata:
package id, action id, and opaque installation generation. These coordinates
survive completion and package removal alongside the existing Session command
receipts. Public metadata/options cannot forge this reserved field; callers
receive the existing client-origin and principal attribution as well.

Host action reads and mutations accept the standard `ApiRequestScope`/client
request options. Pass a captured scope to keep preparation and execution on the
same Station and authority; omitted scopes retain legacy ambient behavior.
Before exposing a result, the mutation waits for its canonical Session and
conversation-inventory refresh attempts to settle, including failures. In
Station's host UI, **Open
conversation** uses canonical resolution and hydration; **View result** stays
anchored to the execution Session returned by this invocation. A removed Agent
falls back to read-only evidence, never to another default Agent.

The [host UI](../../src-ui/src/workspace-panes/WorkspacePaneHostActions.tsx),
[SDK client](../../packages/sdk/src/client/workspace-pane-host-actions.ts),
[ticket owner](../../src-server/services/plugins/workspace-pane-host-actions.ts),
[invocation admission](../../src-server/services/plugins/workspace-pane-host-admission.ts),
and [runtime bridge](../../src-server/runtime/routes/workspace-pane-host-actions.ts)
own these stages.

## Package lifecycle results

`listPlugins` also reports optional `installationReadiness`: `ready`, `pending`
(with `recovery: "review"`), or `unavailable`. Absence preserves compatibility
with older servers; it is not a new readiness proof. Keep pending rows visible,
but do not load their bundles or enable their actions. The server sets
`hasBundle: false` until readiness is established. Project Pane availability
uses `installation-pending` or `installation-unavailable` diagnostics, separate
from distribution-policy disablement. Readiness notifications refresh the
Project Pane and host-action catalogs as well as the installed-plugin list.

For a `ready` row, `listPlugins` also reports the plugin's validated palette
`commands` (an empty array when it declares none), an opaque
`installationGeneration` that a command request echoes back, and
`commandsRejected: { reason }` when Station dropped invalid declarations.
Pending and unavailable rows omit all three. The generation is not authority:
Station admits each command effect against the installed declaration (see
[Plugin Command Effects](api.md#plugin-command-effects)). `listPlugins` rejects
a response whose `installationGeneration` is not bounded text or whose
`commands` is not an array. Station's palette admits and settles effects
through `@kontourai/station-sdk/client/plugin-command-effects`
(`admitPluginCommandEffect`, `settlePluginCommandEffects`).

`listPlugins` includes optional `retainedOnRemoval` metadata for packages using
retained code generations. Normal package updates keep their stable data
scope. `usePluginInstallMutation` accepts optional `dataPolicy`: `preserve`
is the default; an explicit `retain-and-reset` starts a new data scope while
retaining the previous scope. The latter is a reset choice, not a claim of
state-preserving update. The host preview exposes `existingDataScope` so the
first-party confirmation can explain the choice before submitting it.

Removal success means future contributions are withdrawn. A retained package
returns lifecycle metadata with `reclamation: not-proven`; the UI must not say
its bytes or external effects were deleted. See the
[installation lifecycle](../design/plugin-installation-lifecycle.md).
### Inspect a learning source

`observeLearningSource(apiBase, reference, options?)` is available from
`@kontourai/station-sdk/client`; `useLearningSourceObservationQuery(reference,
requestScope, enabled?)` is available from the SDK root. The `apiBase` is the Station origin, as with other client operations. The reference carries
`rootId`, exact `recordId`, and `rootIdentity: knowledgeRootIncarnationKey(root)`.
The existing root identity helper remains exported by the SDK. The client sends
its URI-encoded value in the bounded `x-station-knowledge-root-identity` header;
it is a metadata mismatch precondition, never an authorization grant or immutable
incarnation. Identically restored registrations can share the same key.

The GET endpoint is `/api/knowledge/roots/:rootId/records/:id/source-observation`.
It requires a currently authorized, middleware-bound home-possession credential,
current route scope, single-operator deployment without tenant-scoped execution,
and the exact registered personal `kit-default-store` root.
Ordinary operator or paired remote credentials do not confer this capability.
The constructor policy and route recheck authority before publishing the result.
Other roots and credentials receive an identity-free restricted outcome.

`LearningSourceObservation` (`station-contracts/learning-review`) distinguishes
`observed` with `kind: 'source-only'` from identity-free failure states. Source
status is generic record status, not learning activation. Content digest/time are
Station observations; owner revision, freshness, and transaction state remain
unknown, and the observation is non-atomic. The source read does not construct an
adapter, repair records, or mutate the store. Ordinary recall reads retain their
existing behavior.

`KnowledgeRecallBrowser` and `KnowledgeRecordDetail` accept optional
`renderRecordActions({ rootId, recordId })`. The slot is host-rendered and appears
only for the exact selected loaded record. It introduces no Station UI dependency
into the SDK. Station's Memory view uses it to open the source inspector.

#### Public source-inspection integration behavior

This surface is usable by any host built against the public Station packages; it
does not require Station app internals or a particular company's filesystem
layout. Obtain the selected root/record from the public Knowledge APIs. Use the
[local Station launcher](cli.md#the-station-launcher) to redeem its one-time
bootstrap link for the browser's home-possession session, or the documented
[local grant flow](cli.md#scripted--non-interactive-use) for a local client. Do not
substitute an operator API credential, a claimed locality field, or a loopback URL.
A saved operator bearer takes precedence over a browser cookie; select the genuine
local device-session connection when presenting the launch session.

Hosts using Connect can capture credential evidence with its public
`useConnections()` surface and derive the request scope with
`requestAuthorityScopeFromCredentialEvidence`. Bind the SDK credential resolver
to that same current evidence. The source hook accepts that public `ApiRequestScope`;
there is no dependency on Station's private `ApiBaseContext`. The optional
`renderRecordActions` slot lets the host supply its own source presentation.

`apiBase` is the origin without `/api`. The reference must contain a selected root
ID and exact record ID (at most 200 characters each); aliases are unsupported.
Use the public root-key serializer, also available from
`@kontourai/station-shared/knowledge-root-identity`. It serializes compact JSON in
this order: root ID, scope kind, project slug or null, adapter ID, store root,
display name, creation timestamp. Send its URI-encoded UTF-8 representation in
`x-station-knowledge-root-identity` (at most 8,192 characters after encoding). This
metadata comparison does not detect an identically restored registration or
provide a revision/CAS contract.

Unauthenticated ingress returns HTTP 401; missing route scope returns HTTP 403;
invalid route references return HTTP 400. An admitted route returns the standard
`{ success: true, data }` envelope: `observed` supplies only source fields, while
`restricted`, `unsupported`, `missing`, `busy`, `corrupt`, `unavailable`,
`invalid-input`, and `over-budget` contain no source identity. The reader bounds
the complete source file to 256 KiB and refuses rather than truncating it.
`busy` can be retried after the store operation settles. A stale registration must
be reselected from fresh root data; retrying the old key cannot adopt its
replacement. The SDK rejects malformed/mismatched observations and withholds
cached source data during revalidation and failed reads.

Hosted deployment and tenant-scoped execution are explicitly refused even for
otherwise valid local credentials. Project/tenant record authorization and owner
learning lifecycle intents are separate future contracts. Hosts should present
these limits directly, without treating a source read as candidate approval,
promotion, or effect evidence.

Follow the [SDK reader](../../packages/sdk/src/client/learning-source.ts),
[query hook](../../packages/sdk/src/query-domains/knowledgeStores.ts),
[route](../../src-server/routes/knowledge/knowledge-source-routes.ts),
[request policy](../../src-server/knowledge-store/knowledge-source-observation-policy.ts),
and [record reader](../../src-server/knowledge-store/knowledge-store-provider.ts).
The [source dialog](../../src-ui/src/views/learning-review/LearningSourceDialog.tsx)
shows how the host withholds data after authorization changes.

### Exact attention request inspection

When enabled, `useAttentionRequestInspection(reference, requestScope)` reads the
exact Session/request/opened-event tuple again on every mount. The server checks
current authority. Its query key includes the
host-captured authority; cached data is withheld until the fresh read finishes.
The imperative `inspectAttentionRequest` is also exported from the React-free
client entry. Neither API chooses a replacement request automatically.

```ts
import { inspectAttentionRequest, respondToRequest } from '@kontourai/station-sdk/client';

const inspection = await inspectAttentionRequest(requestScope.apiBase, reference, {
  requestScope, signal,
});
// Only after an explicit user decision on an open, answerable inspection:
await respondToRequest(requestScope.apiBase, {
  threadId: reference.threadId,
  requestId: reference.requestId,
  expectedRequestEventId: reference.requestEventId,
  decision,
}, { requestScope });
```

The host captures `requestScope`; do not reconstruct it from a URL or title.
Response commands preserve their existing receipts. An event mismatch or lost
request authority is a refusal to act, requiring fresh inspection rather than a
blind mutation retry. Requests without canonical approval/permission evidence
keep their ordinary Session or notification fallback.

See the [hook](../../packages/sdk/src/request-inspection.ts),
[response parser](../../packages/sdk/src/client/request-inspection.ts), and
[exact-event reader](../../src-server/services/orchestration/request-inspection.ts).

## Cloud target observation

`verifyCloudMoveTarget(apiBase, options?)` from
`@kontourai/station-sdk/client` powers `station cloud verify-target`. Use an
explicit Station origin and its enrolled credential resolver, or pass
`credential` with its matching `credentialOrigin`. UI callers should also pass
the connection's `requestScope` so an authority change invalidates the read.

The function returns a `CloudMoveTargetObservation` only when discovery is
bracketed by matching instance, boot and build identities. The observation
contains no secrets and always reports `executionAuthorityTransferred: false`
and `executionResumeAvailable: false`. It is process reachability evidence,
not persistent home identity, a compatibility certification or a transfer grant.

The shared GET transport supports opt-in `requireCredential`, `redirect: 'error'`
and `maxResponseBytes` options. The probe requires SDK-owned matching bearer
attachment or a current authenticated native transport binding. It refuses
redirects, limits each body to 4 KiB and uses a shared 15-second deadline. Existing callers retain their current defaults.

The [client](../../packages/sdk/src/client/cloud-move.ts) reads identity,
discovery, then identity again; it rejects a changed instance, boot or build.
The [CLI caller](../../packages/cli/src/commands/cloud-target.ts) requires one
explicit enrolled target selector and configures credentials before that read.

### Restored conversation execution

A resolved conversation-open response may include `execution`, an observation
of the exact authorized current Session: Agent, engine provider, recorded
engine connection when known, and separately reported/retained versus accepted
model identities. This is distinct from inventory labels and mutable Agent
defaults. The read refuses a lineage change across its awaited work instead of
combining one child's labels with another child's transcript. No resume cursor
or credential data is exposed.

After a child changes, the composer refreshes this execution identity and drops
predecessor model controls and local approval state. Draft text remains; queued
messages require review. A same-child unsent model choice waits for current
capability evidence and is retained only when supported. If an older server
cannot establish a changed child's execution binding, the transcript remains
available while sending stays unavailable. Open-chat labels prefer the exact
current Session's reported/retained model rather than a persisted predecessor.

For native chats, the engine observation is separate from the LLM provider
selection. A retained unsent choice must match its own currently available model
connection, not an engine-connection identifier or another provider's identical
model name. The initial accepted Session launch plan is not presented as proof
of the connection used by a later turn. Unknown current-provider provenance
stays unknown rather than being reconstructed from Agent defaults.

Follow the [server resolver](../../src-server/services/orchestration/conversation-open-resolver.ts),
[wire parser](../../packages/sdk/src/conversation-open.ts),
[chat-state update](../../src-ui/src/components/chat-dock/conversationOpenController.ts),
and [revalidation caller](../../src-ui/src/components/chat-dock/ConversationOpenRevalidator.tsx).

## Home recovery disclosure

`SystemStatus.homeRecovery` is an optional, host-scoped disclosure returned by
system-status queries. `recovered-from-copy` includes `recoveryId`,
`snapshotCreatedAt`, and `authorityTransferred: false`. `not-restored` means
this home has no recovery record; `unavailable` means its record could not be
verified. Older servers may omit the field. None of these values grants
execution authority or proves a witnessed channel transfer. Do not reuse a
cached recovery notice across API-base changes; refresh the selected Station
before projecting it as current. The record exposes no filesystem path or
backup manifest contents.

The [recovery-record reader](../../packages/shared/src/station-home-archive.ts)
checks the local record; [runtime composition](../../src-server/runtime/routes/runtime-route-support.ts)
selects the public disclosure. This is not a fresh verification of every file
in the recovered home.

## Update status diagnostics

`requestCoreUpdateStatus(apiBase?, signal?)` validates `GET
/api/system/core-update` responses instead of casting them. Alongside the
existing fields, `CoreUpdateStatus` carries five optional diagnostics:
`serverIdentity` (the answering server's identity triple, from
`@kontourai/station-contracts/system-status`), `provenanceIssue`
(`'missing' | 'invalid-stamp'`, the typed reason the server's install
provenance resolver minted), `technicalDetail` (the provenance detail or
caught comparison diagnostic — filesystem paths live here, not in
`message`), `selfUpdateUnavailableReason` (why the server refuses to apply an
update to itself, as text: a desktop bundle's self-update eligibility, or a
source checkout running under a supervisor — the installed service or another
supervising process), and
`selfUpdateUnavailableCode` (the same refusal as a code: `'service-managed'`
for the installed launchd/systemd service, `'supervised'` when only a
supervisor PID is present). The parser requires a boolean `updateAvailable`
and safe-integer supplied counts, normalizes a malformed identity or an unknown
provenance or refusal code to unavailable (`null` — an unknown code never
reads as a specific one; the refusal text still accompanies it), accepts responses from older servers that omit the new fields
entirely, and never infers `applyMethod` from `updateAvailable`. A non-ok
HTTP status throws a `StationHttpError` before the body can read as success;
a genuine `error` field still throws a plain `Error` with the server's
message.

This is field-specific parsing: `installKind` and `releaseCheck` are checked
against their known values (an unknown value is left out), while `applyMethod`
is still passed through without enum validation. See the
[parser](../../packages/sdk/src/system-update-status-parser.ts) and
[request boundary](../../packages/sdk/src/query-domains/systemRuntimeRequests.ts).

`requestSystemIdentity(apiBase, signal?)` reads `GET /api/system/identity`
through the same rules: a complete identity triple is required, optional
`shaSource` and `devicePresentation` metadata is dropped when malformed, and
the 503 `identity_unavailable` branch surfaces as a `StationHttpError` with
its status preserved. Both functions are re-exported from
the root `@kontourai/station-sdk` entry. `src/queries.ts` is an internal barrel;
`@kontourai/station-sdk/queries` is not an exported package subpath.

A prebuilt release archive (#2675) reports `installKind: 'archive'`, or
`'archive-service'` when the Station service's fixed launcher runs it and can
update it. Its status carries `currentVersion`, `latestVersion` (the newest
version its signed release manifest names), `channel` (the release ring), and
`releaseCheck`: `'verified'`, `'unreachable'`, `'unverified'` (the manifest
arrived but did not verify against the pinned keys), or `'not-recorded'`. The
parser leaves out an `installKind` or `releaseCheck` it does not know rather
than passing it on. `applyMethod` is `'service-update'` for an
`archive-service`, `'station-upgrade'` for an installed archive no launcher
runs, and `'reinstall'` for any other archive copy. An `archive-service`
status also carries `serviceUpdate`, a `ServiceUpdateProgress` from
`@kontourai/station-contracts/system-status` (an update under way, or the
last one's outcome). `applyCoreUpdate` returns `serviceUpdate: { requestId }`
when it queued such an update; follow it with
`requestServiceUpdateProgress(apiBase, signal?)` (`GET
/api/system/core-update/service-update`) or
`useServiceUpdateProgressQuery(apiBase, { enabled, scopeKey?, refetchInterval
})`, correlating the outcome by `requestId`. A progress body this SDK cannot
read parses as `{ state: 'unavailable' }`, never as a neighbouring state, and
a non-ok status throws a `StationHttpError`.

`useCoreUpdateStatusQuery(apiBase, config?, scope?)` accepts an optional third
`CoreUpdateStatusScope` argument: `{ scopeKey?, assertCurrent? }`. When
`scopeKey` is present it joins the query key. The caller must derive a distinct
key for each connection/boot it wants to keep separate; the hook does not derive
that identity.
`assertCurrent` is checked immediately before the request is issued and again
after it resolves — throwing rejects the fetch, so an obsolete or superseded
scope's completion never resolves as current data. Both fields are
secret-free: credentials and credential-evidence objects must never enter a
query key or these callbacks. Existing two-argument callers are unaffected.

The current Settings callers pass `context.isCurrent` directly, which returns
a boolean. The hook ignores that return value, so `false` alone does not reject
the query through this guard. Other scope keys, transport checks and UI
availability checks still apply. Callers needing this pre/post refusal must
supply a callback that throws when stale. See the
[hook](../../packages/sdk/src/query-domains/systemRuntime.ts),
[host predicate](../../src-ui/src/hooks/useConnectedServerUpdateContext.ts),
and [Settings caller](../../src-ui/src/views/settings/CoreUpdateCheck.tsx).

## Saved answer quotations

`getAssistantQuoteSource(apiBase, sessionId, turnId, options)` from
`@kontourai/station-sdk/quote-source` reads a bounded completed answer through
`GET /api/orchestration/sessions/:sessionId/turns/:turnId/quote-source`.
Pass the host-captured `requestScope` and an abort signal. The result is
`OrchestrationQuoteSource`: exact Session/turn/message identifiers, source text,
and a SHA-256 text revision. Reads recheck current access and do not load the
whole Session. Missing and denied answers are indistinguishable; an oversized
answer is refused. A text revision detects changes, not evidence standing.

The Station composer retains up to three selected excerpts, each at most 4,096
UTF-16 code units, with its existing local draft. Sending serializes the user's copied text and source references
into the ordinary user message; it creates no capability or trust grant.
Inspecting a saved reference reads its original answer under current access
on the selected Station. No network request is made to an origin supplied by
an untrusted quote link. The saved quotation and a changed current source
remain visibly distinct.

See the [SDK reader](../../packages/sdk/src/client/quote-source.ts),
[turn-query owner](../../src-server/services/orchestration/session-query-module.ts),
[quote serializer](../../src-ui/src/utils/answer-quotes.ts), and
[source-inspection UI](../../src-ui/src/components/chat/QuoteSourceLink.tsx).

## In-app pull-request review

`@kontourai/station-sdk/pull-request-review` exports `getPullRequestReview`,
`submitPullRequestReview`, and `mergeReviewedPullRequest`. Pass an explicit
Station API base, a `PullRequestReviewTarget` (provider, host, repository owner
and name, native ref, and resolving Project context), and the host-captured
`requestScope`. Repository identity never comes from a display URL.

Review reads validate the returned exact target and revision. Approvals and
review-origin merges carry the inspected head SHA to the provider. The provider
CLI owns forge authentication; Station does not store forge credentials.
Confirmed review acknowledgements include the observed actor. GitLab ordinary
comments are not commit-bound; their acknowledgements omit `headSha`.

Retain a draft after an indeterminate response and inspect current provider
state before another submission. A missing or unverifiable acknowledgement is
not a safe automatic-retry signal. Unsupported review adapters return an
explicit unavailable result. Diff bytes and discussion are bounded and may be
partial; the response says which content could not be supplied.

See the [SDK client](../../packages/sdk/src/client/pull-request-review.ts) and
[forge review adapter](../../src-server/services/pull-requests/pull-request-review.ts).

`usePullRequestMergeabilityQuery(provider, host, owner, repo, project, config)`
reads a repository's open pull requests narrowed to `PullRequestBranchMergeability`.
Its key, `pullRequestMergeabilityQueryKey`, names the project and repository and
no Session, so every observer of one repository shares one cache entry. It
resolves the checkout from the project alone. `QueryConfig.refetchOnWindowFocus`
opts one read back into refetching a stale answer when the window returns;
Station's client default leaves it off.

`usePullRequestContextQuery({ project, thread }, config)` reads the Session's
recorded checkout context. Its available result includes the local `branch` and
optional `pushTargetOwner`, the owner selected by the branch's push-remote
configuration and push URL. The repository identity still names the PR read
target. Mergeability rows optionally include `sourceOwner` from GitHub's head
repository owner; GitLab omits it. A conflict indicator matches the local branch
and compares these owners case-insensitively when both are present. If either
owner is absent, it matches on branch alone; the upstream branch name is never
a substitute for the local branch.

## Conversation pull-request links

`@kontourai/station-sdk/conversation-pull-request-links` reads, links, and
unlinks exact pull-request identities for one Conversation. Each call takes
the selected Station API base; pass the captured `requestScope` in its optional
request options to preserve that authority across awaits. The client permits
unscoped calls. A link is persisted
only after the provider resolves the exact provider, host, repository owner,
repository name, and native ref under current authorization.

Reads refresh every identity and return `observedAt` plus current,
unsupported, or unavailable state. Clients should mark an old cached
observation stale and require refresh before review or other actions. Explicit
unlink changes only the Conversation association; it never changes the pull
request or deletes Task-kept provenance.
A refresh that observes a pull request merged also lets Station reconcile the
Tasks a person opted in to closing on merge when the caller holds the operate tier;
it changes nothing in what the read returns (see the [API reference](api.md#keep-a-declared-output)).

The [client](../../packages/sdk/src/client/conversation-pull-request-links.ts)
and [route/store boundary](../../src-server/routes/pull-requests/conversation-pull-request-links.ts)
own explicit links separately from provider-derived or Task-kept references.

## Files in answers to input requests

`getInputReplyContext(apiBase, reference, options)` from
`@kontourai/station-sdk/input-reply` resolves the exact open input event to its
Agent, Conversation and declared attachment transport capabilities. It does not
turn an approval or permission request into a text-answer operation.

Use `sendExecutionMessage` with that exact current-Station target and
`expectedInputRequest: reference`. The foreground route checks the binding, and
the orchestration owner checks the same open event again before adapter input.
Opaque `attachmentRefs` use the existing current-host staging path; retries
retain the same `clientTurnId` and payload after an uncertain response. Pass the
captured host `requestScope` to each read, staging operation and send.

For a delegated task's open input request, `continueDelegatedTask(apiBase,
taskId, { message, environmentId, expectedInputRequest })` binds the answer to
`{ threadId, requestId, requestEventId }` on the Station serving the task. The
snapshot's `pendingRequest` carries `eventId`, and its `currentSessionId` is the
`threadId`. The serving Station refuses a changed request with
`input_request_changed`. A forwarding Station sends the binding only to a
Station advertising `delegatedInputAnswers` (`hasCapability`). Text-only: no
attachments travel this way.

The [SDK parser](../../packages/sdk/src/client/input-reply.ts),
[request route](../../src-server/routes/orchestration/orchestration.ts),
[dispatch owner](../../src-server/services/orchestration/orchestration-service.ts),
and [input-reply UI](../../src-ui/src/components/attention/NeedsInputReply.tsx)
show the complete binding. The UI retains an uncertain attempt and locks its
payload; only a provably unsent failure clears that attempt for editing.

## Mobile device inspection

The opt-in `@kontourai/station-sdk/mobile-device` subpath exports
`fetchMobileDeviceInventory(apiBase, options?)` and
`captureMobileDevice(apiBase, target, options?)`, the shared inventory/target/capture
types, and `MobileDeviceRequestError` with an HTTP status. Both use the existing
`ClientRequestOptions` credential and origin boundary. Responses are validated;
capture refuses mismatched targets and returns a timestamped PNG, not stream
readiness or foreground-app provenance. See [Mobile device inspection](../guides/mobile-device-workspace.md)
for host setup, access scopes, limits, and the web/desktop integration boundary.

Inventory additionally accepts optional `projectSlug` and `hostId` arguments;
the host defaults to `local`. The one-frame capture client currently accepts
UUID-shaped iOS IDs and Android `emulator-<number>` IDs. Use
`isCaptureableMobileDeviceTarget` before offering that action: a listed device
is not necessarily accepted by this capture API. Capture does not boot a device
or establish a live session. See the [SDK boundary](../../packages/sdk/src/mobile-device.ts).

## Experimental encrypted-channel transport consumer

`@kontourai/station-connect/application-channel` supplies a Fetch-shaped adapter
for the SDK's existing host credential/transport resolver. It accepts a fixed
Station origin, a connection lifetime signal, an owner-provided authenticated
channel opener and a current endpoint-trust check. It does not resolve a person,
issue a Device grant or sign an account continuation. The existing
`ApplicationSessionClient` owns those proof headers, and the Station still
verifies them.

This adapter is opt-in and currently qualified by the
[local SDK framing fixture](../guides/local-collaboration-lab.md#sdk-application-framing-over-the-encrypted-channel),
with explicit request/frame bounds and a separate full-runtime acceptance gap.
Configure the Device credential on the host resolver for channel calls. Passing
`credential` together with `credentialOrigin` as per-call options deliberately
bypasses that resolver and uses direct HTTP; an `ApplicationSessionClient` on
this transport instead uses the configured resolver with `requireCredential`.
The adapter retains explicit SDK headers separately from a browser `Request`,
whose header guard removes `Origin` in anticipation of a later HTTP network step.
The encrypted browser fixture checks that the original client Origin reaches
the receiver.

Connection owners must retain ordinary SDK authority guards and the selected
account's request scope, bound channel counts/lifetimes, and close the transport
when its endpoint trust retires. Transport readiness alone does not partition
account or Project data. An
uncertain dispatched mutation must not be retried automatically.

The [channel adapter](../../packages/connect/src/core/applicationChannel.ts)
and [credential resolver](../../packages/sdk/src/client/http.ts) show where
framing ends and the application's authority checks begin.

## Orchestration approval deadlines

Orchestration command failures retain HTTP status even when the response omits
a machine code. `resolveOrchestrationRequest` accepts an optional `timeoutMs` and forwards it
to the command transport. Station's approval UI supplies 15 seconds and uses a
separate 5-second exact-request inspection after a failed send. A timeout is
not proof that a decision was refused; callers must inspect before retrying an
uncertain mutation. The request's thread, request ID and opened-event binding
continue to govern resolution.

## Harness question answers

`respondToRequest` from `@kontourai/station-sdk/client` accepts form
`content` (`InputRequestContent`, #3390) alongside `decision: 'accept'` and
`expectedRequestEventId`, for a harness question or a tool server's form.
The pre-#3390 `answers` batch is deprecated since 0.9.0 and removed in
0.10.0.
Capture the request's thread, request and opened-event IDs, and pass the
current explicit `requestScope`; the server validates the exact pending
question before forwarding it. See the [Session API](session-api.md#respondtorequest)
for the wire shape and limits. Inspection preserves `requiresAnswers` for
clients that must direct the user to the inline question card.

The server validates content against the opened form whatever the client
checked. `useAgentMcpPromptsQuery(agentSlug)` reads
`GET /agents/:slug/mcp-prompts` (cache key `agentMcpPromptsQueryKey`) and
`runAgentMcpPrompt(agentSlug, { serverId, name, arguments })` reads one prompt
and returns the text to send; a refusal throws the server's reason as a
`StationHttpError`, retaining HTTP status, machine code, details and
`Retry-After` when present. See the [commands guide](../guides/commands.md)
for scope and limits.


## Engine account queries

The additive `@kontourai/station-sdk/engine-accounts` entry exposes account,
selected quota and live login queries, explicit login/account-create mutations,
and engine activity queries. Every caller supplies a captured `ApiRequestScope`;
keys partition API base, authority, engine connection and profile. Login retries
are disabled and live status polls only while a login is pending. Quota refresh runs every minute while the account query is mounted and visible, and can also be requested explicitly. Strict contracts live in
`@kontourai/station-contracts/engine-accounts`. Quota queries strictly parse
optional account/credit/model, Claude spending/breakdown/limit metadata and
response-shape audit fields and bounded hourly allowance history on both
known and unknown quota variants. `useEngineActivityQuery` accepts an optional
credential profile filter: `null` selects the default profile, a string selects
a saved profile, and an omitted filter includes all engine accounts. Older
usage without an account observation remains excluded from profile totals. Consumers must not treat unknown quota as zero
or credit balances as dollars. Window durations come from the provider, rather
than inferring five hours from the primary position.

These exports require a release containing this change; current source presence
is not evidence of npm publication. The Connections guide owns account-viewing,
sign-in, permission and cost-attribution limits.


### Paired-person profile reads

`usePairedDevicesQuery(apiBase?, config?)` accepts `requestScope` and
`requireRequestScope`. Scoped cache keys include API base and authority key;
the HTTP reader checks that captured authority before consuming the response.
With required scope absent, the observer is disabled under an isolated key.
The default poll pauses after HTTP 401/403; explicit retry or Profile-page remount can reauthorize the read. `QueryConfig.refetchIntervalForError` can return `false` to pause polling or a number for an error-specific interval; `undefined` preserves the numeric interval. The Profile page uses this mode for approved person bindings and current
connection projections. This list requires the pairing route's existing access
and does not share another person's usage statistics.


### Station operator usage queries

Usage and provenance consumers can import provider scope, context validation,
and cache-inclusive token helpers from
`@kontourai/station-shared/usage-semantics`. The
[shared leaf](../../packages/shared/src/usage-semantics.ts) owns these bindings;
`usage-fold` re-exports them for existing consumers and retains event accounting
and observation allocation.

For a lazy view, import `useStationUsageQuery` from
`@kontourai/station-sdk/station-usage-query`. The
[owning module](../../packages/sdk/src/query-domains/stationUsage.ts) keeps the
operator query separate from analytics used at startup. The SDK root retains
its existing hook export.

`useStationUsageQuery(scope, config?)` reads the current local instance overview
through `GET /api/analytics/station-usage`. Supply a captured `ApiRequestScope`;
without it, the query stays disabled under an isolated key. Its cache includes
API base and authority key, never credentials. The React-free client export
`fetchStationUsage(apiBase, options?)` is available from
`@kontourai/station-sdk/client` and accepts the same captured request scope.
The returned `StationUsageOverview` contains `stationId` and canonical
`UsageStats` from `@kontourai/station-contracts/usage-stats`.

The hook polls every 30 seconds while enabled and refreshes stale data on mount/focus.
HTTP 401/403 stops polling; explicit retry can reauthorize the read. A consumer
must hide cached data on an error or lost authority, as the Profile operator
panel does. A query key is not an operator grant. The server requires the bound
home-possession local operator on a personal host; hosted deployments and tenant
workers are refused. Ordinary usage/rescan responses omit the person breakdown.

The [monitoring guide](../guides/monitoring.md#operator-view-of-this-instance)
owns measurement and attribution limits. Source exports require a release
containing this change; source presence is not evidence of npm publication.


### Authorized receipt observers

Lazy receipt views can import `useUsageRollupQuery` from
`@kontourai/station-sdk/usage-rollup-query`, backed by the
[receipt query module](../../packages/sdk/src/query-domains/usageRollup.ts).
The SDK root retains the same hook and fetcher exports.

`useUsageRollupQuery(query, config?)` accepts `requestScope` and
`requireRequestScope`, with the same captured-authority rules as the operator
query. Scoped keys include Station, authority, and the explicit credential-profile
filter; all accounts, the default profile, and a named profile remain distinct.
The Profile receipt panel requires a scope and clears its page position when
authority changes. HTTP 401/403 pauses default polling; cached rows are hidden
on error or lost authority. `fetchUsageRollup(query, options?)` forwards captured
request options, while the React-free client fetcher preserves HTTP refusal
status as `StationHttpError`. These client controls confer no access.

### Station peer enrollment

The React-free client entry and SDK root export
`startPeerEnrollment(apiBase, input, options?)`,
`getPeerEnrollment(apiBase, id, options?)`,
`completePeerEnrollment(apiBase, id, options?)`, and
`cancelPeerEnrollment(apiBase, id, options?)`. The
[client owner](../../packages/sdk/src/client/peer-enrollments.ts) always receives
the controlling Station's API base explicitly. `ClientRequestOptions` carries
its captured `requestScope` and optional cancellation signal; the remote
destination belongs only in the enrollment input.

`PeerEnrollmentInput` and secret-free `PeerEnrollment` are owned by
`@kontourai/station-contracts/environment-security`. Start uses a caller-retained
UUID plus `apiBase`, expected `environmentId`, and optional `label`. Reuse the
same UUID and exact intent after a lost acknowledgement; do not create another
request automatically. GET reads local status. Completion explicitly checks
approval and may install the separately granted peer credential on the server.
Cancellation affects local pending enrollment, not receiver revocation.

The [query owner](../../packages/sdk/src/query-domains/peerEnrollments.ts) exports
`usePeerEnrollmentQuery(apiBase, id, requestScope?, config?)` and
`useStartPeerEnrollmentMutation`, `useCompletePeerEnrollmentMutation`, and
`useCancelPeerEnrollmentMutation`, each taking `(apiBase, requestScope?)`.
Query/cache identity includes the controlling base, authority key and enrollment
ID. Mutations do not retry automatically; callers choose how to observe or
reconcile their retained request. A connected result invalidates peer inventory.
All endpoints retain operator authorization, and HTTP refusals preserve their
status for the host's remedy. These hooks confer no operator or Project grant.

Server proofs and bearers never appear in `PeerEnrollment`. Status distinguishes
pending, connected, denied, expired, unavailable, identity-changed, failed,
outcome-unknown, persistence-failed and cancelled. Connected means the peer
credential was saved, not that a Project checkout, Agent or execution offer is
ready. See [the connection guide](../guides/connections.md#saved-station-addresses)
for the independent Device and peer choices and current trusted-session limits.
