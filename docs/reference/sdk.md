# @kontourai/station-sdk

Primary reference for plugin developers. General runtime imports come from
`'@kontourai/station-sdk'`; opt-in voice-session runtime and test helpers use
documented SDK subpaths.

The SDK wraps core app contexts and exposes them through stable React hooks, UI components, typed API functions, and extension registries. Plugins never import from internal app packages directly.

---

## Setup

Plugins are automatically wrapped in `SDKProvider` by the runtime. No manual setup required. For layout plugins, use `LayoutProvider` instead — it also sets the layout context for agent resolution.

```tsx
// Core app wraps your plugin automatically:
<SDKProvider value={sdkContextValue}>
  <YourPlugin />
</SDKProvider>

// Workspace plugins use LayoutProvider:
<LayoutProvider sdk={sdkContextValue} layout={layoutConfig}>
  <YourWorkspacePlugin />
</LayoutProvider>
```

---

## Hooks

All hooks must be called inside a component tree wrapped by `SDKProvider`.

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

#### `useResolveAgent(agentSlug: string): string`

Resolves a short agent name to a fully-qualified slug using the current layout context. Returns the slug unchanged if it already contains `:`.

```tsx
const resolved = useResolveAgent('my-agent'); // → 'sa-agent:my-agent'
```

---

### Layout Hooks

#### `useLayouts(): LayoutConfig[]`

Returns all layouts.

---

### Project Hooks

#### `useProjects(): Project[]`

Returns all projects.

#### `useProject(slug: string): Project | undefined`

Returns a single project by slug.

---

### Conversation Hooks

#### `useConversations(agentSlug?: string): Conversation[]`

Returns conversations, optionally filtered by agent.

#### `useConversation(conversationId: string): Conversation | undefined`

Returns a single conversation.

#### `useConversationMessages(conversationId: string): Message[]`

Returns messages for a conversation.

---

### Chat Hooks

#### `useCreateChatSession(): (agentSlug: string, name: string) => string`

Returns a function that creates a new chat session. Returns the session ID.

```tsx
const createSession = useCreateChatSession();
const sessionId = createSession('my-agent', 'My Agent');
```

#### `useOpenConversation(): (conversationId: string) => string`

Returns a function that opens an existing conversation in the chat dock. Returns the session ID.

#### `useSendMessage(): (sessionId: string, agentSlug: string, conversationId: string | undefined, message: string) => void`

Returns a function to send a message to an active chat session.

#### `useActiveChatActions(sessionId: string)`

Returns actions for a specific chat session (stop, clear, etc.).

#### `useActiveChatState(sessionId: string)`

Returns the current state of a specific chat session (loading, messages, etc.).

#### `useSendToChat(agentSlug: string): (message: string) => void`

Convenience hook. Returns a function that creates a session, opens the dock, and sends a message — all in one call. Resolves short agent names via layout context.

```tsx
const sendToChat = useSendToChat('my-agent');
sendToChat('Summarize this account');
```

---

### Navigation Hooks

#### `useNavigation(): NavigationState & { setDockState, setActiveChat, selectedWorkspace, ... }`

Returns the full navigation state and setters.

#### `useDockState(): { isOpen: boolean; setOpen: (v: boolean) => void; toggle: () => void }`

Convenience wrapper around `useNavigation()` for controlling the chat dock.

```tsx
const { isOpen, toggle } = useDockState();
```

---

### Auth & Config Hooks

#### `useAuth()`

Returns the current auth state.

```ts
{
  status: 'authenticated' | 'unauthenticated' | 'missing';
  user: { id: string; name: string; email: string } | null;
  expiresAt: number | null;
  provider: string;
  renew: () => Promise<void>;
  isRenewing: boolean;
}
```

#### `useConfig(): AppConfig`

Returns the full app configuration.

#### `useApiBase(): string`

Returns the current API base URL.

---

### Connection Hooks

#### `usePairedDevicesQuery(apiBase?: string): PairedDevice[]`

Reads the current inbound paired-device identity registry from
`GET /api/pairing/devices`. Device names are current read-time values; do not
copy them into session or event records. An authorization or response failure
is a query error, not an empty device list.

#### `useConnectionsQuery(): ConnectionConfig[]`

Returns the merged Connections list used by the Connections hub. The result includes both model and runtime rows from `GET /api/connections`.

#### `useModelConnectionsQuery(): ConnectionConfig[]`

Returns model/provider-backed connections from `GET /api/connections/models`.

Use this when you need provider readiness, editable provider config, or provider-scoped `config.modelOptions`.

#### `useRuntimeConnectionsQuery(): ConnectionConfig[]`

Returns runtime connection rows from `GET /api/connections/runtimes`.

Runtime rows can expose runtime-scoped model metadata on `runtimeCatalog`, including:

- `source` — `live`, `cached`, `built-in`, or `none`
- `models` — live or cached catalog entries
- `builtInModels` — Station's bounded built-in entries when live enumeration is unavailable
- `reason`, `fetchedAt`, and `truncated` — catalog status and completeness metadata

This is the query used by runtime/model UI surfaces such as `ConnectionsHub`, `RuntimeConnectionView`, `NewChatModal`, the chat dock model selector, and `AgentEditorRuntimeTab`.

```tsx
const { data: runtimeConnections = [] } = useRuntimeConnectionsQuery();

const codexRuntime = runtimeConnections.find((c) => c.id === 'codex');
const visibleModels =
  codexRuntime?.runtimeCatalog?.models.length
    ? codexRuntime.runtimeCatalog.models
    : (codexRuntime?.runtimeCatalog?.builtInModels ?? []);
```

#### `useContributedModelManifestQuery(): FleetContributionManifest`

Reads `GET /api/connections/model-inventory`, which since station#1398 slice 2 returns the **contributed-subset manifest** (`station.fleet-contribution/v1`) behind the `inference:invoke` pairing scope — not the full `station.model-inventory/v2` launchable inventory it used to return. Renamed from `useLaunchableModelInventoryQuery` deliberately: a silent re-type under the old name would have compiled everywhere while meaning something else. The non-React `fetchContributedModelManifest()` export returns the same body. A client paired with a `read-only`, `standard`, or `delegation` preset now receives 403; re-pair with the `inference` preset. Connection save, delete, health-test, and smoke mutations invalidate the query automatically.

#### `useAgentConnectionQuery(id: EngineConnectionId): AgentConnectionView | null`

Returns a single connection from `GET /api/connections/:id`.

Agent detail views use the branded engine namespace. Model detail views can use `useConnectionQuery(id)` where a generic read is genuinely required.

#### Agent connection mutations

`useSaveAgentConnectionMutation()`, `useDeleteAgentConnectionMutation()`, `useTestAgentConnectionMutation()`, and `useSmokeAgentConnectionMutation()` accept `AgentConnectionView` or `EngineConnectionId`, never an unbranded string.

The writable payload stays on the existing editable fields (`name`, `enabled`, `config`). The read-only `runtimeCatalog` projection should not be treated as user-editable input.

#### Model connection mutations

`useSaveModelConnectionMutation()`, `useDeleteModelConnectionMutation()`, `useTestModelConnectionMutation()`, and `useSmokeModelConnectionMutation()` own the Model connection surface. Keeping these operations separate prevents an engine identity from being accidentally routed through a Model edit path.

---

### Model Hooks

#### `useModels(): Model[]`

Returns all configured models.

#### `useAvailableModels(): Model[]`

Returns models available for the current user/layout.

---

### Knowledge Hooks

#### `useKnowledgeDocs(projectSlug: string, namespace?: string): KnowledgeDoc[]`

Returns knowledge documents for a project, optionally filtered by namespace.

#### `useKnowledgeNamespaces(projectSlug: string): KnowledgeNamespace[]`

Returns knowledge namespaces for a project.

#### `useKnowledgeSearch(projectSlug: string, query: string, namespace?: string): SearchResult[]`

Returns semantic search results from a project's knowledge base.

---

### Notification Hooks

#### `useToast()`

Returns `{ showToast(message, type, duration?) }`. Types: `'info' | 'success' | 'warning' | 'error'`.

#### `useNotifications()`

Higher-level wrapper over `useToast`.

```ts
{ notify: (message: string, options?: { type?, duration? }) => void }
```

```tsx
const { notify } = useNotifications();
notify('Saved!', { type: 'success' });
```

---

### Slash Command Hooks

#### `useSlashCommands(): SlashCommand[]`

Returns all registered slash commands.

#### `useSlashCommandHandler()`

Returns the handler function for processing slash command input.

---

### Tool Approval Hook

#### `useToolApproval()`

Returns the tool approval state and actions (approve/reject pending tool calls).

---

### Stats Hooks

#### `useStats()`

Returns aggregate usage statistics.

#### `useConversationStats(conversationId?: string)`

Returns stats for a specific conversation.

---

### Keyboard Hooks

#### `useKeyboardShortcut(key: string, callback: () => void, deps?: any[]): void`

Registers a keyboard shortcut for the lifetime of the component.

```tsx
useKeyboardShortcut('cmd+k', () => setOpen(true));
```

#### `useKeyboardShortcuts()`

Returns all registered keyboard shortcuts.

---

### Workflow Hooks

#### `useWorkflows(agentSlug?: string): Workflow[]`

Returns workflows, optionally filtered by agent.

#### `useAgentWorkflowsQuery(agentSlug, config?)`

Returns a query whose `data` is the agent's `WorkflowMetadata[]`.

---

### Utility Hooks

#### `useSDK(): { apiBase: string }`

Returns raw SDK context. Prefer specific hooks over this.

#### `useUserLookup(alias: string | null): { data: any; loading: boolean; error: string | null }`

Looks up a user by alias via the user directory. Returns `null` data when alias is `null`.

```tsx
const { data, loading } = useUserLookup('jsmith');
```

#### `useServerFetch(): (url: string, options?) => Promise<{ status, contentType, body }>`

Routes an HTTP request through the backend to avoid CORS. Requires `network.fetch` permission in `plugin.json`.

```tsx
const serverFetch = useServerFetch();
const result = await serverFetch('https://api.example.com/data');
```

---

## Query Hooks

React Query wrappers. Use these instead of raw `useQuery` — they handle cache keys, stale times, and API base resolution automatically.

### `useAgentsQuery(config?)`

Fetches all agents. Cache key: `['agents']`.

### `useAgentToolsQuery(agentSlug: string | undefined, config?)`

Fetches tools for an agent. Disabled when `agentSlug` is undefined.

### `useModelsQuery(config?)`

Fetches available Bedrock models.

### `useModelCapabilitiesEnvelopeQuery(config?)`

Fetches the Bedrock model-capability catalogue with its provenance:
`{ capabilities, source: 'bedrock', complete }`. `complete: false` means the
catalogue could not be read, so `capabilities` is unknown rather than empty.

Available for any consumer that decides whether a model supports something —
the list-only hook below cannot express "not queryable". Nothing reads it yet:
#3344's `useModelImageSupport` answers the per-model question from the list
view, where an unmatched row is already `'unknown'`. This hook is what a
consumer needs to tell an EMPTY catalogue (no AWS credentials, nothing knowable
about any model) from a complete one that genuinely lists no match.

### `useModelCapabilitiesQuery(config?)`

List-only view over `useModelCapabilitiesEnvelopeQuery`, sharing its cache
entry. Cannot express "not queryable".

### `useProjectLayoutsQuery(projectSlug: string, config?)`

Fetches layouts for a project.

### `useProjectLayoutQuery(projectSlug: string, layoutSlug: string, config?)`

Fetches a single project layout.

### `useConversationsQuery(agentSlug: string | undefined, config?)`

Fetches conversations for an agent. Disabled when `agentSlug` is undefined.

### `useConfigQuery(config?)`

Fetches app configuration.

### `useStatsQuery(agentSlug, conversationId, config?)`

Fetches conversation stats. Disabled when either param is undefined.

### `useUsageQuery(config?)`

Fetches usage analytics.

### `useAchievementsQuery(config?)`

Fetches achievement data.

### `useProjectsQuery(config?)`

Fetches all projects.

### `useProjectQuery(slug: string, config?)`

Fetches a single project by slug.

### `useProjectLayoutsQuery(projectSlug: string, config?)`

Fetches layouts for a project.

### `useProjectConversationsQuery(projectSlug: string, limit?, config?)`

Fetches recent conversations for a project. Default limit: 10.

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

Fetches the content of a specific knowledge document. Disabled when `docId` is null.

### `useKnowledgeScanMutation(projectSlug)`

Triggers a directory scan to ingest documents into the knowledge base.

### `useKnowledgeSaveMutation(projectSlug, namespace?)`

Saves/uploads a document to the knowledge base.

### `useKnowledgeDeleteMutation(projectSlug, namespace?)`

Deletes a single knowledge document.

### `useKnowledgeBulkDeleteMutation(projectSlug, namespace?)`

Bulk-deletes knowledge documents.

### `useGitStatusQuery(workingDirectory, config?)`

Fetches git status for a working directory. Disabled when `workingDirectory` is null/undefined.

### `useGitLogQuery(workingDirectory, count?, config?)`

Fetches git log for a working directory. Default count: 5. Disabled when `workingDirectory` is null/undefined.

### `useAcpCommandsQuery(agentSlug, config?)`

Fetches ACP slash commands for an ACP-backed agent. Disabled when `agentSlug` is null/undefined.

### `useModelCapabilitiesEnvelopeQuery(config?)`

Fetches the Bedrock model-capability catalogue with its provenance:
`{ capabilities, source: 'bedrock', complete }`. `complete: false` means the
catalogue could not be read, so `capabilities` is unknown rather than empty.

Available for any consumer that decides whether a model supports something —
the list-only hook below cannot express "not queryable". Nothing reads it yet:
#3344's `useModelImageSupport` answers the per-model question from the list
view, where an unmatched row is already `'unknown'`. This hook is what a
consumer needs to tell an EMPTY catalogue (no AWS credentials, nothing knowable
about any model) from a complete one that genuinely lists no match.

### `useModelCapabilitiesQuery(config?)`

List-only view over `useModelCapabilitiesEnvelopeQuery`, sharing its cache
entry. Cannot express "not queryable".

### `useAgentInvokeMutation(agentSlug: string)`

Fire-and-forget agent invocation mutation. Returns a `useMutation` result.

```tsx
const { mutate } = useAgentInvokeMutation('my-agent');
mutate('Summarize this document');
```

### `useInvokeAgent<T>(agentSlug, content, options?, config?)`

Invokes an agent and caches the result. Cache key: `['invoke', agentSlug, content, options]`.

```tsx
const { data, isLoading } = useInvokeAgent('my-agent', 'Summarize this', { schema: MySchema });
```

### `conversationQueries.list(agentSlug)`

Shared query-factory entry for agent conversation lists. Use this when a feature needs `useQueries` or other query-factory composition without reintroducing inline transport logic.

### `useApiQuery<T>(queryKey, queryFn, config?)`

Generic query hook for custom API calls.

```tsx
const { data } = useApiQuery(['my-key'], () => fetch('/api/custom').then(r => r.json()));
```

### `useApiMutation<TData, TVariables>(mutationFn, options?)`

Mutation hook with optional cache invalidation on success.

```tsx
const mutation = useApiMutation(
  (vars) => fetch('/api/save', { method: 'POST', body: JSON.stringify(vars) }).then(r => r.json()),
  { invalidateKeys: [['agents']] }
);
mutation.mutate({ name: 'new-agent' });
```

### `useInvalidateQuery(): (queryKey) => void`

Returns a function to manually invalidate a query cache entry.

### `useQueryClient`

Re-exported from `@tanstack/react-query` for direct cache access.

---

## API Functions

Imperative API calls — use in event handlers, slash commands, or anywhere hooks aren't available.

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

Sends a message to an agent (non-streaming).

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

Streams a response from an agent.

```ts
interface StreamMessageOptions extends SendMessageOptions {
  onChunk?: (chunk: string) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}
```

```ts
await streamMessage('my-agent', 'Explain this', {
  onChunk: (chunk) => setOutput(prev => prev + chunk),
  onComplete: () => setDone(true),
});
```

### `invokeAgent(agentSlug, content, options?): Promise<any>`

Invokes an agent silently (no user confirmation). Supports structured output via `schema`.

```ts
const result = await invokeAgent('my-agent', 'Extract data', { schema: MyZodSchema });
```

### `invoke(options: InvokeOptions): Promise<any>`

Lightweight multi-turn invocation without a named agent. Supports tool calling and structured output.

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
const result = await invoke({ prompt: 'What is 2+2?', schema: NumberSchema });
```

### `callTool(agentSlug, toolName, toolArgs?): Promise<any>`

Calls an MCP tool directly on an agent. No server-side transform.

```ts
const data = await callTool('my-agent', 'get_account', { id: '123' });
```

### `fetchConfig(): Promise<any>`

Fetches app configuration imperatively.

### `createChatSession(agentSlug: string, name: string): string`

Creates a new chat session and returns the session ID.

### `fetchAvailableLayouts(): Promise<any[]>`

Fetches available layout sources (for adding layouts to projects).

### `fetchProjectConversations(projectSlug: string, limit?: number): Promise<any[]>`

Fetches recent conversations for a project.

### `addProjectLayoutFromPlugin(projectSlug: string, plugin: string): Promise<any>`

Adds a layout from an installed plugin to a project.

### Knowledge API Functions

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

Fetches ACP slash-command definitions for an ACP-backed agent.

#### `fetchAcpCommandOptions(agentSlug: string, partial: string): Promise<AcpSlashCommandDescriptor[]>`

Fetches live ACP slash-command autocomplete options.

---

## Plugin Query Hooks

React Query wrappers for plugin management. Use these instead of raw `useQuery`.

### `usePluginsQuery(config?)`

Fetches all installed plugins. Cache key: `['plugins']`.

### `usePluginUpdatesQuery(config?)`

Checks for available plugin updates. Cache key: `['plugin-updates']`.

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

`consent` is required (station#4288). It is the operator's decision, taken from
the preview they read: the permission set the preview derived, the digest of
the bytes it staged, and the dependency ids it resolved. The server re-derives
all three from its own staged copy and refuses — before writing anything — when
they disagree.

What that does and does not buy: it makes the install a decision about specific
bytes, and it puts the question before the write. It is not an authorization
boundary. The digest is a documented deterministic walk of the tree, so a
caller can compute one without previewing, and every other value is readable
from `POST /api/plugins/preview` — any client holding a Station credential can
assemble a well-formed `consent` with nobody in the loop.

```tsx
const { mutate } = usePluginInstallMutation();
mutate({
  source: 'https://github.com/org/my-plugin.git',
  skip: ['agent:plugin:chat'],
  consent: {
    permissions: preview.permissions.required,
    contentDigest: preview.contentDigest,
    dependencies: preview.dependencies.map((entry) => entry.id),
  },
});
```

### `usePluginPreviewMutation()`

Previews a plugin before installing. Returns manifest, components, conflicts,
resolved dependencies, the derived `permissions` (`required`, `autoGranted`,
`pendingConsent`) and the `contentDigest` of the copy it staged — everything a
consent decision needs, without installing anything.

```tsx
const { mutate } = usePluginPreviewMutation();
mutate('https://github.com/org/my-plugin.git');
```

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

Installs or uninstalls a plugin from the registry.

```tsx
const { mutate } = usePluginRegistryInstallMutation();
mutate({ id: 'my-plugin', action: 'install' });
```

### `useReloadPluginsMutation()`

Triggers `/api/plugins/reload` and invalidates plugin, layout, agent, and project caches.

### `waitForAgentHealth(slug, options?)`

Imperative helper for polling agent readiness during post-install bootstrap flows.

---

## Components

Unstyled (inline styles only) UI primitives that respect the app's CSS variables.

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
  interval={3000}            // ms between phrase changes, default: 3000
  showLogo={true}            // show /favicon.png, default: true
/>
```

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

Button with icon and label for layout action bars.

### `AuthStatusBadge`

Displays the current authentication status as a colored badge.

### `FullScreenError`

Full-viewport error display with message and optional retry action.

### `LayoutHeader`

Standard header component for layout plugins with title, tabs, and actions.

---

## Context Providers

### `SDKProvider`

Injects the SDK context into a plugin tree. Used by the runtime — plugins don't call this directly.

```tsx
<SDKProvider value={sdkContextValue}>
  {children}
</SDKProvider>
```

### `LayoutProvider`

Wraps a layout plugin with SDK context and sets the layout for agent resolution.

```tsx
<LayoutProvider sdk={sdkContextValue} layout={layoutConfig}>
  {children}
</LayoutProvider>
```

### `LayoutNavigationProvider`

Manages per-tab URL hash state for layout plugins with multiple tabs. Persists state to `sessionStorage` and restores it on tab switch.

```tsx
<LayoutNavigationProvider layoutSlug="my-layout" activeTabId={activeTab}>
  {children}
</LayoutNavigationProvider>
```

#### `useLayoutNavigation()`

Must be called inside `LayoutNavigationProvider`.

```ts
{
  getTabState: (tabId: string) => string;
  setTabState: (tabId: string, state: string) => void;
  clearTabState: (tabId: string) => void;
}
```

---

## Agent Resolver

Utilities for working with agent slugs.

### `resolveAgentName(agentName: string, layout?: LayoutConfig): string`

Resolves a short agent name to a fully-qualified `namespace:name` slug using layout context. Returns the name unchanged if it already contains `:` or no match is found.

```ts
resolveAgentName('my-agent'); // → 'sa-agent:my-agent' (if in layout context)
resolveAgentName('sa-agent:my-agent'); // → 'sa-agent:my-agent' (unchanged)
```

### `parseAgentSlug(slug: string): { namespace?: string; name: string }`

Splits a slug into namespace and name.

```ts
parseAgentSlug('sa-agent:my-agent'); // → { namespace: 'sa-agent', name: 'my-agent' }
parseAgentSlug('my-agent');          // → { name: 'my-agent' }
```

### `isLayoutAgent(slug: string): boolean`

Returns `true` if the slug is namespace-qualified.

```ts
isLayoutAgent('sa-agent:my-agent'); // true
isLayoutAgent('my-agent');          // false
```

---

## Voice

Registries and interfaces for STT/TTS providers. Providers register themselves on import; the app subscribes to registry changes.

### `voiceRegistry`

```ts
voiceRegistry.registerSTT(provider: STTProvider): void
voiceRegistry.registerTTS(provider: TTSProvider): void
voiceRegistry.unregisterSTT(id: string): void
voiceRegistry.unregisterTTS(id: string): void
voiceRegistry.getAvailableSTT(): STTProvider[]
voiceRegistry.getAvailableTTS(): TTSProvider[]
voiceRegistry.getSTT(id: string): STTProvider | undefined
voiceRegistry.getTTS(id: string): TTSProvider | undefined
voiceRegistry.subscribe(fn: () => void): () => void  // useSyncExternalStore-compatible
```

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

Shape returned by `GET /api/system/capabilities` for each provider.

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
`{ audio: Uint8Array }`; the adapter serializes it against lifecycle work and
never projects audio bytes into snapshots, results, events, or telemetry.

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
`operation-failed`. Provider causes are not part of the public contract. No selected live adapter
returns `unavailable`; requesting an optional operation that the active adapter
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

The report includes the immutable snapshots observed and typed violations for
capability-method mismatches, identity preservation, required lifecycle
states, snapshot immutability, and monotonic revisions. These helpers have no
UI or server requirement.

---

## Context Registry

For plugins that contribute ambient message context (e.g. timezone, location).

### `contextRegistry`

```ts
contextRegistry.register(provider: MessageContextProvider): void
contextRegistry.unregister(id: string): void
contextRegistry.getAll(): MessageContextProvider[]
contextRegistry.get(id: string): MessageContextProvider | undefined
contextRegistry.getComposedContext(): string | null  // all enabled providers joined by \n
contextRegistry.subscribe(fn: () => void): () => void
```

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

Plugin-defined data providers scoped to a layout (e.g. a CRM data source).

### `registerProvider(id, metadata, factory)`

Registers a provider. Called by layout plugins on load.

```ts
registerProvider('my-crm', { layout: 'sales', type: 'crm' }, () => new MyCRMProvider());
```

### `getProvider<T>(layout, type): T`

Returns the active provider instance for a layout/type pair.

### `hasProvider(layout, type): boolean`

Returns `true` if a provider is configured for the layout/type.

### `getActiveProviderId(layout, type): string | null`

Returns the ID of the active provider.

### `configureProvider(layout, type, providerId)`

Sets the active provider for a layout/type (used by plugins to set defaults).

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

Full REST client for programmatic notification access (outside React components).

```ts
import { NotificationsAPI } from '@kontourai/station-sdk';

const api = new NotificationsAPI(apiBase);
await api.create({ category: 'build', title: 'Build complete', priority: 'normal' });
await api.dismiss(notificationId);
const notifications = await api.list({ status: 'pending' });
```

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
  independent 16-row answer, unassociated, kept-result, and retained Process
  streams. Retained Flow gate evaluations are not answer associations and do
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

`expectedRevision` is compare-and-swap: a `409` means the stored assessment
changed, so read the target again and use its returned revision before deciding
whether to retry. A `404` does not disclose whether the binding, producer access, or assessment is
absent; a `503` means assessment storage is unavailable. The exact wire types
are `StationAnswerAssessmentReadTarget`, `StationAnswerAssessmentPublishInput`,
and `StationAnswerAssessmentReceipt` from
`@kontourai/station-contracts/answer-assessment`.

`ApiRequestScope` contains only `apiBase` and a non-secret `authorityKey`.
The host captures it before invocation from Connect's public request-authority
evidence, including its activation epoch. Native Station additionally qualifies
it with the exact native authorization receipt. Never put credentials in keys.
The host credential resolver must expose matching `requestAuthority` metadata
and its live `isCurrent` check. Scoped operations reject mismatches before
dispatch and after asynchronous response/body reads, including cloned bodies;
they never adopt a replacement connection. Keep also snapshots its invocation
before asynchronous mutation scheduling. A missing scope disables the native
result hooks and rejects Keep rather than choosing an ambient destination.

```ts
import { getSessionToolResult } from '@kontourai/station-sdk/client';

// requestScope is captured by the host, not reconstructed from a URL or title.
const result = await getSessionToolResult(
  requestScope.apiBase, sessionId, eventId, { requestScope, signal },
);
```

Ordinary unscoped SDK calls retain their existing behavior. These protections
are an explicit host contract, not a global replacement for authentication.

### `agentQueries`

Query factory for imperative fetching (e.g. in slash commands). Returns React Query config objects.

```ts
agentQueries.agent(agentSlug)                        // GET /api/agents/:slug
agentQueries.tools(agentSlug)                        // GET /agents/:slug/tools
agentQueries.stats(agentSlug, conversationId)        // GET /agents/:slug/conversations/:id/stats
```

### `knowledgeQueries`

Query factory for knowledge operations.

```ts
knowledgeQueries.list(projectSlug, namespace?)       // GET /api/projects/:slug/knowledge
knowledgeQueries.search(projectSlug, query, ns?)     // POST /api/projects/:slug/knowledge/search
knowledgeQueries.namespaces(projectSlug)             // GET /api/projects/:slug/knowledge/namespaces
```

---

## Telemetry

### `telemetry`

Client-side telemetry utilities for plugins.

```ts
import { telemetry } from '@kontourai/station-sdk';
```

---

## Layout Context

### `createLayoutContext()`

Creates a layout context for use in layout plugins. Used internally by `LayoutProvider`.

---

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

`AgentSpec`, `AgentSummary` (SDK), `AgentMetadata`, `AgentUIConfig`, `AgentGuardrails`, `AgentTools`, `AgentQuickPrompt`, `LayoutConfig`, `LayoutDefinition`, `LayoutTab`, `LayoutAction`, `LayoutPrompt`, `PluginManifest`, `SlashCommand`, `SlashCommandParam`, `ToolDef`, `ToolMetadata`, `ToolPermissions`, `ToolCallResponse`, `ConversationStats`

### SDK-specific types

```ts
interface AgentSummary {
  slug: string;
  name: string;
  prompt?: string;
  model?: string;
  region?: string;
  source?: 'local' | 'acp';
  guardrails?: AgentGuardrails;
  tools?: AgentTools;
  ui?: AgentUIConfig;
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

interface NavigationState {
  currentView: string;
  selectedLayout?: string;
  selectedAgent?: string;
  dockState: boolean;
  dockHeight: number;
  dockMaximized: boolean;
}

interface InvokeOptions {
  conversationId?: string;
  userId?: string;
  model?: string;
  tools?: string[];
  maxSteps?: number;
  signal?: AbortSignal;
}

interface InvokeResult {
  success: boolean;
  output?: string;
  error?: string;
  toolCalls?: any[];
}

interface LayoutComponentProps {
  agent?: AgentSummary;
  layout?: LayoutConfig;
  activeTab?: WorkspaceTab;
  onLaunchPrompt?: (prompt: AgentQuickPrompt) => void;
  onLaunchWorkflow?: (workflowId: string) => void;
  onShowChat?: () => void;
  onRequestAuth?: () => Promise<boolean>;
  onSendToChat?: (text: string, agent?: string) => void;
}

type WorkspaceComponent = (props: LayoutComponentProps) => ReactElement;
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
