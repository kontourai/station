import {
  type AgentId,
  type EngineConnectionId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  AgentConnectionView,
  ConnectionConfig,
} from '@kontourai/station-contracts/tool';
import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import {
  useACPConnectionsQuery,
  useAgentConnectionsQuery,
  useModelConnectionsQuery,
  useProjectLayoutQuery,
  useProjectQuery,
} from '@kontourai/station-sdk';
import { useCallback, useMemo, useState } from 'react';
import {
  buildNewChatModalViewModel,
  buildNewChatModelOverrideKey,
  GLOBAL_CONTEXT,
  getRecentAgentSlugsForContext,
  newChatLastChosenModel,
  newChatProjectDefaultModel,
  resolveNewChatDefaultSelection,
} from '../components/modals/new-chat-modal-utils';
import { activeChatsStore } from '../contexts/ActiveChatsContext';
import type { AgentData } from '../contexts/AgentsContext';
import { useConfig } from '../contexts/ConfigContext';
import { useNavigation } from '../contexts/NavigationContext';
import type { ProjectMetadata } from '../contexts/ProjectsContext';
import {
  defaultManagedRuntimeConnection,
  guaranteeConcreteModel,
  resolveEffectiveModel,
  resolveGlobalProviderManagedExecution,
  resolveProjectProviderManagedExecution,
  runtimeCatalogVisibleModels,
  supportsProviderManagedBinding,
} from '../utils/execution';
import type {
  NewChatModelChoice,
  SelectableModel,
} from '../utils/modelCapabilities';
import { getLastChosenModelMap } from './lastChosenModel';

/**
 * The engine binding a provider-managed row should carry: the Agent's own, or
 * the loaded managed-runtime connection's — and NOTHING when neither exists.
 *
 * It used to fall back to `engineConnectionId('station')` (station#3662). That
 * id can never name an engine connection — the registry throws
 * `ReservedStationIdentityError` for one — so the fallback minted, on the
 * client, exactly the impossible binding the seed used to persist: the
 * picker's own dispatch check (`canAgentStartChat`) then looked it up, found
 * nothing, and refused the row it had just rewritten. Absent is the honest
 * answer and the one every other seam already reads as Station's own engine.
 */
export function resolveProviderManagedAgentConnectionId(
  existing: EngineConnectionId | undefined,
  managedRuntimeId: string | undefined,
): EngineConnectionId | undefined {
  if (existing) return existing;
  return managedRuntimeId ? engineConnectionId(managedRuntimeId) : undefined;
}

import { getRecentAgentSlugs } from './useRecentAgents';

export interface ACPSelectionConnection {
  id: string;
  /**
   * station#1089: the connection's configured Working Directory. Read by
   * `resolveNewChatWorkspaceHint` so the new-chat picker names the directory
   * the engine will actually be launched in instead of asserting `$HOME`.
   */
  cwd?: string;
  currentModel: string | null;
  configOptions?: Array<{
    category: string;
    currentValue?: string;
    /** ACP select options are { value, name } objects; bare strings tolerated. */
    options?: Array<string | { value: string; name?: string }>;
  }>;
}

/**
 * #3028: an ACP engine's model catalog arrives on the connection's config
 * options (category "model"), a channel neither the runtime catalog nor
 * `agent.modelOptions` carries. Exported pure so the contract — an engine
 * advertising models yields selectable models — is directly testable.
 */
export function acpCatalogModelOptions(
  acpConnections: ACPSelectionConnection[],
  agentConnectionId: string | undefined,
): Array<{ id: string; name: string }> {
  if (!agentConnectionId) return [];
  return (
    acpConnections.find((acp) => acp.id === agentConnectionId)?.configOptions ??
    []
  )
    .filter((option) => option.category === 'model')
    .flatMap((option) => option.options ?? [])
    .map((entry) =>
      typeof entry === 'string'
        ? { id: entry, name: entry }
        : { id: entry.value, name: entry.name ?? entry.value },
    )
    .filter((model) => model.id.length > 0);
}

/**
 * Station's model inventory can retain cached catalogs for connections that
 * are disabled or unhealthy. Only a ready, enabled model connection is a
 * launchable provider; keep this predicate aligned with the active composer.
 */
export function stationEligibleModels(
  modelConnections: ConnectionConfig[],
): SelectableModel[] {
  return modelConnections
    .filter(
      (candidate) =>
        candidate.kind === 'model' &&
        candidate.enabled &&
        candidate.status === 'ready',
    )
    .flatMap((candidate) =>
      runtimeCatalogVisibleModels(candidate).map((model) => ({
        ...model,
        providerId: candidate.id,
        providerName: candidate.name,
        providerType: candidate.type,
      })),
    );
}

export function useNewChatSelectionModel({
  agents,
  projects,
  selectedContext,
  contextSearch = '',
  agentSearch = '',
}: {
  agents: AgentData[];
  projects: ProjectMetadata[];
  selectedContext: string;
  contextSearch?: string;
  agentSearch?: string;
}) {
  const { selectedProject: activeLayoutProject, selectedProjectLayout } =
    useNavigation();
  const appConfig = useConfig();
  const { data: layout } = useProjectLayoutQuery(
    activeLayoutProject || '',
    selectedProjectLayout || '',
    { enabled: !!activeLayoutProject && !!selectedProjectLayout },
  );
  const {
    data: agentConnections = [],
    isLoading: runtimeLoading,
    error: runtimeError,
    refetch: refetchAgentConnections,
  } = useAgentConnectionsQuery() as {
    data?: AgentConnectionView[];
    isLoading?: boolean;
    error?: unknown;
    refetch: () => unknown;
  };
  const {
    data: modelConnections = [],
    isLoading: modelsLoading,
    error: modelsError,
    refetch: refetchModelConnections,
  } = useModelConnectionsQuery() as {
    data?: ConnectionConfig[];
    isLoading?: boolean;
    error?: unknown;
    refetch: () => unknown;
  };
  const { data: acpConnections = [], refetch: refreshACPConnections } =
    useACPConnectionsQuery() as {
      data?: ACPSelectionConnection[];
      refetch: () => Promise<unknown>;
    };
  const selectedProjectSlug =
    selectedContext !== GLOBAL_CONTEXT ? selectedContext : null;
  const { data: selectedProjectConfig } = useProjectQuery(
    selectedProjectSlug ?? '',
    { enabled: !!selectedProjectSlug },
  ) as {
    data?: {
      agents?: AgentId[];
      defaultProviderId?: string;
      defaultModel?: string;
    };
  };

  const globalProviderManagedExecution = useMemo(
    () => resolveGlobalProviderManagedExecution(appConfig, modelConnections),
    [appConfig, modelConnections],
  );
  const providerManagedExecution = useMemo(
    () =>
      selectedProjectSlug
        ? (resolveProjectProviderManagedExecution(
            selectedProjectConfig,
            modelConnections,
          ) ?? globalProviderManagedExecution)
        : globalProviderManagedExecution,
    [
      globalProviderManagedExecution,
      modelConnections,
      selectedProjectConfig,
      selectedProjectSlug,
    ],
  );
  const managedRuntime = useMemo(
    () => defaultManagedRuntimeConnection(agentConnections),
    [agentConnections],
  );
  const modalAgents = useMemo(() => {
    if (!providerManagedExecution) return agents;
    return agents.map((agent) =>
      supportsProviderManagedBinding(agent, agentConnections)
        ? {
            ...agent,
            execution: {
              agentConnectionId: resolveProviderManagedAgentConnectionId(
                agent.execution?.agentConnectionId,
                managedRuntime?.id,
              ),
              modelId: agent.execution?.modelId ?? null,
              runtimeOptions: {
                ...(agent.execution?.runtimeOptions ?? {}),
                executionMode: EXECUTION_MODE.STATION,
                executionScope: providerManagedExecution.executionScope,
                providerId: providerManagedExecution.providerId,
                providerKind: providerManagedExecution.provider,
                displayModel: providerManagedExecution.model,
              },
            },
            model: providerManagedExecution.model,
          }
        : agent,
    );
  }, [agents, agentConnections, managedRuntime?.id, providerManagedExecution]);
  const providerManagedAgentSlugs = useMemo(
    () =>
      providerManagedExecution
        ? modalAgents
            .filter(
              (agent) =>
                agent.execution?.runtimeOptions?.executionMode ===
                EXECUTION_MODE.STATION,
            )
            .map((agent) => agent.slug)
        : [],
    [modalAgents, providerManagedExecution],
  );

  // Read once per modal mount, matching the "lost on remount" fix for
  // recent agents — pure resolver/view-model functions stay localStorage-free.
  const lastChosenModelByBinding = useMemo(() => getLastChosenModelMap(), []);
  const activeChatsSnapshot = activeChatsStore.getSnapshot();
  const viewModel = useMemo(
    () =>
      buildNewChatModalViewModel({
        agents: modalAgents,
        projects,
        agentConnections,
        selectedContext,
        contextSearch,
        agentSearch,
        selectedProjectAgentFilter: selectedProjectConfig?.agents,
        layoutAvailableAgents: layout?.availableAgents || [],
        layoutName: layout?.name,
        layoutIcon: layout?.icon,
        providerManagedAgentSlugs,
        recentSlugs: getRecentAgentSlugsForContext(
          activeChatsSnapshot,
          selectedContext,
          getRecentAgentSlugs(),
        ),
      }),
    [
      activeChatsSnapshot,
      agentConnections,
      agentSearch,
      contextSearch,
      layout?.availableAgents,
      layout?.icon,
      layout?.name,
      modalAgents,
      projects,
      providerManagedAgentSlugs,
      selectedContext,
      selectedProjectConfig?.agents,
    ],
  );
  const defaultSelection = resolveNewChatDefaultSelection({
    flatList: viewModel.flatList,
    agentConnections,
    modelConnections,
    acpConnections,
    projectDefaultModel: selectedProjectConfig?.defaultModel,
    lastChosenModelByBinding,
  });
  const [modelChoices, setModelChoices] = useState<
    Record<string, NewChatModelChoice>
  >({});
  // Keep only the stable identity in state. Provider-managed execution can be
  // projected onto modalAgents after a model catalog resolves; retaining the
  // clicked Agent object would leave an open picker on the pre-projection
  // binding until it is closed and reopened.
  const [modelPickerAgentSlug, setModelPickerAgentSlug] = useState<
    AgentData['slug'] | null
  >(null);
  const modelPickerAgent = useMemo(
    () =>
      modalAgents.find((agent) => agent.slug === modelPickerAgentSlug) ?? null,
    [modalAgents, modelPickerAgentSlug],
  );
  const setModelPickerAgent = useCallback((agent: AgentData | null) => {
    setModelPickerAgentSlug(agent?.slug ?? null);
  }, []);
  const modelConnectionForAgent = (agent: AgentData) => {
    const providerId = agent.execution?.runtimeOptions?.providerId;
    return (
      modelConnections.find((connection) => connection.id === providerId) ??
      agentConnections.find(
        (connection) => connection.id === agent.execution?.agentConnectionId,
      )
    );
  };
  const modelsForAgent = (agent: AgentData): SelectableModel[] => {
    const stationMode =
      agent.execution?.runtimeOptions?.executionMode === EXECUTION_MODE.STATION;
    const connection = modelConnectionForAgent(agent);
    if (stationMode) {
      // A Station-mode Agent may start on every eligible model connection.
      // Preserve each instance identity so duplicate model IDs do not collapse
      // and the shared picker can expose its provider rail.
      return stationEligibleModels(modelConnections);
    }
    const connectionModels = connection
      ? runtimeCatalogVisibleModels(connection)
      : [];
    // #3028: an ACP engine's catalog arrives on the connection's config
    // options (category "model"), a channel neither the runtime catalog nor
    // agent.modelOptions carries — OpenCode advertised a full model select
    // while this picker rendered no affordance at all.
    const acpModelOptions = acpCatalogModelOptions(
      acpConnections,
      agent.execution?.agentConnectionId,
    );
    const models =
      connectionModels.length > 0
        ? connectionModels
        : agent.modelOptions?.length
          ? (agent.modelOptions as SelectableModel[])
          : acpModelOptions;
    return models.map((model) => ({
      ...model,
      providerId: connection?.id,
      providerName: connection?.name,
      providerType: connection?.type,
    }));
  };
  const modelChoiceKey = (agent: AgentData) =>
    buildNewChatModelOverrideKey(agent, selectedContext);
  const defaultEffectiveModelForAgent = (agent: AgentData) => {
    const runtimeConnection = agentConnections.find(
      (connection) => connection.id === agent.execution?.agentConnectionId,
    );
    const acpConnection = acpConnections.find(
      (connection) => connection.id === runtimeConnection?.id,
    );
    return {
      ...guaranteeConcreteModel(
        resolveEffectiveModel({
          agent,
          runtimeConnection: modelConnectionForAgent(agent),
          runtimeCurrentModel: acpConnection?.currentModel,
          runtimeCurrentMode: acpConnection?.configOptions?.find(
            (option) => option.category === 'mode',
          )?.currentValue,
          projectDefaultModel: newChatProjectDefaultModel(
            agent,
            selectedProjectConfig?.defaultModel,
          ),
          lastChosenModel: newChatLastChosenModel(
            agent,
            lastChosenModelByBinding,
          ),
        }),
      ),
      // The default model resolves against this binding. Keep that exact
      // provider instance with the model so an earlier inventory entry with a
      // duplicate model id cannot supply the wrong capability controls.
      providerId: modelConnectionForAgent(agent)?.id,
    };
  };

  return {
    viewModel,
    defaultSelection,
    agentConnections,
    modelConnections,
    acpConnections,
    refreshACPConnections,
    selectedProjectConfig,
    runtimeLoading,
    modelsLoading,
    // station#771: both flow into a single `flatList.length === 0` gate in
    // `NewChatModal` that previously only checked `runtimeLoading ||
    // modelsLoading` — a settled error rendered as "Nothing to chat with
    // yet" (a fabricated negative fact), never as a read failure.
    runtimeError,
    modelsError,
    refetchAgentConnections,
    refetchModelConnections,
    lastChosenModelByBinding,
    modelChoices,
    setModelChoices,
    modelPickerAgent,
    setModelPickerAgent,
    modelsForAgent,
    modelChoiceKey,
    defaultEffectiveModelForAgent,
  };
}
