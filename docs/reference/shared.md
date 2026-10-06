# @kontourai/station-shared

Compatibility re-exports and runtime helpers. Canonical API/domain ownership
lives in `@kontourai/station-contracts`. The shared root also exports selected
validation, guidance, portability and redaction helpers; it is not a type-only
or universally browser-safe barrel. Prefer each helper's explicit subpath.

New code should import stable cross-package types from the owning `@kontourai/station-contracts/*` module directly. The type sections below describe compatibility re-exports that remain available from `shared` while older call sites converge.

If you need a server-only provider interface such as `IBrandingProvider`, `IAuthProvider`, or `ILLMProvider`, do not add it to `shared`. Those belong in the focused `src-server/providers/*` modules instead.

For runtime helpers, use explicit subpaths:

- `@kontourai/station-shared/parsers`
- `@kontourai/station-shared/build`
- `@kontourai/station-shared/git`
- `@kontourai/station-shared/mcp`
- `@kontourai/station-shared/mcp-tool-selection` — browser-safe original/qualified/runtime MCP identities and selection matching
- `@kontourai/station-shared/thread-usage-tree` — the conversation usage tree fold and the per-engine rules for how a subagent's usage relates to its parent's

The [export map](../../packages/shared/package.json) selects source files, mostly
`.ts` with a few `.mjs` Node leaves, and declares Node 24.x. See the
[package README](../../packages/shared/README.md) for distribution and build
requirements. The type excerpts below are not exhaustive replacements for their
owning declarations; import the canonical type rather than copying an interface.

## Skill experience validation

`@kontourai/station-shared/skill-experience-author` owns
`readValidatedSkillExperiences` and `validateAuthoredSkillExperiences`.
The reader returns typed definitions after closed-schema and bounded,
contained bundled Skill validation; the validation wrapper discards that result.
The author build and installed inventory use the same reader. It does not
activate a package, grant resources, or authorize execution. Installed identity
and current admission remain with the server's package journal/loader. See the
[experience contract](skill-experiences.md) for the exact bounds and refusal path.

## Skill experience authoring

`@kontourai/station-shared/skill-experience-workflow` exports local
`inspectSkillLibrary`, `skillExperiencePackageDigest` and
`readSkillExperienceReview`, `reviewSkillExperiencePackage`, plus the inspection/review types. These Node
filesystem helpers emit bounded source review leads and validate author
assertions against actual package/source/transcript bytes. They do not run a
model, grant tools, install a plugin or establish runtime/release qualification.
Use the [author learning path](../guides/authoring-skill-experiences.md) for
proposal, preview, evaluation and revision review.

## Harness question helpers

`@kontourai/station-shared/harness-questions` owns the browser-safe
`readHarnessQuestionnaire`, `validateHarnessQuestionAnswers` and
`harnessAnswerTexts` helpers. They parse bounded descriptors, validate a
complete answer batch and translate selected IDs to display labels/custom
text. They do not authorize a reply or prove engine delivery. Stable types
come from `@kontourai/station-contracts/harness-questions`.

## Request settlement

`@kontourai/station-shared/request-settlement` owns
[`requestIdsSettledByTurnAbort`](../../packages/shared/src/request-settlement.ts):
given one session's events in order, the ids of the requests their turn's
abort settled without a `request.resolved`. A recovery abort
(`turn.aborted` with `recoveryTerminal`) settles every unresolved request
opened since that turn started and before a different turn started; any
abort, or a
`turn.completed` with `finishReason: 'cancelled'`, settles only the requests
whose `request.opened` names that turn. It reads five fields and accepts
untyped event records. The server's session summary, attention feed and
request inspection apply it, as do the CLI's `approvals` and `operate`; a
client that folds `request.opened` / `request.resolved` itself should too.
The [Session API](session-api.md#respondtorequest) states the behavior.

---

## plugin types

### `PluginManifest`

Describes Station's normalized/legacy plugin shape. An Agent Plugins 1.0 file
stores Station-specific declarations under its owned extension namespace; the
raw portable document is not this interface. The host's format-aware manifest
owner validates and normalizes it; `readPluginManifest` below is only a legacy
JSON reader. See [plugin contracts](../../packages/contracts/src/plugin.ts).

```ts
interface PluginManifest {
  name: string;
  version: string;
  sdkVersion?: string;
  displayName?: string;
  description?: string;
  entrypoint?: string;
  serverModule?: string;
  workspacePanes?: WorkspacePaneDescriptor[];
  workspacePaneHost?: WorkspacePaneHostContributionV1;
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
  version?: string; // exact opaque version, or '*'
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
  type: 'agent' | 'command' | 'layout' | 'pane' | 'provider' | 'tool';
  id: string;
  name?: string; // declared display name, e.g. a Pane's `name`
  detail?: string;
  conflict?: ConflictInfo;
  skippable?: boolean; // false when the package cannot install without it
}

interface ConflictInfo {
  type: 'agent' | 'layout' | 'pane' | 'provider' | 'tool';
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
  project?: string;
  execution?: AgentExecutionConfig;
  delegation?: AgentDelegationPolicy;
  maxSteps?: number;
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
  unattendedAutoApprove?: string[];
  browser?: boolean;
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
  slug: AgentId;
  name: string;
  model?: string;
  updatedAt: string;
  description?: string;
  plugin?: string;
  project?: string;
  execution?: AgentExecutionConfig;
  ui?: AgentUIConfig;
  workflowWarnings?: string[];
}
```

---

## tool types

### `ToolDef`

Tool/integration configuration, ordinarily read from `integration.json` by the
helper below. The excerpt describes transport configuration, not permission to
launch a process or access a network endpoint.

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
  /** #3279: each person connects their own account (see the API reference). */
  credentialOwnership?: { owner: 'principal'; allowInstanceFallback?: boolean };
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
  projectSlug?: string;
  owner?: LayoutOwner;
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
  availableAgents?: AgentId[];
  defaultAgent?: AgentId;
  tabs: LayoutTab[];
  actions?: LayoutAction[];
  globalSkills?: LayoutSkill[];
}
```

### `LayoutTab`

```ts
interface LayoutTab {
  id: string;
  label: string;
  component: string | LayoutComponentRef;
  icon?: string;
  description?: string;
  actions?: LayoutAction[];
  skills?: LayoutAction[];
}
```

### `LayoutAction`

```ts
interface LayoutAction {
  type: 'prompt' | 'inline-prompt' | 'external' | 'internal';
  label: string;
  icon?: string;
  agent?: AgentId;
  data: string;
}
```

### `LayoutSkill`

```ts
interface LayoutSkill {
  id: string;
  label: string;
  prompt: string;
  agent?: AgentId;
}
```

### `LayoutMetadata`

```ts
interface LayoutMetadata {
  id: string;
  slug: string;
  projectSlug?: string;
  owner?: LayoutOwner;
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
  path: string;
  source: 'upload' | 'directory-scan' | 'sync';
  chunkCount: number;
  contentHash?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, any>;
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
  defaultAgent?: AgentId;
  defaultEmbeddingProviderId?: string;
  defaultEmbeddingModel?: string;
  similarityThreshold?: number;
  topK?: number;
  agents?: AgentId[];
  knowledgeNamespaces?: KnowledgeNamespaceConfig[];
  createdAt: string;
  updatedAt: string;
}
```

`defaultAgent` supplies the new-chat choice when there is no remembered Agent
for that Station access and project. The remembered choice takes precedence;
No project has its own remembered choice. Create/update requests accept `null`
to clear `defaultAgent`; stored and read configuration omit the cleared field.

`icon` is either a short glyph (an emoji or symbol of at most 16 UTF-16 code
units, with at least one visible character; no `/`, `\`, `:`, control
character, bidirectional control or unpaired surrogate; and no leading `~`) or
a base64 PNG, JPEG, WebP or ICO `data:` URL whose bytes match its type and
number at most 128 KiB. [`projectIconProblem`](../../packages/contracts/src/project.ts)
is that rule; `POST /api/projects` and `PUT /api/projects/:slug` refuse any
other value with 400, so a path or remote URL is never stored, and
`ProjectService` applies it to a new icon from any other caller. `''` or `null`
in a request clears the icon, and the stored record then omits it. An update
that does not name `icon` leaves the stored one alone, including an older value
the rule now refuses; the UI does not draw such a value.

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
  position?: number;
}
```

### `ProjectRunLocations`

```ts
type ProjectRunLocations = Record<string, ProjectRunsAt>;

type ProjectRunsAt =
  | { kind: 'folder'; path: string }
  | { kind: 'execution-root'; path: string }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'unchecked'; reason: string };
```

`GET /api/projects/run-locations` returns `ProjectRunLocations`: each
Project's `ProjectRunsAt` by slug. It is a separate read from `GET
/api/projects` and `/api/boot`'s `projects` section, which never carry it, so
the Project list never waits on a project folder. The start composer reads it
only while it is open and names the stored folder until it answers. It is for
the operator only: a shared member gets an empty map.

`ProjectRunsAt` is the directory the project resolves to on this Station, from
the records the session start reads: the manifest, its binding, the working
directory and the manifest's `executionRoot`. The identity is not verified: the
start's git identity check is skipped, so a checkout of a different repository
still reads as its directory here, and the start refuses it. It is not where
every chat runs either: a chat in a worktree-isolated project runs in its own
worktree. `none` means the project has no directory, so the agent decides: the
home folder, an ACP connection's folder, or a private folder Station makes.
`unavailable` means a start would be refused (a missing folder or binding, an
execution root outside its checkout), and `reason` says why. `unchecked` means
Station did not find out this time: the folder did not answer within the read's
per-project time limit, or other folders were still being checked. It is not a
refusal. The start composer shows the stored folder as not checked yet and lets
the start resolve it.

The read checks folders asynchronously and answers within that limit even when
a drive does not respond, but a check on a drive that does not respond still
holds one of the server's file-system threads (four by default,
`UV_THREADPOOL_SIZE`) until the drive answers. So Station never has more than
three folder checks out at once, which with the default pool always leaves a
thread for the rest of the server. A check of a folder that is already being
checked joins it, and further checks wait their turn within their project's
limit. A project whose folder never got a turn reads `unchecked` with a reason
that says so. While three folders on drives that do not respond are still being
checked, no other folder gets a turn, so every project with a folder reads
`unchecked` until one of those drives answers.

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
`delivered` is the notification service's record state, not a receipt that a
browser or phone displayed it. For example, an immediate record receives
`deliveredAt` when it is stored, before downstream surface delivery.
Scheduling more than about 24.9 days ahead currently exceeds the service's
native timer range and can leave a pending row without a live wakeup. This
known limit is tracked in [#2810](https://github.com/kontourai/station/issues/2810).

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

The current unified envelope lives at `metadata.envelope`; it adds source,
audience, urgency, target and read/dismiss markers without replacing these
legacy top-level fields. Read it with `readNotificationEnvelope` from
`@kontourai/station-shared/notification-envelope`. Missing, unknown-version or
malformed envelopes return `undefined`. Valid v1 reads ignore unknown keys;
an unknown source or audience kind forces silent presentation, and an unknown
target kind drops that target.

Trusted in-process producers use `parseNotificationEnvelopeForWrite`: exact
keys, known kinds, no unresolved `principal` audience, and no producer-authored
read/dismiss markers. Passing that parser is shape validation, not caller
authorization. The notification service owns the trusted write path and derives
session metadata from the envelope. See the
[parser](../../packages/shared/src/notification-envelope.ts),
[service](../../src-server/services/notifications/notification-service.ts), and
[UI reader](../../src-ui/src/components/notifications/NotificationEnvelopeControls.tsx).

---

## scheduler types

Re-exported from `@kontourai/station-contracts/scheduler` for compatibility.

```ts
interface SchedulerJob {
  name: string;
  provider: string;
  prompt: string;
  cron?: string;
  schedule?: SchedulerSchedule;
  agent?: string;
  enabled: boolean;
  retryCount?: number;
  retryDelaySecs?: number;
  lastRun?: string;
  nextRun?: string;
}

interface SchedulerLogEntry {
  id: string;
  job: string;
  startedAt: string;
  completedAt?: string;
  success: boolean;
  durationSecs?: number;
  output?: string;
  error?: string;
  state?: 'running' | 'completed' | 'failed' | 'indeterminate';
}

interface SchedulerEvent {
  event: 'job.started' | 'job.completed' | 'job.failed' | 'job.retrying'
    | 'job.deferred' | 'job.missed' | 'monitor.observed' | 'monitor.actionable'
    | 'monitor.blocked' | 'monitor.terminal' | 'monitor.restarted' | 'monitor.resolved';
  job: string;
  provider?: string;
  id?: string;
  reason?: 'scheduler_concurrency_limit';
  disposition?: SchedulerDeferralDisposition;
}

interface SchedulerProviderStats {
  jobs: Array<{
    name: string;
    total: number;
    successes: number;
    failures: number;
    success_rate: number;
  }>;
}

interface SchedulerProviderStatus {
  running: boolean;
  jobCount: number;
  lastTickAt?: string | null;
  healthy?: boolean;
}
```

These excerpts omit monitor and additional execution fields. Import
`SchedulerSchedule`, `SchedulerDeferralDisposition` and the complete records
from [the scheduler contract](../../packages/contracts/src/scheduler.ts).
An event shape or a configured job is not evidence that a provider executed it.

---

## build utilities

Constants and helpers for plugin bundling.

### `SHARED_EXTERNALS`

Module names resolved by plugin bundles through `window.__station_ai_shared`.
The [host bridge](../../src-ui/src/core/pluginSharedRuntime.ts) installs React,
React Query and debug eagerly, and loads the remaining namespaces on demand.
[PluginRegistry](../../src-ui/src/core/PluginRegistry.ts) awaits that work before
injecting a bundle. Page-level callers must first await
`window.__station_ai_shared_ready()`; an immediate SDK namespace read after boot
is not guaranteed.

```ts
const SHARED_EXTERNALS: string[]
// ['react', 'react/jsx-runtime', '@kontourai/station-sdk', '@tanstack/react-query', ...]
```

### `SHARED_EXTERNALS_REGEX`

esbuild filter regex matching all shared externals.

### `RUNTIME_SHIM`

Runtime `require()` shim injected as a banner in plugin bundles. It resolves
known externals through the host map; an unknown module logs a warning and
returns an empty object. That fallback does not provide the missing API.

### `registrationFooter(pluginName: string): string`

Returns JS code that registers plugin exports on `window.__station_ai_plugins`. Injected as a footer in plugin bundles.

---

## app config

### `AppConfig`

Top-level application configuration (`app.json`).

```ts
interface AppConfig {
  region?: string;
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

These are legacy compatibility shapes from the
[runtime contract](../../packages/contracts/src/runtime.ts). `SessionMetadata`
and `MemoryEvent` do not describe the canonical orchestration event stream or
its durable Session identity. The required numeric fields in `ConversationStats`
also differ from the current `ConversationStatsResponse`: that API allows
unreported measurements to be absent. Use its parser and measurement provenance
instead of filling missing engine observations with zero. See
[conversation measurements](contracts.md#conversation-measurements).

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

Provider-facing data shapes. These are not the server provider factory or
registration interfaces; those remain at the owning server boundary.

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

`not-configured` is an explicit provider-status value, not a successful request
authentication verdict. These legacy status/display shapes do not establish a
Device grant, deployment account session or Project membership.

---

## utility functions

### `readPluginManifest(dir: string): PluginManifest`

Reads JSON from `plugin.json`. Missing files and invalid JSON throw. This helper
returns a typed cast; it does not validate the schema, normalize Agent Plugins
namespaces, approve code or perform installation admission.

```ts
import { readPluginManifest } from '@kontourai/station-shared/parsers';

const manifest = readPluginManifest('/path/to/my-plugin');
console.log(manifest.name, manifest.version);
```

### `readIntegrationDef(toolsDir: string, id: string): ToolDef`

Reads `<toolsDir>/<id>/integration.json`. Missing files and invalid JSON throw.
Like the other simple readers, this is a typed JSON cast, not schema validation
or a path-containment boundary. Call it only with paths the caller has admitted.

```ts
const tool = readIntegrationDef('/project/.station/integrations', 'my-mcp-server');
```

### `readAgentSpec(path: string): AgentSpec`

Reads and parses an Agent JSON file at the given path; missing or invalid JSON
throws. It does not validate the Agent request schema.

### `readLayoutConfig(path: string): LayoutDefinition`

Reads a file-based layout JSON document. Like the other simple readers, it
parses JSON rather than proving the declared type. It is not a project-owned
`LayoutConfig` record with persisted ownership/timestamps.

### `resolvePluginIntegrations(pluginDir: string, toolsDir: string): Map<string, ToolDef>`

Walks the legacy/root `agents` declaration, collects `mcpServers` references,
and reads a map of `toolId → ToolDef`. Missing Agent files are skipped;
integration read/parse failures are swallowed. Invalid Agent JSON still throws.
An empty result is therefore not proof of a complete valid inventory. It does
not normalize portable manifests. The
[CLI development MCP caller](../../packages/cli/src/dev/mcp.ts) uses this map;
it returns no manager when the map is empty.

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

Copies checked integration trees from `<pluginDir>/integrations/` into the
destination. For copied directories it rejects nested symlinks, nonempty `env`,
`secretEnv` or `storedEnvNames`, invalid executable tokens and an existing target
not owned by this plugin. These are specific checks, not a complete ToolDef
schema validator or a scan for every possible secret field. Nondirectory entries
at the integration root are skipped.
An existing plugin-owned target is replaced using staged rollback handling;
it is not silently skipped. The returned IDs describe copied files, not live
MCP connections or permission grants. Use the host installation path for live
plugin lifecycle and consent.

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

Builds a declared entrypoint with esbuild into `dist/bundle.js`, or
`dist/bundle-dev.js` with inline sourcemaps in dev mode. A missing entrypoint
returns `{ built: false }`; there is no fallback to `build.mjs`, `build.sh` or
arbitrary package scripts. `manifest.build` is refused by this helper.

The [builder](../../packages/shared/src/build.ts) owns containment and dependency
preparation. Managed workspace builds require the managed dependency setup;
standalone plugins use the helper's constrained npm preparation. This can write
dependencies and outputs. Its exact external allowlist includes root SDK and
the SDK agent/client/voice entries, not every SDK subpath. A build does not install,
authorize or activate a plugin. `--dev` in the example build file selects one
build; it is not a watcher.

Portable Agent Plugins can also declare inert visual Skill definitions. The
author builder validates their referenced files and exact bundled Skill identity
before bundling or returning a no-bundle result. See the
[authoring contract](skill-experiences.md) for bounds, refusal diagnostics, and
the separate runtime activation work.

```ts
interface BuildResult {
  built: boolean;
  bundlePath?: string;
  cssPath?: string;
  warnings?: string[];
}
```

```ts
const result = await buildPlugin('/path/to/plugin');
if (result.built) console.log('bundle at', result.bundlePath);
```

---

## mcp helpers

Located in `@kontourai/station-shared/mcp`, not re-exported from the package root.
These low-level Node connection helpers are not Station's installation,
credential-consent or sandbox boundary. Calling them can spawn configured
processes or make network requests; the examples require caller-owned fixtures
or explicitly configured integrations.

The browser-safe `@kontourai/station-shared/mcp-ui-csp` leaf constructs resource
policy separately from these Node transports. It filters URL schemes and emits
directives; that alone is not complete CSP source-expression validation or
browser network-containment proof. See the [MCP host boundary](../design/mcp-ui-host.md#resource-loading-and-policy).

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
  client: Client;       // @modelcontextprotocol/client
  serverId: string;
  tools: MCPToolInfo[];
  negotiation: MCPNegotiation;
  close: () => Promise<void>;
  disconnect: () => Promise<void>;
  isUsable?: () => boolean;
}

interface MCPManagerOptions {
  onStatus?: (serverId: string, status: 'connected' | 'failed', error?: string) => void;
}
```

The options excerpt omits optional transport, authentication-provider and
negotiation callbacks. Import the canonical type from the MCP subpath when
implementing those hooks.

### `connectMCP(def: ToolDef, opts?: MCPManagerOptions): Promise<MCPConnection>`

Creates and connects an MCP client from a normalized `ToolDef`. Supports
`stdio`, `sse`, and `streamable-http` transports. It asks for automatic protocol
negotiation and then calls `listTools` without a cursor. The pinned MCP client
aggregates pages on that path, with its default 64-page bound. Station maps that
response into a connection-local catalog; it does not refresh that stored
`tools` array when the server later changes its catalog.

The `connected` status callback fires after transport connection and before
tool discovery. Discovery can still fail and produce a later `failed` callback;
await the returned connection before using its catalog. `onNegotiated` receives
the SDK's protocol version/era, server capabilities, extension IDs and optional
discovery result, not a guarantee that every advertised capability works.

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

This helper returns the MCP result as supplied by the client. It does not turn
`isError` content into an exception or apply Station's tool permission policy.
Callers must interpret the result and retain their own authorization boundary.

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
| `connectAll(defs: ToolDef[]): Promise<void>` | Attempts all `kind: 'mcp'` defs with `Promise.allSettled`. Completion does not prove every connection succeeded; connection status callbacks and the retained pool must be inspected. |
| `listTools(): MCPToolInfo[]` | Returns all tools across all active connections. |
| `callTool(prefixedName: string, args?): Promise<any>` | Routes a call to the owning connection. Throws if tool not found. |
| `getConnection(serverId: string): MCPConnection \| undefined` | Returns the connection for a specific server. |
| `closeAll(): Promise<void>` | Resets local connection custody and clears the pool only after settlement. Throws a custody error when cleanup has not settled. |

**transport selection**

| `transport` value | requirement |
|---|---|
| `stdio` | `command` required |
| `sse` | `endpoint` required |
| `streamable-http` | `endpoint` required |
| `process` (legacy) | treated as `stdio` |
| omitted | inferred as `stdio` if `command` is set |

Stdio children inherit the host process environment plus the definition's
overrides and optional working directory. Streamable HTTP applies literal
headers only at the configured origin, lets SDK headers take precedence, and
refuses redirects. The SSE constructor receives the OAuth provider but not
`ToolDef.headers`; do not assume the transports have identical header behavior.
These are low-level transport choices, not installation consent.

Owners that need to retain cleanup through partial connection or OAuth failure
use `prepareMCPConnection` and `MCPLocalConnectionCustody`. Retirement fences
new local operations before waiting for existing ones. A pending or failed
close remains owned; a bounded cleanup return does not mean a child process,
its descendants or a remote effect has stopped. The simple CLI development
host uses `MCPManager`, while Station's runtime supplies its own custody owner.
See the [connection factory](../../packages/shared/src/mcp-connection.ts),
[custody owner](../../packages/shared/src/mcp-local-custody.ts),
[CLI caller](../../packages/cli/src/dev/mcp.ts), and
[Station MCP composition](../../src-server/runtime/mcp/mcp-manager.ts).
