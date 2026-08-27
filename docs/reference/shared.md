# @kontourai/station-shared

Compatibility type re-exports plus explicit helper subpaths. Canonical API/domain ownership now lives in `@kontourai/station-contracts`; `@kontourai/station-shared` root remains for compatibility type exports, while runtime helpers live on dedicated subpaths used across `src-server`, `packages/sdk`, and `packages/cli`.

New code should import stable cross-package types from the owning `@kontourai/station-contracts/*` module directly. The type sections below describe compatibility re-exports that remain available from `shared` while older call sites converge.

If you need a server-only provider interface such as `IBrandingProvider`, `IAuthProvider`, or `ILLMProvider`, do not add it to `shared`. Those belong in the focused `src-server/providers/*` modules instead.

For runtime helpers, use explicit subpaths:
- `@kontourai/station-shared/parsers`
- `@kontourai/station-shared/build`
- `@kontourai/station-shared/git`
- `@kontourai/station-shared/mcp`

---

## plugin types

### `PluginManifest`

Describes a plugin's identity, capabilities, and structure. Read from `plugin.json` at the plugin root.

```ts
interface PluginManifest {
  name: string;
  version: string;
  sdkVersion?: string;
  displayName?: string;
  description?: string;
  entrypoint?: string;
  capabilities?: string[];
  permissions?: string[];
  agents?: Array<{ slug: string; source: string }>;
  layout?: { slug: string; source: string };
  layouts?: Array<{ slug: string; source: string }>;
  providers?: PluginProviderEntry[];
  tools?: { required?: string[] };
  dependencies?: PluginDependency[];
  knowledge?: { namespaces: KnowledgeNamespaceConfig[] };
  skills?: string[];
}

interface PluginProviderEntry {
  type: string;
  module: string;
  layout?: string;
}

interface PluginDependency {
  id: string;
  source?: string;
}
```

### `PluginOverrides` / `PluginOverrideConfig`

Per-plugin runtime overrides (e.g. disabling specific agents).

```ts
interface PluginOverrideConfig {
  disabled?: string[];
}

type PluginOverrides = Record<string, PluginOverrideConfig>;
```

### `PluginPreview` / `PluginComponent` / `ConflictInfo`

Used by the plugin install preview API to report what a plugin would add and any conflicts.

```ts
interface PluginPreview {
  valid: boolean;
  error?: string;
  manifest?: PluginManifest;
  components: PluginComponent[];
  conflicts: ConflictInfo[];
}

interface PluginComponent {
  type: 'agent' | 'workspace' | 'provider' | 'tool';
  id: string;
  detail?: string;
  conflict?: ConflictInfo;
}

interface ConflictInfo {
  type: 'agent' | 'workspace' | 'provider' | 'tool';
  id: string;
  existingSource?: string;
}
```

## agent types

### `AgentSpec`

Full agent configuration loaded from an agent JSON file.

```ts
interface AgentSpec {
  name: string;
  prompt: string;
  description?: string;
  icon?: string;
  model?: string;
  region?: string;
  maxTurns?: number;
  guardrails?: AgentGuardrails;
  streaming?: {
    useNewPipeline?: boolean;
    enableThinking?: boolean;
    debugStreaming?: boolean;
  };
  tools?: AgentTools;
  commands?: Record<string, SlashCommand>;
  ui?: AgentUIConfig;
}

interface AgentGuardrails {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  maxSteps?: number;
}

interface AgentTools {
  mcpServers: string[];
  available?: string[];
  autoApprove?: string[];
}

interface SlashCommand {
  name: string;
  description?: string;
  prompt: string;
  params?: SlashCommandParam[];
}

interface SlashCommandParam {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

interface AgentUIConfig {
  component?: string;
  quickPrompts?: AgentQuickPrompt[];
  workflowShortcuts?: string[];
}

interface AgentQuickPrompt {
  id: string;
  label: string;
  prompt: string;
  agent?: string;
}
```

### `AgentMetadata`

Lightweight agent summary returned by list endpoints.

```ts
interface AgentMetadata {
  slug: string;
  name: string;
  model?: string;
  updatedAt: string;
  description?: string;
  plugin?: string;
  ui?: AgentUIConfig;
  workflowWarnings?: string[];
}
```

---

## tool types

### `ToolDef`

Full tool definition loaded from `tool.json`. Describes how to launch and connect to an MCP server.

```ts
interface ToolDef {
  id: string;
  kind: 'mcp' | 'builtin';
  displayName?: string;
  description?: string;
  transport?: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  endpoint?: string;
  env?: Record<string, string>;
  builtinPolicy?: {
    name:
      | 'station_bash'
      | 'station_file_editor'
      | 'station_http_request'
      | 'station_notebook';
    allowedPaths?: string[];
    timeout?: number;
  };
  permissions?: ToolPermissions;
  timeouts?: { startupMs?: number; requestMs?: number };
  healthCheck?: {
    kind?: 'jsonrpc' | 'http' | 'command';
    path?: string;
    intervalMs?: number;
  };
  exposedTools?: string[];
}

interface ToolPermissions {
  filesystem?: boolean;
  network?: boolean;
  allowedPaths?: string[];
}
```

### `ToolMetadata`

Lightweight tool summary for list endpoints.

```ts
interface ToolMetadata {
  id: string;
  kind: 'mcp' | 'builtin';
  displayName?: string;
  description?: string;
  transport?: string;
  source?: string;
}
```

---

## Layout Types

### `LayoutConfig`

Full layout definition for project-scoped layouts.

```ts
interface LayoutConfig {
  id: string;
  projectSlug: string;
  type: string;
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

### `LayoutDefinition`

File-based layout definition (not project-scoped). Used by plugins.

```ts
interface LayoutDefinition {
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  plugin?: string;
  requiredProviders?: string[];
  availableAgents?: string[];
  defaultAgent?: string;
  tabs: LayoutTab[];
  actions?: LayoutAction[];
}
```

### `LayoutTab`

```ts
interface LayoutTab {
  id: string;
  label: string;
  component: string;
  icon?: string;
  description?: string;
  actions?: LayoutAction[];
  prompts?: LayoutAction[];
}
```

### `LayoutAction`

```ts
interface LayoutAction {
  type: 'prompt' | 'inline-prompt' | 'external' | 'internal';
  label: string;
  icon?: string;
  agent?: string;
  data: string;
}
```

### `LayoutPrompt`

```ts
interface LayoutPrompt {
  id: string;
  label: string;
  prompt: string;
  agent?: string;
}
```

### `LayoutMetadata`

```ts
interface LayoutMetadata {
  id: string;
  slug: string;
  projectSlug: string;
  type: string;
  name: string;
  icon?: string;
  description?: string;
  plugin?: string;
  tabCount?: number;
}
```

### `LayoutDefinitionMetadata`

```ts
interface LayoutDefinitionMetadata {
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  plugin?: string;
  tabCount: number;
}
```

---

## knowledge types

### `KnowledgeNamespaceConfig`

```ts
type KnowledgeNamespaceBehavior = 'rag' | 'inject';

interface KnowledgeNamespaceConfig {
  id: string;
  label: string;
  behavior: KnowledgeNamespaceBehavior;
  description?: string;
  builtIn?: boolean;
  storageDir?: string;
  writeFiles?: boolean;
  syncOnScan?: boolean;
  enhance?: {
    agent: string;
    auto?: boolean;
  };
}
```

### `KnowledgeDocumentMeta`

```ts
interface KnowledgeDocumentMeta {
  id: string;
  filename: string;
  namespace: string;
  source: 'upload' | 'directory-scan';
  chunkCount: number;
  createdAt: string;
  eventId?: string;
  eventSubject?: string;
  enhancedFrom?: string;
  enhancedTo?: string;
  status?: 'raw' | 'enhanced';
}
```

---

## project types

### `ProjectConfig`

```ts
interface ProjectConfig {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  workingDirectory?: string;
  defaultProviderId?: string;
  defaultModel?: string;
  defaultEmbeddingProviderId?: string;
  defaultEmbeddingModel?: string;
  similarityThreshold?: number;
  topK?: number;
  agents?: string[];
  knowledgeNamespaces?: KnowledgeNamespaceConfig[];
  createdAt: string;
  updatedAt: string;
}
```

`agents` is optional by design: `undefined` means the project can use all
known agents, while an explicit empty array means the project exposes no agents.
Stale agent references are surfaced as integrity diagnostics instead of being
silently deleted from project configuration.

### `ProjectMetadata`

```ts
interface ProjectMetadata {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  hasWorkingDirectory: boolean;
  workingDirectory?: string;
  layoutCount: number;
  hasKnowledge: boolean;
  defaultProviderId?: string;
}
```

---

## provider types

### `ProviderConnectionConfig`

```ts
interface ProviderConnectionConfig {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  capabilities: ('llm' | 'embedding' | 'vectordb')[];
}
```

### `LayoutTemplate`

```ts
interface LayoutTemplate {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
}
```

---

## notification types

Re-exported from `@kontourai/station-contracts/notification` for compatibility.

```ts
type NotificationStatus =
  | 'pending'
  | 'delivered'
  | 'dismissed'
  | 'expired'
  | 'actioned';
type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

interface NotificationAction {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

interface Notification {
  id: string;
  source: string;
  category: string;
  title: string;
  body?: string;
  priority: NotificationPriority;
  status: NotificationStatus;
  scheduledAt?: string | null;
  deliveredAt?: string | null;
  ttl?: number;
  actions?: NotificationAction[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

---

## scheduler types

Re-exported from `@kontourai/station-contracts/scheduler` for compatibility.

```ts
interface SchedulerJob {
  target: string;
  schedule: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
}

interface SchedulerLogEntry {
  runAt: string;
  status: 'success' | 'error';
  outputPath?: string;
  error?: string;
}

interface SchedulerEvent {
  type: string;
  target: string;
  timestamp: string;
}

interface SchedulerProviderStats {
  totalJobs: number;
  enabledJobs: number;
  lastRunAt?: string;
}

interface SchedulerProviderStatus {
  running: boolean;
  provider: string;
}
```

---

## build utilities

Constants and helpers for plugin bundling.

### `SHARED_EXTERNALS`

Module names provided by the host app at runtime via `window.__station_ai_shared`.

```ts
const SHARED_EXTERNALS: string[]
// ['react', 'react/jsx-runtime', '@kontourai/station-sdk', '@tanstack/react-query', ...]
```

### `SHARED_EXTERNALS_REGEX`

esbuild filter regex matching all shared externals.

### `RUNTIME_SHIM`

Runtime `require()` shim that maps externals to `window.__station_ai_shared` at runtime. Injected as a banner in plugin bundles.

### `registrationFooter(pluginName: string): string`

Returns JS code that registers plugin exports on `window.__station_ai_plugins`. Injected as a footer in plugin bundles.

---

## app config

### `AppConfig`

Top-level application configuration (`app.json`).

```ts
interface AppConfig {
  region: string;
  defaultModel: string;
  invokeModel: string;
  structureModel: string;
  runtime?: 'voltagent' | 'strands';
  defaultMaxTurns?: number;
  defaultMaxOutputTokens?: number;
  systemPrompt?: string;
  templateVariables?: TemplateVariable[];
  defaultChatFontSize?: number;
  registryUrl?: string;
  gitRemote?: string;
}

interface TemplateVariable {
  key: string;
  type: 'static' | 'date' | 'time' | 'datetime' | 'custom';
  value?: string;
  format?: string;
}
```

---

## api contracts

`@kontourai/station-shared` re-exports these runtime/session shapes for compatibility, but canonical ownership now lives in `@kontourai/station-contracts/runtime`.

### `ToolCallResponse`

`POST /agents/:slug/tools/:toolName`

```ts
interface ToolCallResponse {
  success: boolean;
  response?: unknown;
  error?: string;
  metadata?: { toolDuration?: number };
}
```

### `AgentInvokeResponse`

`POST /agents/:slug/invoke`

```ts
interface AgentInvokeResponse {
  success: boolean;
  response?: string;
  error?: string;
  toolCalls?: Array<{ name: string; arguments: unknown; result?: unknown }>;
}
```

---

## session / memory types

```ts
interface WorkflowMetadata {
  id: string;
  label: string;
  filename?: string;
  lastModified?: string;
}

interface SessionMetadata {
  sessionId: string;
  lastTs: string;
  sizeBytes?: number;
}

interface MemoryEvent {
  ts: string;
  sessionId: string;
  actor: 'USER' | 'ASSISTANT' | 'TOOL';
  content: string;
  meta?: Record<string, unknown>;
}

interface ConversationStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  toolCalls: number;
  estimatedCost: number;
}

enum AgentSwitchState {
  IDLE = 'IDLE',
  WAITING = 'WAITING',
  TEARDOWN = 'TEARDOWN',
  BUILD = 'BUILD',
  READY = 'READY',
}
```

---

## provider interfaces

Contracts that plugins implement to provide auth, user identity, registry, and prerequisite checking.

```ts
interface RegistryItem {
  id: string;
  displayName?: string;
  description?: string;
  version?: string;
  status?: string;
  installed: boolean;
}

interface InstallResult { success: boolean; message: string; }

interface AuthStatus {
  provider: string;
  status: 'valid' | 'expiring' | 'expired' | 'missing' | 'not-configured';
  expiresAt: string | null;
  message: string;
}

interface RenewResult { success: boolean; message: string; }

interface UserIdentity {
  alias: string;
  name?: string;
  title?: string;
  email?: string;
  profileUrl?: string;
}

interface UserDetailVM {
  alias: string;
  name: string;
  title?: string;
  team?: string;
  manager?: { alias: string; name?: string };
  email?: string;
  location?: string;
  avatarUrl?: string;
  profileUrl?: string;
  badges?: string[];
  tenure?: string;
  directReports?: number;
  extra?: Record<string, unknown>;
}

interface Prerequisite {
  id: string;
  name: string;
  description: string;
  status: 'installed' | 'missing' | 'error';
  category: 'required' | 'optional';
  source?: string;
  installGuide?: {
    steps: string[];
    commands?: string[];
    links?: string[];
  };
}
```

`not-configured` means Station has no authentication provider. It is an
expected explicit state, not a successful authentication verdict.

---

## utility functions

### `readPluginManifest(dir: string): PluginManifest`

Reads and parses `plugin.json` from the given directory. Throws if the file does not exist.

```ts
import { readPluginManifest } from '@kontourai/station-shared/parsers';

const manifest = readPluginManifest('/path/to/my-plugin');
console.log(manifest.name, manifest.version);
```

### `readIntegrationDef(toolsDir: string, id: string): ToolDef`

Reads `<toolsDir>/<id>/integration.json`. Throws if not found.

```ts
const tool = readIntegrationDef('/project/.station/integrations', 'my-mcp-server');
```

### `readAgentSpec(path: string): AgentSpec`

Reads an agent JSON file at the given path.

### `readLayoutConfig(path: string): LayoutConfig`

Reads a layout JSON file at the given path.

### `resolvePluginIntegrations(pluginDir: string, toolsDir: string): Map<string, ToolDef>`

Walks all agents declared in a plugin's manifest, collects their `mcpServers` references, and returns a map of `toolId → ToolDef` by reading from `toolsDir`. Silently skips missing integration definitions.

```ts
const tools = resolvePluginIntegrations('/path/to/plugin', '/project/.station/integrations');
for (const [id, def] of tools) {
  console.log(id, def.transport);
}
```

### `listIntegrationIds(toolsDir: string): string[]`

Returns the IDs of all integrations in a directory (subdirectories that contain an `integration.json`). Returns `[]` if the directory does not exist.

```ts
const ids = listIntegrationIds('/project/.station/integrations');
// ['my-mcp-server', 'another-tool']
```

### `copyPluginIntegrations(pluginDir: string, projectIntegrationsDir: string): string[]`

Copies integration configs from `<pluginDir>/integrations/` into `projectIntegrationsDir`. Skips integrations that already exist. Returns the list of copied integration IDs.

```ts
const copied = copyPluginIntegrations('/path/to/plugin', '/project/.station/integrations');
console.log('installed integrations:', copied);
```

### `resolveGitInfo(hint?: string)`

Resolves git metadata (root, branch, short hash, remote) from the current working directory or an optional hint path. Falls back through `process.argv` for bundled server environments.

```ts
const { gitRoot, branch, hash, remote } = resolveGitInfo();
// { gitRoot: '~/dev/...', branch: 'main', hash: 'a1b2c3d', remote: 'git@...' }
```

Throws if not inside a git repository.

### `buildPlugin(pluginDir: string, mode?: 'production' | 'dev'): Promise<BuildResult>`

Builds a plugin. Workspace plugins (with entrypoint) use esbuild JS API directly. Provider-only plugins fall back to `build.mjs` / `build.sh` / `npm run build`. Installs npm dependencies first and symlinks `@kontourai/station-shared` as a peer.

```ts
interface BuildResult {
  built: boolean;
  bundlePath?: string;
  cssPath?: string;
}
```

```ts
const result = await buildPlugin('/path/to/plugin');
if (result.built) console.log('bundle at', result.bundlePath);
```

---

## mcp helpers

Located in `@kontourai/station-shared/mcp` (re-exported from the package root).

### types

```ts
interface MCPToolInfo {
  name: string;         // prefixed: "{serverId}_{toolName}"
  originalName: string; // raw name from MCP server
  serverId: string;
  description?: string;
  inputSchema?: any;
}

interface MCPConnection {
  client: Client;       // @modelcontextprotocol/sdk Client
  serverId: string;
  tools: MCPToolInfo[];
  close: () => Promise<void>;
}

interface MCPManagerOptions {
  onStatus?: (serverId: string, status: 'connected' | 'failed', error?: string) => void;
}
```

### `connectMCP(def: ToolDef, opts?: MCPManagerOptions): Promise<MCPConnection>`

Creates and connects an MCP client from a `ToolDef`. Supports `stdio`, `sse`, and `streamable-http` transports. Discovers available tools on connect.

```ts
import { connectMCP } from '@kontourai/station-shared/mcp';
```

```ts
import { connectMCP } from '@kontourai/station-shared/mcp';

const conn = await connectMCP({
  id: 'my-server',
  kind: 'mcp',
  transport: 'stdio',
  command: 'node',
  args: ['./server.js'],
});

console.log(conn.tools.map((t) => t.name));
await conn.close();
```

### `callTool(conn: MCPConnection, toolName: string, args?: Record<string, unknown>): Promise<any>`

Calls a tool on an existing connection. Accepts both prefixed (`"server_tool"`) and raw (`"tool"`) names.

```ts
const result = await callTool(conn, 'my-server_list_files', { path: '/tmp' });
```

### `MCPManager`

Manages a pool of MCP connections for multiple tool definitions.

```ts
const manager = new MCPManager({
  onStatus: (id, status, err) => console.log(id, status, err),
});

await manager.connectAll(toolDefs);

// list all tools across all connections
const tools = manager.listTools();

// call a tool by prefixed name
const result = await manager.callTool('my-server_list_files', { path: '/tmp' });

// get a specific connection
const conn = manager.getConnection('my-server');

// shut everything down
await manager.closeAll();
```

**methods**

| method | description |
|---|---|
| `connectAll(defs: ToolDef[]): Promise<void>` | Connects to all `kind: 'mcp'` defs. Failures are reported via `onStatus`, not thrown. |
| `listTools(): MCPToolInfo[]` | Returns all tools across all active connections. |
| `callTool(prefixedName: string, args?): Promise<any>` | Routes a call to the owning connection. Throws if tool not found. |
| `getConnection(serverId: string): MCPConnection \| undefined` | Returns the connection for a specific server. |
| `closeAll(): Promise<void>` | Closes all connections and clears the pool. |

**transport selection**

| `transport` value | requirement |
|---|---|
| `stdio` | `command` required |
| `sse` | `endpoint` required |
| `streamable-http` | `endpoint` required |
| `process` (legacy) | treated as `stdio` |
| omitted | inferred as `stdio` if `command` is set |
