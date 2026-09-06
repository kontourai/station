import {
  ENGINE_CAPABILITY_MATRICES,
  resolveComposerImageSupport,
  resolveEngineCapabilityMatrix,
  type ToolPolicyDelivery,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import {
  type OrchestrationSessionSummary,
  useModelPickerCatalogQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useModelImageSupport } from '../../contexts/ModelCapabilitiesContext';
import { countOpenChatAttention } from '../../contexts/open-chats-store';
import { useProject } from '../../contexts/ProjectsContext';
import { useGitStatus } from '../../hooks/useGitStatus';
import type { ChatSession } from '../../types';
import {
  connectionEngineId,
  connectionStatusLabel,
  resolveBindingStatus,
  resolveModelProviderLabel,
  resolveSessionExecutionSummary,
  runtimeCatalogVisibleModels,
} from '../../utils/execution';
import type {
  ModelProviderOption,
  SelectableModel,
} from '../../utils/modelCapabilities';

type ModelOption = { id: string; name: string };
const EMPTY_CONNECTIONS: never[] = [];
const EMPTY_ORCHESTRATION_SESSIONS: never[] = [];

function ensureActiveModelOption(
  models: SelectableModel[],
  currentModelId: string | null | undefined,
  providerId?: string,
  providerName?: string,
  providerType?: string,
  providerAvailable = true,
  unavailableReason?: string,
): SelectableModel[] {
  if (
    !currentModelId ||
    models.some(
      (model) =>
        model.id === currentModelId &&
        (!providerId || model.providerId === providerId),
    )
  ) {
    return models;
  }
  return [
    {
      id: currentModelId,
      name: currentModelId,
      providerId,
      providerName,
      providerType,
      available: providerAvailable,
      unavailableReason,
    },
    ...models,
  ];
}

interface UseChatDockViewModelArgs {
  activeSessionId: string | null;
  availableModels: ModelOption[];
  globalModelsLoading?: boolean;
  globalModelsLiveConfirmed?: boolean;
  agents: AgentData[];
  sessions: ChatSession[];
  /**
   * station#1146: the server's own record of every live/persisted session,
   * already fetched by the dock (`ChatDock.tsx`'s
   * `useOrchestrationSessionsQuery`). Passed in rather than queried again
   * here so the two reads can never disagree. Optional so callers that only
   * need the model/binding half of this hook (its unit tests) stay unchanged.
   */
  orchestrationSessions?: OrchestrationSessionSummary[];
  /**
   * UX audit T5: what the sessions query itself is doing. `orchestrationSessions`
   * defaults to `[]` while the query is still loading or has failed, and an
   * empty array is indistinguishable from "this session is genuinely not on
   * the server" — which is how a healthy session rendered "Session record
   * missing" for about a second on EVERY reload. Absence is only established
   * once the read has SUCCEEDED.
   */
  orchestrationSessionsStatus?: 'pending' | 'error' | 'success';
}

export function useChatDockViewModel({
  activeSessionId,
  availableModels,
  globalModelsLoading = false,
  globalModelsLiveConfirmed = false,
  agents,
  sessions,
  orchestrationSessions = EMPTY_ORCHESTRATION_SESSIONS,
  orchestrationSessionsStatus = 'success',
}: UseChatDockViewModelArgs) {
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) || null;
  const activeSessionForHook = activeSession;
  const agentForHook: AgentData | null = activeSessionForHook
    ? agents.find((agent) => agent.slug === activeSessionForHook.agentSlug) ||
      null
    : null;
  const agentDefaultModelId =
    activeSessionForHook?.defaultModel ?? agentForHook?.model;

  const sessionProjectSlug = activeSessionForHook?.projectSlug ?? null;
  const { project: sessionProject } = useProject(sessionProjectSlug ?? '');
  const sessionWorkingDir = sessionProject?.workingDirectory ?? null;
  const sessionProjectName =
    sessionProject?.name ??
    activeSessionForHook?.projectName ??
    sessionProjectSlug ??
    null;
  // station#1146: git stays bound to the PROJECT's directory, deliberately —
  // see `sessionDisplayCwd` below for the split and its reasoning.
  const { data: gitStatus } = useGitStatus(sessionWorkingDir);
  // station#1146: the dock reports on a session that has ALREADY started, so
  // the directory it names must be the one that session was started in, not
  // the one this project would hand a NEW chat. A chat on an engine
  // connection carrying its own Working Directory runs there even when its
  // project has none, and the dock said "~ (defaults to home)".
  //
  // `OrchestrationSessionSummary extends ProviderSession`, whose `cwd`
  // (`packages/contracts/src/provider.ts`) is the persisted, server-resolved
  // directory — `orchestration-service.ts`'s `resolveStartSessionCwd`
  // followed by the adapter's own chain (`acp-adapter.ts`:
  // `input.cwd || connectionCwd || safeHomeDirectory()`). Reading it is a
  // report, not a second guess at the resolver, and it cannot go stale when a
  // connection is later edited.
  //
  // Correlate to the exact current execution Session once the bounded
  // Conversation window has supplied it. Legacy one-Session conversations
  // retain the established Conversation/store-key fallbacks.
  const sessionThreadId =
    activeSessionForHook?.currentSessionId ||
    activeSessionForHook?.conversationId ||
    activeSessionForHook?.id ||
    null;
  /**
   * The serving Station's own record of the chat this dock is showing, found
   * by the correlation key documented above. station#3213 named it: the dock
   * had no way to say a session had FAILED because it never held this record,
   * only the local `ChatSession` tab state. One `.find()` now serves both the
   * directory label below and the failure banner in `ChatDockBody`, so the two
   * cannot correlate to different sessions.
   */
  const activeOrchestrationSession = sessionThreadId
    ? (orchestrationSessions.find(
        (session) => session.threadId === sessionThreadId,
      ) ?? null)
    : null;
  /**
   * UX audit T5: what this dock actually knows about the serving Station's
   * record for the chat on screen. `null` above answers "not in the array I
   * was handed", which is a different question — the array is `[]` while the
   * read is pending and while it has failed. Only `absent` is established
   * absence; `pending` and `error` are the read's own state and must render
   * as such.
   */
  const activeOrchestrationSessionRead:
    | 'pending'
    | 'error'
    | 'present'
    | 'absent' =
    !sessionThreadId || activeOrchestrationSession
      ? 'present'
      : orchestrationSessionsStatus === 'pending'
        ? 'pending'
        : orchestrationSessionsStatus === 'error'
          ? 'error'
          : 'absent';
  const sessionCwd = activeOrchestrationSession?.cwd?.trim() ?? '';
  /**
   * What the dock's directory label shows, in order:
   *
   * 1. the correlated session's own `cwd` — the truth, whatever it is
   *    (a project directory, a connection's directory, or the resolver's
   *    `$HOME` default, which now reads as the home path rather than
   *    "~ (defaults to home)": post-start the parenthetical answers a
   *    question that is no longer open, and the concrete path is what
   *    someone reading a RUNNING conversation needs);
   * 2. failing that, the project's `workingDirectory` — reached when there
   *    is no correlated session at all (a chat before its first send, or a
   *    chat on the direct `/chat` path, which never starts one). With
   *    nothing to report, the project's binding is the best statement
   *    available and matches the previous behaviour exactly;
   * 3. failing that, `ChatDockProjectContext`'s "~ (defaults to home)" —
   *    still correct as a statement about what an unbound chat gets, and
   *    still only reached when nothing better is known.
   *
   * Deliberately NOT moved with it: `useGitStatus` above, and therefore the
   * git badge on this same row, the composer "+" menu's file count, the
   * mobile header's branch, and the Files panel. Those all emit or consume
   * repo-RELATIVE paths that the Workspace File Preview pane resolves against
   * the PROJECT's
   * `workingDirectory` (the active-work file action routes an exact File
   * Preview intent through `setLayout(projectSlug, …, { openFilePreviewIntent })`
   * → `config.workingDirectory`). Repointing them at a session cwd outside
   * the project would list one repository's changed files while every deep
   * link opened another's — the same class of lie this change removes,
   * relocated one surface over. They are already gated on
   * `activeSession?.projectSlug`, so they are coherently the project's git
   * state, and they stay that way.
   */
  const sessionDisplayCwd = sessionCwd || sessionWorkingDir;
  const { data: sessionLayouts = [] } = useProjectLayoutsQuery(
    sessionProjectSlug ?? '',
    { enabled: !!sessionProjectSlug },
  );
  const {
    data: modelPickerCatalog,
    isFetchedAfterMount,
    error,
    isLoading: stationModelsLoading,
  } = useModelPickerCatalogQuery();
  const modelCatalogLiveConfirmed = isFetchedAfterMount && !error;
  const agentConnections =
    modelPickerCatalog?.agentConnections ?? EMPTY_CONNECTIONS;
  const modelConnectionsData = modelPickerCatalog?.modelConnections;
  const modelConnections =
    modelConnectionsData && modelConnectionsData.length > 0
      ? modelConnectionsData
      : EMPTY_CONNECTIONS;
  const sessionCodingLayout = sessionLayouts.find(
    (layout: any) => layout.type === 'coding',
  );

  const observedExecution =
    activeSessionForHook?.conversationOpenState?.status === 'resolved'
      ? activeSessionForHook.conversationOpenState.execution
      : undefined;
  const agentConnectionId =
    observedExecution &&
    observedExecution.sessionId === activeSessionForHook?.currentSessionId
      ? (observedExecution?.engineConnectionId ?? null)
      : (activeSessionForHook?.agentConnectionId ??
        agentForHook?.execution?.agentConnectionId ??
        null);
  const runtimeConnection = agentConnections.find(
    (connection) => connection.id === agentConnectionId,
  );
  const providerConnection = modelConnections.find(
    (connection) => connection.id === activeSessionForHook?.providerId,
  );
  const modelProviderLabel = resolveModelProviderLabel({
    executionMode: activeSessionForHook?.executionMode,
    providerConnectionName: providerConnection?.name,
    runtimeConnectionName: runtimeConnection?.name,
    provider: activeSessionForHook?.provider,
    agentName: activeSessionForHook?.agentName,
  });
  // The Agent app connection's configured approval-mode default (#727) —
  // generic `config` bag field, additive, mirrors `config.defaultModel`.
  const connectionApprovalModeDefault =
    typeof runtimeConnection?.config.approvalMode === 'string'
      ? runtimeConnection.config.approvalMode
      : undefined;
  // The connection object, not its display/id string, is the authoritative
  // input to the matrix resolver. Undefined remains visibly unknown in the
  // composer while the connection query has not resolved.
  const toolPolicyDelivery: ToolPolicyDelivery | undefined = runtimeConnection
    ? resolveEngineCapabilityMatrix(agentConnectionId, runtimeConnection)
        .toolPolicy
    : undefined;
  const currentModelId =
    activeSession?.model ||
    agents.find((agent) => agent.slug === activeSession?.agentSlug)?.model;
  // Memoized: `bindingStatus`/`effectiveModels` are passed straight through to
  // the memoized ChatDockContentArea (as `availableModels`) — recomputing
  // fresh objects/arrays every render would defeat that memo on every
  // unrelated re-render (e.g. the resize drag's per-frame renders), since
  // `agentForHook`/`activeSessionForHook`/`providerConnection`/
  // `runtimeConnection` are themselves stable object references (`.find()`
  // results from otherwise-unchanged source arrays) whenever nothing here
  // actually changed.
  // The one connection record this chat's engine identity and catalog come
  // from — shared by bindingStatus and the composer's capability-matrix
  // resolution so the two can never disagree about which engine this is.
  const chatEngineConnection =
    activeSessionForHook?.executionMode === EXECUTION_MODE.STATION
      ? (providerConnection ?? runtimeConnection)
      : runtimeConnection;
  const bindingStatus = useMemo(
    () =>
      resolveBindingStatus({
        agent: agentForHook,
        chatState: activeSessionForHook,
        runtimeConnection: chatEngineConnection,
        globalModels: availableModels.map((model) => ({
          id: model.id,
          name: model.name,
          originalId: model.id,
        })),
      }),
    [agentForHook, activeSessionForHook, chatEngineConnection, availableModels],
  );
  const usesGlobalCatalog =
    activeSessionForHook?.executionMode !== EXECUTION_MODE.STATION &&
    connectionEngineId(chatEngineConnection) === 'station' &&
    (!runtimeConnection ||
      runtimeCatalogVisibleModels(runtimeConnection).length === 0);
  const modelsLoading = usesGlobalCatalog
    ? globalModelsLoading
    : stationModelsLoading;
  const modelsStale = usesGlobalCatalog
    ? !globalModelsLiveConfirmed
    : !modelCatalogLiveConfirmed;
  const modelProviders = useMemo<ModelProviderOption[]>(() => {
    if (activeSessionForHook?.executionMode !== EXECUTION_MODE.STATION) {
      return runtimeConnection
        ? [
            {
              id: runtimeConnection.id,
              name: runtimeConnection.name,
              available:
                runtimeConnection.enabled &&
                runtimeConnection.status === 'ready',
              detail: connectionStatusLabel(
                runtimeConnection.status ?? 'unknown',
              ),
            },
          ]
        : [];
    }
    // station#3747: `/api/connections/models` IS the LLM-capable inventory now.
    // Re-asking `capabilities.includes('llm')` here was a second derivation of
    // a question the route already answers.
    return modelConnections
      .filter((connection) => connection.kind === 'model')
      .map((connection) => ({
        id: connection.id,
        name: connection.name,
        available: connection.enabled && connection.status === 'ready',
        detail: connectionStatusLabel(connection.status),
      }));
  }, [
    activeSessionForHook?.executionMode,
    modelConnections,
    runtimeConnection,
  ]);
  const effectiveModels = useMemo(() => {
    const models =
      activeSessionForHook?.executionMode === EXECUTION_MODE.STATION
        ? modelConnections
            .filter(
              (connection) =>
                connection.kind === 'model' &&
                connection.enabled &&
                connection.status === 'ready',
            )
            .flatMap((connection) =>
              runtimeCatalogVisibleModels(connection).map((model) => ({
                ...model,
                providerId: connection.id,
                providerName: connection.name,
                providerType: connection.type,
              })),
            )
        : (bindingStatus.visibleModels as SelectableModel[]).map((model) => ({
            ...model,
            providerId: runtimeConnection?.id,
            providerName: runtimeConnection?.name,
            providerType: runtimeConnection?.type,
          }));
    return ensureActiveModelOption(
      models,
      currentModelId,
      activeSessionForHook?.providerId,
      providerConnection?.name ?? modelProviderLabel,
      providerConnection?.type ?? activeSessionForHook?.provider,
      providerConnection
        ? providerConnection.enabled && providerConnection.status === 'ready'
        : true,
      providerConnection
        ? connectionStatusLabel(providerConnection.status)
        : undefined,
    );
  }, [
    activeSessionForHook?.executionMode,
    activeSessionForHook?.provider,
    activeSessionForHook?.providerId,
    bindingStatus.visibleModels,
    currentModelId,
    modelConnections,
    modelProviderLabel,
    providerConnection,
    runtimeConnection?.id,
    runtimeConnection?.name,
    runtimeConnection?.type,
  ]);
  // station#3344: the paste-time image answer comes from the engine's DECLARED
  // `imageInput` cell — the same matrix the tool-policy chip above reads —
  // narrowed only by a model catalog row that positively says no. It used to
  // be inferred from three signals that are all false for an ordinary
  // Station-engine chat (empty Bedrock catalog, no engine connection to read
  // capabilities off, and an `agent.supportsAttachments` field no server code
  // ever wrote), so the composer refused every pasted image on the one engine
  // whose relay was built to carry them. The resolver's own no-connection
  // default is `station`, which is exactly the unbound Station agent's engine.
  const selectedModelImageSupport = useModelImageSupport(
    typeof currentModelId === 'string' ? currentModelId : undefined,
  );
  // `resolveEngineCapabilityMatrix` reads CONNECTION records, and its
  // no-id-no-connection default only fires when `agentConnectionId` is
  // genuinely absent. A live Station session can carry an `agentConnectionId`
  // that names no loaded engine connection, and the resolver then correctly
  // refuses to guess and answers `unknown` — right for a connected engine
  // whose record is missing, wrong for the Station engine, which is named by
  // the session's own `executionMode`, not by a connection at all. Reading
  // the session's declared execution mode first is the same discriminator
  // `chatEngineConnection` above already uses.
  const engineCapabilityMatrix =
    activeSessionForHook?.executionMode === EXECUTION_MODE.STATION
      ? ENGINE_CAPABILITY_MATRICES.station
      : resolveEngineCapabilityMatrix(agentConnectionId, runtimeConnection);
  const composerImageSupport = resolveComposerImageSupport(
    engineCapabilityMatrix,
    {
      ...(runtimeConnection
        ? {
            connectionCapabilities: runtimeConnection.capabilities,
            connectionLabel: runtimeConnection.name,
            // Present only for an engine whose cell demands an observation
            // (ACP); `undefined` stays unobserved, never a refusal.
            ...(typeof runtimeConnection.capabilityInventory?.sessionSurfaces
              ?.promptImage === 'boolean'
              ? {
                  observedImagePrompt:
                    runtimeConnection.capabilityInventory.sessionSurfaces
                      .promptImage,
                }
              : {}),
          }
        : {}),
      modelSupport: selectedModelImageSupport,
      ...(typeof currentModelId === 'string'
        ? { modelLabel: currentModelId }
        : {}),
    },
  );
  const modelSupportsAttachments = composerImageSupport.attachable;
  const imageAttachmentRefusal = composerImageSupport.refusal;
  const fileAttachmentsSupported =
    runtimeConnection?.capabilities.includes('file-input') ?? false;
  const unreadCount = countOpenChatAttention(sessions);
  const executionSummary = resolveSessionExecutionSummary(activeSession);

  return {
    activeSession,
    activeOrchestrationSession,
    activeOrchestrationSessionRead,
    activeSessionForHook,
    agentDefaultModelId,
    chatEngineConnection,
    bindingStatus,
    connectionApprovalModeDefault,
    toolPolicyDelivery,
    effectiveModels,
    executionSummary,
    gitStatus,
    fileAttachmentsSupported,
    imageAttachmentRefusal,
    modelSupportsAttachments,
    modelProviderLabel,
    modelProviders,
    modelsLoading,
    modelsStale,
    sessionCodingLayout,
    sessionDisplayCwd,
    sessionProjectName,
    unreadCount,
  };
}
