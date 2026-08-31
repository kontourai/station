import type { AgentExecutionConfig } from '@kontourai/station-contracts/agent';
import type { EngineId } from '@kontourai/station-contracts/provider';
import {
  type AgentConnectionView,
  type ConnectionConfig,
  type ConnectionReadinessEvidence,
  EXECUTION_MODE,
  type ExecutionMode,
  type ModelOption,
  type RuntimeCatalogSource,
} from '@kontourai/station-contracts/tool';
import { modelDisplayLabel } from './modelCapabilities';
/**
 * What kind of thing a connection is, in a name somebody chose.
 *
 * Every `type` Station itself ships is listed. `muse` was not, so an
 * engine Station ships rendered as its raw slug on /connections/engines
 * (archive#3739); `lancedb` was not, so the built-in vector store rendered as
 * an implementation name that ADR-0009 already retired. A slug is a name
 * nobody chose, so prefer {@link connectionDisplayLabel} wherever the
 * connection RECORD is in hand — it carries the name its owner gave it.
 *
 * Deliberately a literal map rather than a read of
 * `ENGINE_CAPABILITY_MATRICES[...].displayName`: that table is data-heavy and
 * currently lands in a lazy chunk, and this module is eagerly loaded by the
 * shell. Its `station-runtime-types` test pins the two lists together instead.
 */
export function connectionTypeLabel(type: string): string {
  switch (type) {
    case 'bedrock':
      return 'Amazon Bedrock';
    case 'ollama':
      return 'Ollama';
    case 'openai-compat':
      return 'OpenAI-Compatible';
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Google';
    case 'lancedb':
      return 'Built-in vector store';
    case 'bedrock-runtime':
      return 'Amazon Bedrock';
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'muse':
      return 'Muse Code';
    case 'ollama-runtime':
      return 'Ollama';
    case 'acp':
      return 'Custom engine';
    default:
      return type;
  }
}

/**
 * A connection named the way its owner named it: the server's own provider
 * label, else the connection's name, and only then the type. Every UI surface
 * holding a connection record should use this — the record always carries a
 * `name`, so none of them has any reason to re-derive one from a slug.
 */
export function connectionDisplayLabel(
  connection: Pick<ConnectionConfig, 'name' | 'type' | 'config'>,
): string {
  const providerLabel = connection.config?.providerLabel;
  if (typeof providerLabel === 'string' && providerLabel.trim()) {
    return providerLabel;
  }
  return connection.name?.trim() || connectionTypeLabel(connection.type);
}

export function resolveModelProviderLabel({
  executionMode,
  providerConnectionName,
  runtimeConnectionName,
  provider,
  agentName,
}: {
  executionMode?: ExecutionMode;
  providerConnectionName?: string;
  runtimeConnectionName?: string;
  provider?: EngineId;
  agentName?: string;
}): string | undefined {
  const persistedProviderLabel = provider
    ? connectionTypeLabel(provider)
    : undefined;
  return executionMode === EXECUTION_MODE.STATION
    ? (providerConnectionName ??
        persistedProviderLabel ??
        runtimeConnectionName ??
        agentName)
    : (runtimeConnectionName ?? persistedProviderLabel ?? agentName);
}

export function connectionStatusLabel(status: string): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'degraded':
      return 'Degraded';
    case 'missing_prerequisites':
      return 'Setup required';
    case 'disabled':
      return 'Disabled';
    case 'error':
      return 'Error';
    case 'awaiting-approval':
      return 'Awaiting approval';
    default:
      return (
        status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
      );
  }
}

export function connectionEvidenceLabel(
  evidence?: ConnectionReadinessEvidence,
): string {
  if (!evidence) return 'Evidence not reported';
  if (
    evidence.smoke.status === 'failed' &&
    evidence.smoke.freshness === 'fresh'
  ) {
    return 'Smoke failed';
  }
  switch (evidence.level) {
    case 'smoke-passed':
      return 'Smoke passed';
    case 'catalog-ready':
      return 'Live catalog';
    case 'prerequisite-ready':
      return 'Prerequisites ready';
    case 'discovered':
      return 'Discovered';
  }
}

export function connectionEvidenceDetail(
  evidence?: ConnectionReadinessEvidence,
): string {
  if (!evidence) {
    return 'Station has not reported readiness evidence for this connection.';
  }
  return [evidence.summary, evidence.action].filter(Boolean).join(' ');
}

export function prerequisiteStatusLabel(status: string): string {
  switch (status) {
    case 'installed':
      return 'Installed';
    case 'missing':
      return 'Not found';
    case 'warning':
      return 'Check required';
    default:
      return status;
  }
}

export function prerequisiteCategoryLabel(category: string): string {
  switch (category) {
    case 'required':
      return 'Required';
    case 'optional':
      return 'Optional';
    default:
      return category;
  }
}

export function capabilityLabel(capability: string): string {
  const map: Record<string, string> = {
    llm: 'Language model',
    embedding: 'Embeddings',
    'agent-runtime': 'Agent execution',
    'session-lifecycle': 'Session lifecycle',
    'tool-calls': 'Tool calls',
    interrupt: 'Interrupt',
    approvals: 'Approvals',
    resume: 'Resume',
    'reasoning-events': 'Reasoning',
    'external-process': 'External process',
    acp: 'Custom engines',
    vectordb: 'Vector database',
    steering: 'Mid-turn steering',
  };
  // Validated, not defaulted. `capability` comes from a plugin manifest's
  // `capabilities` array, and a plain object literal answers Object's
  // inherited keys -- `map['__proto__']` is `Object.prototype`, which is
  // truthy, so `??` never fires. This value is rendered directly as a React
  // child (`AgentConnectionView`), and a non-string child throws "Objects are
  // not valid as a React child", crashing the view.
  //
  // Same defect and same guard as `describePermission`; the reference
  // implementation for this class in this repo is `grants-file-store.ts`,
  // which hands out null-prototype objects and rejects these keys outright.
  const label = map[capability];
  return typeof label === 'string' ? label : capability.replace(/-/g, ' ');
}

type AgentWithExecution = {
  slug?: string;
  name?: string;
  description?: string;
  execution?: AgentExecutionConfig;
  model?: string;
  toolsConfig?: {
    mcpServers?: string[];
  };
  /**
   * The backing connection's adapter type (archive#954), e.g. 'acp' —
   * `resolveAgentExecution` uses it to route a promoted ACP default through
   * the `acp` provider rather than treating the connection id as an engine id.
   */
  engineConnectionType?: string;
};

type ChatBindingState = {
  executionMode?: ExecutionMode;
  agentConnectionId?: string | null;
  provider?: EngineId | null;
  providerId?: string | null;
  orchestrationProvider?: EngineId | null;
  model?: string | null;
};

export type SharedCapability =
  | 'system_prompt'
  | 'mcp'
  | 'tool_execution'
  | 'model_catalog'
  | 'model_selection';

export type EffectiveCapabilityState = Record<SharedCapability, boolean>;

export type BindingReadiness = 'ready' | 'degraded' | 'needs_configuration';

export type BindingStatus = {
  catalogSource: RuntimeCatalogSource;
  catalogReason?: string | null;
  bindingReadiness: BindingReadiness;
  capabilityState: EffectiveCapabilityState;
  visibleModels: ModelOption[];
};

export type ChatExecutionMetadata = {
  executionMode: ExecutionMode;
  executionScope?: 'project' | 'global';
  agentConnectionId?: string;
  provider?: EngineId;
  providerId?: string;
  defaultProviderId?: string;
  model?: string;
  modelSource?: EffectiveModelSource;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  providerOptions: Record<string, unknown>;
};

export type EffectiveModelSource =
  | 'session override'
  | 'last chosen'
  | 'project default'
  | 'runtime'
  | 'agent default'
  | 'connection default'
  | 'first available'
  | 'unknown';

/**
 * User-facing label for an `EffectiveModelSource`. The internal identifier
 * 'runtime' means "reported by the connected Agent app" — glossary
 * vocabulary bans the word "runtime" from user-facing strings
 * (docs/glossary.md), so this is the one place that value gets rendered.
 */
export function modelSourceLabel(source: EffectiveModelSource): string {
  switch (source) {
    case 'runtime':
      return 'reported by app';
    case 'unknown':
      return '';
    default:
      return source;
  }
}

export type EffectiveModel = {
  id: string | null;
  label: string;
  source: EffectiveModelSource;
  catalogSource: RuntimeCatalogSource;
  mode: string | null;
  selectableModels: ModelOption[];
};

export function resolveEffectiveModel({
  agent,
  runtimeConnection,
  runtimeCurrentModel,
  runtimeCurrentMode,
  projectDefaultModel,
  sessionOverride,
  lastChosenModel,
}: {
  agent?: AgentWithExecution | null;
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null;
  runtimeCurrentModel?: string | null;
  runtimeCurrentMode?: string | null;
  projectDefaultModel?: string | null;
  sessionOverride?: string | null;
  /**
   * The user's most-recently-chosen model for this agent app connection
   * (see src-ui/src/hooks/lastChosenModel.ts). Beats the app-reported
   * current model and the project default, but loses to an explicit
   * session override. Only trusted when it is still present in
   * selectableModels (when that catalog is known) — otherwise ignored.
   */
  lastChosenModel?: string | null;
}): EffectiveModel {
  const catalog = (runtimeConnection as AgentConnectionView | null)
    ?.runtimeCatalog;
  const selectableModels = runtimeCatalogVisibleModels(runtimeConnection);
  const connectionDefault =
    typeof runtimeConnection?.config.defaultModel === 'string'
      ? runtimeConnection.config.defaultModel
      : null;
  const validLastChosenModel =
    lastChosenModel &&
    (selectableModels.length === 0 ||
      selectableModels.some(
        (model) =>
          model.id === lastChosenModel || model.originalId === lastChosenModel,
      ))
      ? lastChosenModel
      : null;
  const candidates: Array<[string | null | undefined, EffectiveModelSource]> = [
    [sessionOverride, 'session override'],
    [validLastChosenModel, 'last chosen'],
    [runtimeCurrentModel, 'runtime'],
    [projectDefaultModel, 'project default'],
    [agent?.model ?? agent?.execution?.modelId, 'agent default'],
    [connectionDefault, 'connection default'],
  ];
  const [id, source] = candidates.find(
    ([candidate]) => !!candidate?.trim(),
  ) ?? [null, 'unknown'];
  return {
    id: id || null,
    // archive#3391: one derivation of an id's display name, shared with Home's
    // work items and the model picker. Was `known?.name || id`, which printed
    // the raw id whenever the catalog did not know it.
    label: modelDisplayLabel(id, selectableModels),
    source,
    catalogSource: catalog?.source ?? 'none',
    mode: runtimeCurrentMode || null,
    selectableModels,
  };
}

/**
 * The New Chat flow (HomeView's quick-start identity, the New Chat modal's
 * default agent, and the session a click actually starts) must never show
 * or start with an unset model for an agent app that has a concrete model
 * catalog — resolveEffectiveModel itself stays honest about "unknown" for
 * other consumers (e.g. reporting a session's live/current model), so this
 * fallback lives in a thin wrapper applied only at those New Chat call
 * sites rather than inside the shared resolver.
 */
export function guaranteeConcreteModel(model: EffectiveModel): EffectiveModel {
  if (model.id || model.selectableModels.length === 0) {
    return model;
  }
  const first = model.selectableModels[0];
  return {
    ...model,
    id: first.id,
    label: modelDisplayLabel(first.id, model.selectableModels),
    source: 'first available',
  };
}

function asModelOptions(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: entry.id,
        name: entry.name,
        originalId:
          typeof entry.originalId === 'string' ? entry.originalId : entry.id,
        ...(entry.capabilities && typeof entry.capabilities === 'object'
          ? { capabilities: entry.capabilities as ModelOption['capabilities'] }
          : {}),
      },
    ];
  });
}

export function runtimeCatalogVisibleModels(
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null,
): ModelOption[] {
  const runtimeCatalog = (runtimeConnection as AgentConnectionView | null)
    ?.runtimeCatalog;
  if (!runtimeCatalog) {
    return asModelOptions(runtimeConnection?.config.modelOptions);
  }
  // A connection's catalog may omit models/builtInModels entirely — guard so a
  // partial catalog doesn't crash callers that render a model picker from it.
  if (runtimeCatalog.models?.length) {
    return runtimeCatalog.models;
  }
  if (runtimeCatalog.builtInModels?.length) {
    return runtimeCatalog.builtInModels;
  }
  return asModelOptions(runtimeConnection?.config.modelOptions);
}

/**
 * archive#1003: reads a connection's canonical engine identity
 * (`config.engineId`) with a `config.executionClass` read-compat fallback
 * (`'managed'` -> `'station'`, `'connected'`/`'external'` -> `'external'`)
 * so hand-built test-double connection views (still constructing the legacy
 * field) keep resolving correctly.
 */
export function connectionEngineId(
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null,
): string | undefined {
  const engineId = runtimeConnection?.config.engineId;
  if (typeof engineId === 'string') return engineId;
  const executionClass = runtimeConnection?.config.executionClass;
  if (executionClass === 'managed') return 'station';
  if (executionClass === 'connected' || executionClass === 'external') {
    return 'external';
  }
  if (runtimeConnection?.id === 'acp' || runtimeConnection?.type === 'acp') {
    return 'acp';
  }
  return undefined;
}

/**
 * The catalogue fact as a phrase, for surfaces that read it out loud.
 *
 * `runtimeCatalogSourceLabel` is the VALUE for a field labelled "Catalog";
 * pasted into a sentence it produced "None catalog", which is the enum read
 * aloud rather than the thing being said (archive#3739).
 */
export function runtimeCatalogSourceSentence(
  source: RuntimeCatalogSource,
): string {
  switch (source) {
    case 'live':
      return 'Live model catalog';
    case 'cached':
      return 'Cached model catalog';
    case 'built-in':
      return 'Built-in model catalog';
    case 'none':
      return 'No model catalog';
    default:
      return 'No model catalog';
  }
}

export function runtimeCatalogSourceLabel(
  source: RuntimeCatalogSource,
): string {
  switch (source) {
    case 'live':
      return 'Live';
    case 'cached':
      return 'Cached';
    case 'built-in':
      return 'Built-in';
    case 'none':
      return 'None';
    default:
      return source;
  }
}

function bindingReadinessForConnection(
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null,
): BindingReadiness {
  if (!runtimeConnection) {
    return 'needs_configuration';
  }
  if (
    runtimeConnection.status === 'missing_prerequisites' ||
    runtimeConnection.status === 'disabled' ||
    runtimeConnection.status === 'error'
  ) {
    return 'needs_configuration';
  }
  if (runtimeConnection.status === 'degraded') {
    return 'degraded';
  }
  return 'ready';
}

export function supportsProviderManagedBinding(
  agent: AgentWithExecution | null | undefined,
  agentConnections: ConnectionConfig[] = [],
): boolean {
  if (!agent) return false;
  // An agent explicitly bound to a connected/external runtime isn't managed.
  const boundId = agent.execution?.agentConnectionId;
  if (boundId) {
    const engineId = connectionEngineId(
      agentConnections.find((connection) => connection.id === boundId),
    );
    if (engineId && engineId !== 'station') return false;
  }
  // Managed agents run on Station's engine + a Model connection — tools are fine.
  return true;
}

export function resolveBindingStatus({
  agent,
  chatState,
  runtimeConnection,
  globalModels = [],
}: {
  agent:
    | (AgentWithExecution & { modelOptions?: Array<unknown> | null })
    | null
    | undefined;
  chatState?: ChatBindingState | null;
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null;
  globalModels?: ModelOption[];
}): BindingStatus {
  const agentConnectionId =
    chatState?.agentConnectionId ?? agent?.execution?.agentConnectionId ?? null;
  const activeProvider =
    chatState?.orchestrationProvider ??
    chatState?.provider ??
    (agentConnectionId || undefined);
  const engineId = connectionEngineId(runtimeConnection);
  const agentModels = asModelOptions(agent?.modelOptions);
  const runtimeModels = runtimeCatalogVisibleModels(runtimeConnection);
  const usesGlobalCatalog =
    chatState?.executionMode !== EXECUTION_MODE.STATION &&
    engineId === 'station';
  const visibleModels =
    agentModels.length > 0
      ? agentModels
      : runtimeModels.length > 0
        ? runtimeModels
        : usesGlobalCatalog
          ? globalModels
          : [];
  const runtimeCatalog = (runtimeConnection as AgentConnectionView | null)
    ?.runtimeCatalog;
  const catalogSource: RuntimeCatalogSource =
    runtimeCatalog?.source ??
    (visibleModels.length > 0 && usesGlobalCatalog ? 'live' : 'none');
  const capabilityState: EffectiveCapabilityState =
    chatState?.executionMode === EXECUTION_MODE.STATION
      ? {
          system_prompt: true,
          mcp: false,
          tool_execution: false,
          model_catalog: visibleModels.length > 0,
          model_selection: visibleModels.length > 0,
        }
      : engineId === 'station'
        ? {
            system_prompt: !!agent,
            mcp: !!agent?.toolsConfig?.mcpServers?.length,
            tool_execution: !!agent?.toolsConfig?.mcpServers?.length,
            model_catalog: visibleModels.length > 0,
            model_selection: visibleModels.length > 0,
          }
        : {
            system_prompt: !!agent || !!activeProvider,
            mcp: false,
            tool_execution: false,
            model_catalog: visibleModels.length > 0,
            model_selection: visibleModels.length > 0,
          };

  return {
    catalogSource,
    catalogReason: runtimeCatalog?.reason ?? null,
    bindingReadiness:
      chatState?.executionMode === EXECUTION_MODE.STATION
        ? 'ready'
        : bindingReadinessForConnection(runtimeConnection),
    capabilityState,
    visibleModels,
  };
}

export function resolveEffectiveCapabilityState({
  agent,
  chatState,
  hasModelCatalog,
  runtimeConnection,
}: {
  agent: AgentWithExecution | null | undefined;
  chatState?: ChatBindingState | null;
  hasModelCatalog: boolean;
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null;
}): EffectiveCapabilityState {
  return resolveBindingStatus({
    agent,
    chatState,
    runtimeConnection,
    globalModels: hasModelCatalog
      ? [{ id: 'catalog', name: 'Catalog', originalId: 'catalog' }]
      : [],
  }).capabilityState;
}

type SessionExecutionSummary = {
  provider?: EngineId | null;
  model?: string | null;
  status?: string | null;
  orchestrationProvider?: EngineId | null;
  orchestrationModel?: string | null;
  orchestrationStatus?: string | null;
};

type SessionExecutionActivity = SessionExecutionSummary & {
  status?: string | null;
};

export function isManagedRuntimeConnectionId(
  agentConnectionId?: string | null,
  agentConnections: ConnectionConfig[] = [],
): boolean {
  // archive#3662: an ABSENT binding is Station's own engine, not "no engine".
  // The one caller uses this to decide whether to offer the Model-connection
  // picker, and a Station-engine Agent is precisely the one that needs it.
  if (!agentConnectionId) {
    return true;
  }
  return (
    connectionEngineId(
      agentConnections.find(
        (connection) => connection.id === agentConnectionId,
      ),
    ) === 'station'
  );
}

/**
 * Whether the session's bound adapter has declared the 'steering'
 * capability — i.e. it accepts a new user message mid-turn and folds it
 * into the current turn instead of waiting for the turn boundary (archive#613).
 * No built-in adapter declares this today, so this always resolves false
 * in production; it exists so the mid-turn send gate has an honest,
 * testable seam to branch on once an adapter can prove real interleaved
 * steering.
 */
export function sessionAdapterSupportsSteering(
  agentConnectionId?: string | null,
  agentConnections: ConnectionConfig[] = [],
): boolean {
  if (!agentConnectionId) {
    return false;
  }
  const connection = agentConnections.find(
    (candidate) => candidate.id === agentConnectionId,
  );
  return !!connection?.capabilities.includes('steering');
}

export function defaultManagedRuntimeConnection(
  agentConnections: ConnectionConfig[],
): ConnectionConfig | null {
  return (
    agentConnections.find(
      (connection) =>
        connection.kind === 'agent' &&
        connection.enabled &&
        connection.type !== 'acp' &&
        connection.capabilities.includes('agent-runtime') &&
        connectionEngineId(connection) === 'station',
    ) ?? null
  );
}

export function defaultSelectableManagedRuntimeConnection(
  agentConnections: ConnectionConfig[],
): ConnectionConfig | null {
  return (
    agentConnections.find(
      (connection) =>
        connection.kind === 'agent' &&
        connection.enabled &&
        connection.type !== 'acp' &&
        connection.capabilities.includes('agent-runtime') &&
        connectionEngineId(connection) === 'station' &&
        isAgentConnectionSelectable(connection),
    ) ?? null
  );
}

export function preferredConnectedRuntime(
  agentConnections: ConnectionConfig[],
): ConnectionConfig | null {
  const connected = agentConnections.filter((connection) => {
    if (
      connection.kind !== 'agent' ||
      !connection.enabled ||
      !connection.capabilities.includes('agent-runtime')
    ) {
      return false;
    }
    // Strict "connected" (native external, non-station, non-acp)
    // parity with the pre-rename executionClass literal — ACP connections
    // have their own separate resolution path, never counted here.
    const engineId = connectionEngineId(connection);
    return (
      engineId !== undefined && engineId !== 'station' && engineId !== 'acp'
    );
  });
  const preferredIds = ['claude', 'codex'];
  for (const id of preferredIds) {
    const match = connected.find((connection) => connection.id === id);
    if (match) return match;
  }
  return connected[0] ?? null;
}

export function agentConnectionLabel(
  agentConnectionId?: string | null,
): string {
  switch (agentConnectionId) {
    case 'bedrock':
      return 'Amazon Bedrock';
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'ollama':
      return 'Ollama';
    case 'acp':
      return 'Custom engine';
    default:
      return connectionTypeLabel(agentConnectionId ?? '');
  }
}

export function executionStatusLabel(status?: string | null): string {
  if (!status) return 'Not started';
  return connectionStatusLabel(status);
}

export function buildProviderOptions(
  agentConnectionId?: string | null,
  runtimeOptions?: Record<string, unknown>,
): Record<string, unknown> {
  if (agentConnectionId === 'claude') {
    return {
      thinking: runtimeOptions?.thinking ?? true,
      effort: runtimeOptions?.effort ?? 'medium',
    };
  }
  if (agentConnectionId === 'codex') {
    return {
      reasoningEffort: runtimeOptions?.reasoningEffort ?? 'medium',
      fastMode: runtimeOptions?.fastMode === true,
    };
  }
  return {};
}

export function resolveAgentExecution(
  agent: AgentWithExecution,
): ChatExecutionMetadata {
  const agentConnectionId = agent.execution?.agentConnectionId || undefined;
  const runtimeOptions = agent.execution?.runtimeOptions ?? {};
  if (runtimeOptions.executionMode === EXECUTION_MODE.STATION) {
    return {
      executionMode: EXECUTION_MODE.STATION,
      executionScope:
        runtimeOptions.executionScope === 'project' ||
        runtimeOptions.executionScope === 'global'
          ? runtimeOptions.executionScope
          : undefined,
      agentConnectionId,
      provider:
        typeof runtimeOptions.providerKind === 'string'
          ? runtimeOptions.providerKind
          : undefined,
      providerId:
        typeof runtimeOptions.providerId === 'string'
          ? runtimeOptions.providerId
          : undefined,
      defaultProviderId:
        typeof runtimeOptions.providerId === 'string'
          ? runtimeOptions.providerId
          : undefined,
      model:
        typeof runtimeOptions.displayModel === 'string'
          ? runtimeOptions.displayModel
          : agent.execution?.modelId || agent.model || undefined,
      modelSource:
        agent.execution?.modelId || agent.model ? 'agent default' : 'unknown',
      providerOptions: {},
    };
  }
  return {
    executionMode: EXECUTION_MODE.EXTERNAL,
    agentConnectionId,
    provider:
      agent.engineConnectionType === 'acp'
        ? 'acp'
        : agentConnectionId || undefined,
    model: agent.execution?.modelId || agent.model || undefined,
    modelSource:
      agent.execution?.modelId || agent.model ? 'agent default' : 'unknown',
    providerOptions: buildProviderOptions(
      agentConnectionId,
      agent.execution?.runtimeOptions,
    ),
  };
}

export function isAgentConnectionSelectable(
  connection?: ConnectionConfig | null,
): boolean {
  if (!connection) return false;
  return (
    connection.kind === 'agent' &&
    connection.enabled &&
    connection.capabilities.includes('agent-runtime') &&
    connection.status === 'ready'
  );
}

/**
 * The DISPATCH question: can a click start a chat on this Agent right now?
 *
 * Deliberately the same two branches the server takes at dispatch
 * (`resolveExecutionTarget`): an Agent bound to an engine connection needs
 * that connection to be selectable this instant; an Agent with NO binding
 * runs on Station's own engine, which is in-process and has no connection to
 * be un-ready — so there is nothing here to refuse it with, and whether its
 * managed model resolves is the server's `available` verdict, checked
 * alongside this one in `selectChatReadyAgents`.
 *
 * archive#3662: absent used to answer `false`, which is how a home whose only
 * Agent is the seeded Station one — `/api/system/status` reporting
 * `configuredChatReady: true`, a model connection tested Ready — still showed
 * "Nothing to chat with yet" in the new-chat picker.
 */
export function canAgentStartChat(
  agent: AgentWithExecution,
  agentConnections: ConnectionConfig[],
): boolean {
  const agentConnectionId = agent.execution?.agentConnectionId;
  if (!agentConnectionId) return true;
  const connection = agentConnections.find(
    (candidate) => candidate.id === agentConnectionId,
  );
  if (connection) return isAgentConnectionSelectable(connection);
  return false;
}

export function resolveProjectProviderManagedExecution(
  project:
    | {
        defaultProviderId?: string | null;
        defaultModel?: string | null;
      }
    | null
    | undefined,
  modelConnections: ConnectionConfig[],
): ChatExecutionMetadata | null {
  return resolveProviderManagedExecution(
    {
      defaultProviderId: project?.defaultProviderId,
      defaultModel: project?.defaultModel,
      executionScope: 'project',
      allowSingleProviderDefault: false,
    },
    modelConnections,
  );
}

export function resolveGlobalProviderManagedExecution(
  appConfig:
    | {
        defaultLLMProvider?: string | null;
        defaultModel?: string | null;
      }
    | null
    | undefined,
  modelConnections: ConnectionConfig[],
): ChatExecutionMetadata | null {
  return resolveProviderManagedExecution(
    {
      defaultProviderId: appConfig?.defaultLLMProvider,
      defaultModel: appConfig?.defaultModel,
      executionScope: 'global',
      allowSingleProviderDefault: true,
    },
    modelConnections,
  );
}

function resolveProviderManagedExecution(
  target: {
    defaultProviderId?: string | null;
    defaultModel?: string | null;
    executionScope?: 'project' | 'global';
    allowSingleProviderDefault: boolean;
  },
  modelConnections: ConnectionConfig[],
): ChatExecutionMetadata | null {
  // archive#3747: `modelConnections` is the LLM-capable inventory; readiness
  // and enablement are the only facts this resolver still has to check.
  const enabledLlmConnections = modelConnections.filter(
    (connection) =>
      connection.kind === 'model' &&
      connection.enabled &&
      connection.status === 'ready',
  );
  const explicitProviderConnection = target.defaultProviderId
    ? enabledLlmConnections.find(
        (connection) => connection.id === target.defaultProviderId,
      )
    : undefined;
  const providerConnection =
    explicitProviderConnection ??
    (target.allowSingleProviderDefault
      ? (enabledLlmConnections[0] ?? null)
      : null);
  if (!providerConnection) {
    return null;
  }
  const providerDefaultModel =
    typeof providerConnection.config.defaultModel === 'string'
      ? providerConnection.config.defaultModel
      : null;
  const providerModelOptions = Array.isArray(
    providerConnection.config.modelOptions,
  )
    ? (providerConnection.config.modelOptions as Array<{ id: string }>)
    : [];
  const targetModelIsSupported =
    !!target.defaultModel &&
    (providerModelOptions.length === 0 ||
      providerModelOptions.some((model) => model.id === target.defaultModel));
  const resolvedModel = targetModelIsSupported
    ? target.defaultModel
    : (providerDefaultModel ?? providerModelOptions[0]?.id ?? null);
  if (!resolvedModel) {
    return null;
  }
  return {
    executionMode: EXECUTION_MODE.STATION,
    executionScope: target.executionScope,
    provider: providerConnection.type,
    providerId: providerConnection.id,
    defaultProviderId: providerConnection.id,
    model: resolvedModel,
    providerOptions: {},
  };
}

export function preferredChatRuntime(
  agentConnections: ConnectionConfig[],
): ConnectionConfig | null {
  const ready = agentConnections.filter(isAgentConnectionSelectable);
  // Strict "connected" parity with the pre-rename executionClass literal —
  // ACP connections are excluded here (they have their own separate
  // resolution path elsewhere); `connected[0]` below is a same-bucket
  // fallback, not a "first non-station" catch-all.
  const connected = ready.filter((connection) => {
    const engineId = connectionEngineId(connection);
    return (
      engineId !== undefined && engineId !== 'station' && engineId !== 'acp'
    );
  });
  const managed = ready.filter(
    (connection) => connectionEngineId(connection) === 'station',
  );
  const preferredIds = ['claude', 'codex'];
  for (const id of preferredIds) {
    const match = connected.find((connection) => connection.id === id);
    if (match) return match;
  }
  return connected[0] ?? managed[0] ?? ready[0] ?? null;
}

export function resolveSessionExecutionSummary(
  session?: SessionExecutionSummary | null,
): {
  provider?: EngineId;
  model?: string;
  status?: string;
} {
  if (!session) return {};
  return {
    provider: session.orchestrationProvider ?? session.provider ?? undefined,
    model: session.orchestrationModel ?? session.model ?? undefined,
    status: session.orchestrationStatus ?? session.status ?? undefined,
  };
}

export function isSessionExecutionActive(
  session?: SessionExecutionActivity | null,
): boolean {
  if (!session) return false;
  // OR the two liveness signals rather than letting a stale
  // `orchestrationStatus` (e.g. 'idle' left over from the previous turn)
  // veto a locally-initiated send. `status === 'sending'` flips the moment
  // the user submits / turn.started lands, so activity indicators appear
  // immediately instead of waiting for the provider's session.state-changed
  // round-trip.
  return (
    session.orchestrationStatus === 'running' ||
    session.orchestrationStatus === 'awaiting-approval' ||
    session.status === 'sending'
  );
}

type TurnStreamActivity = SessionExecutionActivity & {
  orchestrationSessionStarted?: boolean;
  orchestrationTurnOpen?: boolean;
};

/**
 * Whether the transcript's LIVE STREAMING ROW should render for this chat —
 * the "is a turn live" question, distinct from `isSessionExecutionActive`'s
 * coarser "is this session doing anything" (archive#3300).
 *
 * For an orchestration-managed session the canonical answer is the TURN
 * FOLD: `orchestrationTurnOpen` is set by `turn.started`, cleared by every
 * terminal turn event, and reseeded from the snapshot's explicit
 * `hasActiveTurn` (archive#1076) — the same fold the transcript projection uses to
 * suppress a live turn's settled row (`useActiveChatTranscript`). Deriving
 * the streaming row from the session-level flags instead is how a settled
 * turn flashed back to "Working…" after resume: `orchestrationStatus:
 * 'running'` survives a webview reload via sessionStorage while the fold
 * does not, so the flags claimed live work whose settled row the projection
 * was already rendering — one turn, two rows (archive#3300). Reading BOTH surfaces
 * off one fold makes that disagreement unrepresentable.
 *
 * The one window the fold cannot know about yet is the optimistic local
 * send: `status === 'sending'` flips at submit, before the server's
 * `turn.started` arrives, and the shell must appear immediately (archive#1005).
 * `status` is never persisted, so it cannot go stale across a reload the
 * way `orchestrationStatus` did.
 *
 * A session that never started an orchestration session has no turn fold at
 * all; the session-level derivation remains its only honest signal.
 */
export function isTurnStreamLive(session?: TurnStreamActivity | null): boolean {
  if (!session) return false;
  if (session.orchestrationSessionStarted) {
    return (
      session.orchestrationTurnOpen === true || session.status === 'sending'
    );
  }
  return isSessionExecutionActive(session);
}

export function formatExecutionSummary(agent: AgentWithExecution): string {
  const runtime = agentConnectionLabel(agent.execution?.agentConnectionId);
  const model = agent.execution?.modelId || agent.model;
  return model ? `${runtime} · ${model}` : runtime;
}
