import type { AgentExecutionConfig } from '@kontourai/station-contracts/agent';
import {
  type ModelImageSupport,
  UNKNOWN_ENGINE_DURABILITY,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import {
  type EngineId,
  isAcpFamilyEngine,
  type ProviderDurabilityProfile,
} from '@kontourai/station-contracts/provider';
import {
  type AgentConnectionView,
  type ConnectionConfig,
  EXECUTION_MODE,
  type ExecutionMode,
  type ModelOption,
  type RuntimeCatalogSource,
} from '@kontourai/station-contracts/tool';
import {
  type ConversationActivityCarrier,
  serverTurnLive,
  serverWorkLive,
} from './conversation-activity';
import { modelDisplayLabel } from './modelCapabilities';
import { modelProviderDisplayLabel } from './modelProviderDisplay';

/**
 * A connection named the way its owner named it: the server's own provider
 * label, else the connection's name, and only then the type. Every UI surface
 * holding a connection record should use this — the record always carries a
 * `name`, so none of them has any reason to re-derive one from a slug.
 */
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
    ? modelProviderDisplayLabel(provider) !== provider
      ? modelProviderDisplayLabel(provider)
      : (engineDisplayLabel(provider) ?? provider)
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
  executionAgentId?: string;
  executionOnCurrentStation?: boolean;
  expectedDefinitionFingerprint?: string;
  executionMode: ExecutionMode;
  executionScope?: 'project' | 'global';
  agentConnectionId?: string;
  provider?: EngineId;
  providerId?: string;
  defaultProviderId?: string;
  model?: string;
  modelSource?: EffectiveModelSource;
  requestedModel?: string | null;
  requestedModelSource?: EffectiveModelSource;
  requestedProviderOptions?: Record<string, unknown>;
  defaultModel?: string;
  defaultModelSource?: EffectiveModelSource;
  providerOptions: Record<string, unknown>;
};

export type EffectiveModelSource =
  | 'session override'
  | 'project last used'
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
    case 'project last used':
      return 'last used in project';
    case 'unknown':
      return '';
    default:
      return source;
  }
}

/**
 * What a Model reset button names after "Use": the source of the default it
 * restores, in lower case. A source with no user-facing label ('unknown', or
 * none reported) reads "default model", never an empty "Use ".
 */
export function modelResetSourceLabel(
  source?: EffectiveModelSource,
  fallback = 'default model',
): string {
  return (source && modelSourceLabel(source).toLowerCase()) || fallback;
}

export type EffectiveModel = {
  id: string | null;
  label: string;
  source: EffectiveModelSource;
  catalogSource: RuntimeCatalogSource;
  mode: string | null;
  selectableModels: ModelOption[];
  /**
   * The Project's last-used model when it could not be used (no longer in
   * the catalog or not advertised), so a surface can say why the model it
   * shows came from further down the chain. Absent otherwise.
   */
  unavailableProjectLastUsed?: string;
};

export function resolveEffectiveModel({
  agent,
  runtimeConnection,
  runtimeCurrentModel,
  runtimeCurrentMode,
  projectDefaultModel,
  projectLastUsedModel,
  newChat = false,
  sessionOverride,
  lastChosenModel,
  advertisedModels,
}: {
  agent?: AgentWithExecution | null;
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null;
  runtimeCurrentModel?: string | null;
  runtimeCurrentMode?: string | null;
  projectDefaultModel?: string | null;
  /**
   * The model the person's last chat in this Project started with for this
   * Agent, when the Project's model selection is `last-used`
   * (`projectLastUsedModelFor`). Beats every inherited default, loses to a
   * session override, and is used only while the catalog still offers it
   * and the engine advertises it, exactly like `lastChosenModel`.
   */
  projectLastUsedModel?: string | null;
  /**
   * Resolving a NEW chat's starting model. The Project's own default model
   * then beats this device's last pick and the app-reported model, as a set
   * default should, but only when the connection's known catalog offers it:
   * a Project's model is chosen from a Model connection, and an Agent app
   * that does not list it keeps the chain below.
   */
  newChat?: boolean;
  sessionOverride?: string | null;
  /**
   * The user's most-recently-chosen model for this agent app connection
   * (see src-ui/src/hooks/lastChosenModel.ts). Beats the app-reported
   * current model and the project default, but loses to an explicit
   * session override. Only trusted when it is still present in
   * selectableModels (when that catalog is known) — otherwise ignored.
   */
  lastChosenModel?: string | null;
  /**
   * Models an ACP engine advertised itself (its `model` config option), the
   * list the adapter holds a session's requested model to. A default the
   * engine did not advertise is skipped rather than sent for the engine to
   * refuse at session start. Empty or absent means there is nothing to check
   * against. The runtime catalog is deliberately not used for this: it is a
   * different observation (the runtime-reported model may legitimately sit
   * outside it).
   */
  advertisedModels?: ReadonlyArray<{ id: string; originalId?: string }>;
}): EffectiveModel {
  const catalog = (runtimeConnection as AgentConnectionView | null)
    ?.runtimeCatalog;
  const selectableModels = runtimeCatalogVisibleModels(runtimeConnection);
  const connectionDefault =
    typeof runtimeConnection?.config.defaultModel === 'string'
      ? runtimeConnection.config.defaultModel
      : null;
  const inCatalog = (candidate: string) =>
    selectableModels.length === 0 ||
    selectableModels.some(
      (model) => model.id === candidate || model.originalId === candidate,
    );
  const validLastChosenModel =
    lastChosenModel && inCatalog(lastChosenModel) ? lastChosenModel : null;
  // Unknown (nothing advertised) is not "unadvertised": nothing to check.
  const isAdvertised = (candidate: string) =>
    !advertisedModels?.length ||
    advertisedModels.some(
      (model) => model.id === candidate || model.originalId === candidate,
    );
  const projectLastUsed = projectLastUsedModel?.trim() || null;
  const validProjectLastUsed =
    projectLastUsed &&
    inCatalog(projectLastUsed) &&
    isAdvertised(projectLastUsed)
      ? projectLastUsed
      : null;
  const projectDefault = projectDefaultModel?.trim() || null;
  const projectDefaultLeads =
    newChat &&
    !!projectDefault &&
    selectableModels.length > 0 &&
    inCatalog(projectDefault) &&
    isAdvertised(projectDefault);
  const candidates: Array<[string | null | undefined, EffectiveModelSource]> = [
    [sessionOverride, 'session override'],
    [validProjectLastUsed, 'project last used'],
    [projectDefaultLeads ? projectDefault : null, 'project default'],
    [validLastChosenModel, 'last chosen'],
    [runtimeCurrentModel, 'runtime'],
    [projectDefaultModel, 'project default'],
    [agent?.model ?? agent?.execution?.modelId, 'agent default'],
    [connectionDefault, 'connection default'],
  ];
  // An explicit session override is the user's own choice and is checked where
  // it is made; every inherited default must be one the engine advertises.
  const [id, source] = candidates.find(
    ([candidate, candidateSource]) =>
      !!candidate?.trim() &&
      (candidateSource === 'session override' ||
        isAdvertised(candidate.trim())),
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
    ...(projectLastUsed &&
    !validProjectLastUsed &&
    source !== 'session override'
      ? { unavailableProjectLastUsed: projectLastUsed }
      : {}),
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
/**
 * The models an ACP engine advertised, as the server serves them: its model
 * config option when it has one, else the session's `models` list (#352), by
 * the same rule a session start applies. A server too old to send
 * `advertisedModels` (absent, not empty) is read the way it was before:
 * from its config option of category "model".
 */
export function acpAdvertisedModels(
  connection:
    | {
        advertisedModels?: ReadonlyArray<
          Pick<ModelOption, 'id' | 'name' | 'catalogRoute'>
        >;
        configOptions?: ReadonlyArray<{
          category: string;
          options?: Array<string | { value: string; name?: string }>;
        }>;
      }
    | undefined,
): Array<Pick<ModelOption, 'id' | 'name' | 'catalogRoute'>> {
  const served =
    connection?.advertisedModels ??
    (connection?.configOptions ?? [])
      .filter((option) => option.category === 'model')
      .flatMap((option) => option.options ?? [])
      .map((entry) =>
        typeof entry === 'string'
          ? { id: entry, name: entry }
          : { id: entry.value, name: entry.name ?? entry.value },
      );
  return served.filter((model) => model.id.length > 0);
}

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
        ...(typeof entry.resolvedModel === 'string'
          ? { resolvedModel: entry.resolvedModel }
          : {}),
        // Server-decided identity must survive this projection or New Chat and
        // the runtime catalog silently lose grouping (#1208 review).
        ...(entry.canonicalModelIdentity &&
        typeof entry.canonicalModelIdentity === 'object' &&
        typeof entry.canonicalModelIdentity.canonicalId === 'string' &&
        typeof entry.canonicalModelIdentity.verifiedAgainst === 'string'
          ? {
              canonicalModelIdentity:
                entry.canonicalModelIdentity as ModelOption['canonicalModelIdentity'],
            }
          : {}),
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
  // A live answer is authoritative, including an empty one. Falling through
  // to builtInModels here is how a dated snapshot hid later models.
  if (runtimeCatalog.source === 'live') {
    return runtimeCatalog.models ?? [];
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
 * What the connection's own runtime catalog says about `modelId`'s image
 * input. `imageInput: true` is `'yes'`, `false` is `'no'`, and an absent
 * answer (no row, no capability, or a non-boolean) stays `'unknown'`: the
 * runtime not reporting a modality is not a statement that it is missing.
 */
export function catalogModelImageSupport(
  runtimeConnection: AgentConnectionView | ConnectionConfig | null | undefined,
  modelId: string | undefined,
): ModelImageSupport {
  if (!modelId) return 'unknown';
  const imageInput = runtimeCatalogVisibleModels(runtimeConnection).find(
    (model) => model.id === modelId,
  )?.capabilities?.imageInput;
  if (imageInput === true) return 'yes';
  if (imageInput === false) return 'no';
  return 'unknown';
}

/**
 * archive#1003: reads a connection's canonical engine identity
 * (`config.engineId`). Missing identity remains unknown; deprecated metadata
 * is not normalized at read time.
 */
export function connectionEngineId(
  runtimeConnection?: AgentConnectionView | ConnectionConfig | null,
): string | undefined {
  const engineId = runtimeConnection?.config.engineId;
  if (typeof engineId === 'string') return engineId;
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
  // A profile's aliases belong to its configured engine, not an override
  // or a Session still running on a previous connection.
  const agentModels =
    runtimeConnection &&
    runtimeConnection.id !== agent?.execution?.agentConnectionId
      ? []
      : asModelOptions(agent?.modelOptions);
  const runtimeModels = runtimeCatalogVisibleModels(runtimeConnection);
  const usesGlobalCatalog =
    chatState?.executionMode !== EXECUTION_MODE.STATION &&
    engineId === 'station';
  const visibleModels =
    runtimeModels.length > 0
      ? runtimeModels
      : agentModels.length > 0
        ? agentModels
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
} & ConversationActivityCarrier;

/**
 * Whether a running turn can take more user input on the engine's live
 * channel (`steerTurn` / `turn.started` with `inputKind: 'steer'`).
 * Native placement joins the live channel. Engine-defined emulation cancels
 * and continues; Station-owned placement waits for an observed boundary.
 */
export function sessionSteeringPlacement(profile?: ProviderDurabilityProfile) {
  return (profile ?? UNKNOWN_ENGINE_DURABILITY).steerPlacement;
}

export function sessionAdapterSupportsSteering(
  profile?: ProviderDurabilityProfile,
): boolean {
  const placement = sessionSteeringPlacement(profile);
  return (
    placement.state === 'native' ||
    (placement.state === 'emulated' &&
      (placement.boundary === 'station-observed' ||
        placement.boundary === 'engine-defined'))
  );
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

/**
 * WHICH engine connection a chat session is actually running on.
 *
 * One derivation because two surfaces read it for the same session and must
 * not disagree: the composer decides whether to render an approval control
 * from it (`useChatDockViewModel`), and the send path decides whether to put
 * a posture on the wire from it (`useSendMessage`). #2169: the
 * enforcement side read only `chatState.agentConnectionId`, so a chip shown
 * off an OBSERVED binding could sit above a dispatch that carried nothing.
 *
 * A resolved conversation-open observation wins, but only while it describes
 * the session the chat is actually on (`sessionId === currentSessionId`);
 * otherwise the chat's own stored binding, then the Agent record's.
 */
export function resolveSessionEngineConnectionId(input: {
  conversationOpenState?: ConversationOpenResolution | null;
  currentSessionId?: string | null;
  /** `ChatUIState.agentConnectionId`. */
  chatStateConnectionId?: string | null;
  /** `agent.execution.agentConnectionId` for the chat's Agent. */
  agentBoundConnectionId?: string | null;
}): string | null {
  const observed =
    input.conversationOpenState?.status === 'resolved'
      ? input.conversationOpenState.execution
      : undefined;
  if (observed && observed.sessionId === input.currentSessionId) {
    return observed.engineConnectionId ?? null;
  }
  return input.chatStateConnectionId ?? input.agentBoundConnectionId ?? null;
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
    const effort = runtimeOptions?.effort ?? runtimeOptions?.reasoningEffort;
    return {
      ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}),
      ...(runtimeOptions?.serviceTier === undefined &&
      runtimeOptions?.fastMode === true
        ? { fastMode: true }
        : {}),
      ...(runtimeOptions?.serviceTier === null ||
      typeof runtimeOptions?.serviceTier === 'string'
        ? { serviceTier: runtimeOptions.serviceTier }
        : {}),
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
      agent.engineConnectionType ?? agentConnectionId,
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
  /**
   * #4388: the engine this Station chose for its built-in Agent
   * (`AppConfig.builtinAgentEngineConnectionId`). When it is ready it is the
   * runtime named, not whichever of Claude Code or Codex sorts first.
   */
  chosenConnectionId?: string | null,
): ConnectionConfig | null {
  const ready = agentConnections.filter(isAgentConnectionSelectable);
  // Strict "connected" parity with the pre-rename executionClass literal —
  // ACP connections are excluded here (they have their own separate
  // resolution path elsewhere); `connected[0]` below is a same-bucket
  // fallback, not a "first non-station" catch-all.
  // An OpenCode connection projects the engine id `opencode` while its
  // Feature Preview is on, but it is still a saved ACP connection
  // (`isAcpFamilyEngine`), so it stays out of this bucket too.
  const connected = ready.filter((connection) => {
    const engineId = connectionEngineId(connection);
    return (
      engineId !== undefined &&
      engineId !== 'station' &&
      !isAcpFamilyEngine(engineId)
    );
  });
  const managed = ready.filter(
    (connection) => connectionEngineId(connection) === 'station',
  );
  const chosen = chosenConnectionId
    ? connected.find((connection) => connection.id === chosenConnectionId)
    : undefined;
  if (chosen) return chosen;
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
  // #2309: with a server record, "doing anything" is the server's open turn
  // (or this composer's unacknowledged send) plus a wait on the user. The
  // coarse `orchestrationStatus: 'running'` is the provider's process state
  // and is not consulted: it is exactly the flag that survived a missed
  // terminal and kept a finished thread looking active.
  const server = serverTurnLive(session);
  if (server !== undefined) {
    return server || session.orchestrationStatus === 'awaiting-approval';
  }
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

/** Display count only: a running child or pending provider reply is work,
 * even when this session has no interruptible turn. */
export function isSessionWorkActive(
  session?: SessionExecutionActivity | null,
): boolean {
  return isSessionExecutionActive(session) || serverWorkLive(session) === true;
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
  // #2309: the server's record decides first. It is folded from committed
  // events for the whole conversation, so a reload, a reconnect, another
  // device and a lineage child all read the same answer, and a content delta
  // on its own can never make a turn look live.
  const server = serverTurnLive(session);
  if (server !== undefined) return server;
  if (session.orchestrationSessionStarted) {
    return (
      session.orchestrationTurnOpen === true || session.status === 'sending'
    );
  }
  return isSessionExecutionActive(session);
}
