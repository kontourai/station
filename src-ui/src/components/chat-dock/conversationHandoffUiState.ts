import type { ConversationHandoffReceipt } from '@kontourai/station-sdk/client';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ChatUIState } from '../../contexts/active-chats-state';
import { resolveAgentExecution } from '../../utils/execution';

export function beginConversationHandoffUiState(
  state: ChatUIState | undefined,
  input: { message: string; clientTurnId: string; now: number },
): Partial<ChatUIState> {
  const messages = state?.messages ?? [];
  return {
    status: 'sending',
    pendingClientTurnId: input.clientTurnId,
    messages: messages.some(
      (candidate) => candidate.clientId === input.clientTurnId,
    )
      ? messages
      : [
          ...messages,
          {
            role: 'user',
            content: input.message,
            clientId: input.clientTurnId,
            timestamp: input.now,
          },
        ],
  };
}

export function refuseConversationHandoffUiState(
  state: ChatUIState | undefined,
  clientTurnId: string,
): Partial<ChatUIState> {
  return {
    status: 'idle',
    pendingClientTurnId: undefined,
    messages: (state?.messages ?? []).filter(
      (candidate) => candidate.clientId !== clientTurnId,
    ),
  };
}

export function acceptConversationHandoffUiState(
  state: ChatUIState | undefined,
  target: AgentData | undefined,
  receipt: ConversationHandoffReceipt,
): Partial<ChatUIState> {
  const execution = target
    ? resolveAgentExecution(target)
    : {
        executionMode: undefined,
        executionScope: undefined,
        agentConnectionId:
          receipt.target.engine.kind === 'connection'
            ? receipt.target.engine.connectionId
            : undefined,
        provider: undefined,
        providerId: undefined,
        defaultProviderId: undefined,
        providerOptions: {},
        model: undefined,
        modelSource: 'unknown' as const,
      };
  return {
    ...execution,
    agentSlug: receipt.target.agentId,
    agentName: target?.name ?? `Deleted Agent (${receipt.target.agentId})`,
    currentSessionId: receipt.currentSessionId,
    model: receipt.target.modelId ?? execution.model,
    modelSource: receipt.target.modelId
      ? 'session override'
      : execution.modelSource,
    requestedModel: receipt.target.modelId ?? null,
    requestedModelSource: receipt.target.modelId
      ? 'session override'
      : 'runtime',
    queuedMessages: [],
    queuedMessageFailure: undefined,
    isEditingQueue: false,
    sessionAutoApprove: [],
    pendingApprovals: [],
    approvalToasts: new Map(),
    abortController: undefined,
    stopPending: undefined,
    pendingClientTurnId: undefined,
    lastAppliedApprovalMode: undefined,
    isProcessingStep: false,
    error: null,
    orchestrationTurnOpen: false,
    openTurnId: undefined,
    openTurnShellSuperseded: undefined,
    streamingMessage: undefined,
    toolCalls: [],
    ephemeralMessages: [],
    currentModeId: null,
    planArtifact: null,
    flowRun: null,
    activityHint: undefined,
    backgroundTasks: [],
    liveUsage: undefined,
    status: 'sending',
    orchestrationSessionStarted: true,
    orchestrationHistoryRevision:
      (state?.orchestrationHistoryRevision ?? 0) + 1,
  };
}
