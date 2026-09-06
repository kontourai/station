import type {
  ConversationListItem,
  ConversationOpenResolution,
} from '@kontourai/station-contracts/orchestration';
import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import type { ChatUIState } from '../../contexts/active-chats-state';

export type ConversationOpenRecovery = {
  conversation: ConversationListItem;
  status: 'missing-session' | 'unavailable' | 'error';
};

export type ConversationOpenCommit =
  | { kind: 'recovery'; recovery: ConversationOpenRecovery }
  | { kind: 'opened'; tabId: string; patch: Partial<ChatUIState> };

interface ConversationOpenDockEffects {
  apiBase: string;
  open: Parameters<typeof commitConversationOpen>[0]['open'];
  projectName: Parameters<typeof commitConversationOpen>[0]['projectName'];
  findTab: Parameters<typeof commitConversationOpen>[0]['findTab'];
  readChat?: (tabId: string) => Partial<ChatUIState> | undefined;
  agentName?: (agentId: string) => string | undefined;
  updateChat: (tabId: string, patch: Partial<ChatUIState>) => void;
  setRecovery: (recovery: ConversationOpenRecovery | null) => void;
}

export async function resolveConversationOpenAuthoritatively(
  conversationId: string,
  apiBase: string,
): Promise<ConversationOpenResolution> {
  const { resolveConversationOpen } = await import(
    '@kontourai/station-sdk/conversation-open'
  );
  return resolveConversationOpen(conversationId, apiBase);
}

/** One total binding patch prevents retry and reload paths from drifting. */
export function conversationOpenPatch(
  resolution: ConversationOpenResolution,
  previous?: Partial<ChatUIState>,
  choice?: {
    validModelIds?: readonly string[];
    provider?: string;
    engineConnectionId?: string;
    providerOptions?: Record<string, unknown>;
    agentName?: string;
  },
): Partial<ChatUIState> {
  const resolved = resolution.status === 'resolved' ? resolution : undefined;
  const execution = resolved?.execution;
  const changedChild = Boolean(
    previous &&
      resolved &&
      ((previous.currentSessionId ?? previous.conversationId) !==
        resolved.currentSessionId ||
        (execution &&
          (previous.agentSlug !== execution.agentId ||
            previous.provider !== execution.provider ||
            previous.agentConnectionId !== execution.engineConnectionId))),
  );
  const unknownReplacement = changedChild && !execution;
  const pendingChoice = Boolean(
    execution &&
      !changedChild &&
      previous?.requestedModel &&
      choice?.validModelIds === undefined,
  );
  const catalogMatchesExecution = Boolean(
    execution &&
      choice?.provider === execution.provider &&
      choice.engineConnectionId === execution.engineConnectionId &&
      (execution.engineConnectionId !== undefined ||
        execution.provider === 'station-agent'),
  );
  const keepRequested =
    !changedChild &&
    Boolean(
      previous?.requestedModel &&
        (pendingChoice ||
          (catalogMatchesExecution &&
            choice?.validModelIds?.includes(previous.requestedModel))),
    );
  const executionPatch: Partial<ChatUIState> = execution
    ? {
        agentSlug: execution.agentId,
        agentName: choice?.agentName ?? execution.agentId,
        projectSlug: resolution.conversation.projectSlug,
        projectName:
          previous?.projectSlug === resolution.conversation.projectSlug
            ? previous?.projectName
            : undefined,
        provider: execution.provider,
        orchestrationProvider: execution.provider,
        executionMode:
          execution.provider === 'station-agent'
            ? EXECUTION_MODE.STATION
            : EXECUTION_MODE.EXTERNAL,
        executionScope: resolution.conversation.projectSlug
          ? 'project'
          : 'global',
        agentConnectionId: execution.engineConnectionId,
        providerId: undefined,
        defaultProviderId: undefined,
        defaultModel: undefined,
        defaultModelSource: undefined,
        model: execution.model ?? execution.acceptedModel,
        orchestrationModel: execution.model ?? execution.acceptedModel,
        modelSource:
          execution.model || execution.acceptedModel ? 'runtime' : 'unknown',
        requestedModel: keepRequested ? previous!.requestedModel : null,
        requestedModelSource: keepRequested
          ? previous!.requestedModelSource
          : 'runtime',
        requestedProviderOptions: pendingChoice
          ? (previous?.requestedProviderOptions ?? {})
          : keepRequested
            ? (choice?.providerOptions ?? {})
            : {},
        providerOptions: {},
        ...(changedChild
          ? {
              sessionAutoApprove: [],
              pendingApprovals: [],
              approvalToasts: new Map(),
              lastAppliedApprovalMode: undefined,
              currentModeId: null,
              planArtifact: null,
              flowRun: null,
              activityHint: undefined,
              backgroundTasks: [],
              liveUsage: undefined,
              toolCalls: [],
              ephemeralMessages: [],
              orchestrationTurnOpen: false,
              openTurnId: undefined,
              openTurnShellSuperseded: undefined,
              streamingMessage: undefined,
              pendingClientTurnId: undefined,
              isProcessingStep: false,
              ...(previous?.queuedMessages?.length
                ? {
                    queuedMessageFailure: {
                      message:
                        'This conversation changed Agent or Session elsewhere. Review queued messages before retrying.',
                      at: Date.now(),
                    },
                  }
                : {}),
            }
          : {}),
        ...(!changedChild && previous?.requestedModel && !keepRequested
          ? {
              error:
                'The saved model choice is unavailable for this Session. The current engine model is selected.',
            }
          : {}),
      }
    : unknownReplacement
      ? {
          agentSlug: undefined,
          agentName: 'Unknown Agent',
          provider: undefined,
          orchestrationProvider: undefined,
          agentConnectionId: undefined,
          executionMode: undefined,
          model: undefined,
          orchestrationModel: undefined,
          requestedModel: null,
          requestedProviderOptions: {},
          providerOptions: {},
          error:
            'The current Session execution binding is unavailable. Retry opening this conversation before sending.',
        }
      : {};
  return {
    conversationOpenPending: pendingChoice,
    conversationOpenFailed: unknownReplacement,
    conversationOpenState: resolution,
    title: resolution.conversation.title,
    ...executionPatch,
    currentSessionId: undefined,
    orchestrationSessionStarted: false,
    ...(resolution.status === 'resolved'
      ? {
          currentSessionId: resolution.currentSessionId,
          orchestrationSessionStarted: true,
        }
      : {}),
  };
}

/** Resolve, open, and bind one picker/recovery row as a single UI command. */
export async function openConversationForDock(
  conversation: ConversationListItem,
  effects: ConversationOpenDockEffects,
): Promise<boolean> {
  try {
    const resolution = await resolveConversationOpenAuthoritatively(
      conversation.id,
      effects.apiBase,
    );
    const outcome = await commitConversationOpen({
      resolution,
      open: effects.open,
      projectName: effects.projectName,
      findTab: effects.findTab,
      readChat: effects.readChat,
      agentName: effects.agentName,
    });
    if (outcome.kind === 'recovery') {
      effects.setRecovery(outcome.recovery);
      return true;
    }
    effects.updateChat(outcome.tabId, outcome.patch);
    effects.setRecovery(null);
    return true;
  } catch {
    effects.setRecovery({ conversation, status: 'error' });
    return true;
  }
}

export async function retryActiveConversationForDock(
  sessionId: string,
  conversationId: string,
  apiBase: string,
  updateChat: ConversationOpenDockEffects['updateChat'],
  onUnavailable: () => void,
  readChat?: (tabId: string) => Partial<ChatUIState> | undefined,
): Promise<void> {
  try {
    const resolution = await resolveConversationOpenAuthoritatively(
      conversationId,
      apiBase,
    );
    updateChat(
      sessionId,
      conversationOpenPatch(resolution, readChat?.(sessionId)),
    );
  } catch {
    onUnavailable();
  }
}

export async function commitConversationOpen({
  resolution,
  open,
  projectName,
  findTab,
  readChat,
  agentName,
}: {
  resolution: ConversationOpenResolution;
  open: (
    conversationId: string,
    agentSlug: string,
    projectSlug?: string,
    projectName?: string,
    model?: string,
    updatedAt?: string,
    acceptedModel?: string,
    execution?: { hydrateMessages: true },
  ) => boolean | Promise<boolean>;
  projectName: (projectSlug: string | undefined) => string | undefined;
  findTab: (conversationId: string) => string | undefined;
  readChat?: (tabId: string) => Partial<ChatUIState> | undefined;
  agentName?: (agentId: string) => string | undefined;
}): Promise<ConversationOpenCommit> {
  const conversation = resolution.conversation;
  if (
    resolution.status === 'missing-session' ||
    resolution.status === 'unavailable'
  ) {
    return {
      kind: 'recovery',
      recovery: { conversation, status: resolution.status },
    };
  }

  const opened = await open(
    conversation.id,
    conversation.agentSlug,
    conversation.projectSlug,
    projectName(conversation.projectSlug),
    conversation.model,
    conversation.updatedAt,
    conversation.acceptedModel,
    { hydrateMessages: true },
  );
  if (!opened) {
    return {
      kind: 'recovery',
      recovery: {
        conversation,
        status: 'unavailable',
      },
    };
  }

  const tabId = findTab(conversation.id);
  if (!tabId) {
    return {
      kind: 'recovery',
      recovery: { conversation, status: 'unavailable' },
    };
  }
  return {
    kind: 'opened',
    tabId,
    patch: conversationOpenPatch(resolution, readChat?.(tabId), {
      agentName:
        resolution.status === 'resolved' && resolution.execution
          ? agentName?.(resolution.execution.agentId)
          : undefined,
    }),
  };
}
