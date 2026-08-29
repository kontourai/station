import type {
  ConversationListItem,
  ConversationOpenResolution,
} from '@kontourai/station-contracts/orchestration';
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
): Partial<ChatUIState> {
  return {
    conversationOpenPending: false,
    conversationOpenFailed: false,
    conversationOpenState: resolution,
    title: resolution.conversation.title,
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
): Promise<void> {
  try {
    const resolution = await resolveConversationOpenAuthoritatively(
      conversationId,
      apiBase,
    );
    updateChat(sessionId, conversationOpenPatch(resolution));
  } catch {
    onUnavailable();
  }
}

export async function commitConversationOpen({
  resolution,
  open,
  projectName,
  findTab,
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
        status:
          resolution.status === 'resolved' ? 'unavailable' : resolution.status,
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
  return { kind: 'opened', tabId, patch: conversationOpenPatch(resolution) };
}
