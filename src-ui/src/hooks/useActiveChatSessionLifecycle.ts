import { useQueryClient } from '@kontourai/station-sdk';
import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  conversationsStore,
  useConversationActions,
} from '../contexts/ConversationsContext';
import { useNavigation } from '../contexts/NavigationContext';
import type { ChatExecutionMetadata } from '../utils/execution';
import { deriveLatestPlanArtifactFromMessages } from '../utils/planArtifacts';
import { rehydrateChatSession } from './orchestration/rehydrateChatSession';
import { useSendMessage } from './useActiveChatSessionMessaging';
import {
  type ActiveChatConversationMessage,
  normalizeConversationMessages,
  resolveConversationUpdatedAt,
} from './useActiveChatSessions.helpers';

export function useCreateChatSession() {
  const { initChat } = useActiveChatActions();

  return useCallback(
    (
      agentSlug: string,
      agentName: string,
      title?: string,
      projectSlug?: string,
      projectName?: string,
      execution?: ChatExecutionMetadata,
    ) => {
      const sessionId = `${agentSlug}:${Date.now()}`;
      initChat(sessionId, {
        agentSlug,
        agentName,
        title: title || 'New chat',
        projectSlug,
        projectName,
        executionMode: execution?.executionMode,
        executionScope: execution?.executionScope,
        agentConnectionId: execution?.agentConnectionId,
        providerId: execution?.providerId,
        defaultProviderId: execution?.defaultProviderId,
        provider: execution?.provider,
        model: execution?.model,
        modelSource: execution?.modelSource,
        defaultModel: execution?.defaultModel,
        defaultModelSource: execution?.defaultModelSource,
        providerOptions: execution?.providerOptions,
      });
      return sessionId;
    },
    [initChat],
  );
}

/**
 * Resolves the new/reused session id, or `null` when the conversation's
 * messages could not be fetched — station#1312 review: `fetchMessages`
 * swallows its own errors and leaves `messages` as `[]`, so without this
 * check a 404/network failure on an otherwise-valid agent+conversation
 * rehydrated into a live, permanently EMPTY chat tab with no visible error,
 * a regression against the pre-#1297 always-navigate-to-/activity fallback
 * for that population. On failure the just-created tab is torn back down
 * (`removeChat`) so the caller's own fallback (`useChatDockActions`'
 * `openConversation` reporting `false` to the row-open policy, which then
 * navigates to `/activity`) is the only visible outcome, not an orphaned tab
 * sitting alongside it.
 */
export function useOpenConversation(apiBase: string) {
  const { initChat, updateChat, removeChat } = useActiveChatActions();
  const { fetchMessages } = useConversationActions();
  // station#1311 review: resolves the reopened conversation's real
  // server-side `updatedAt` (an explicit inventory value from row-open paths,
  // then the per-agent cache; no network call of its own — see
  // `resolveConversationUpdatedAt`) so reopening an old, already-read
  // conversation doesn't stamp its messages with "now" and jump it to the
  // top of the inbox.
  const queryClient = useQueryClient();

  return useCallback(
    async (
      conversationId: string,
      agentSlug: string,
      agentName: string,
      projectSlug?: string,
      projectName?: string,
      execution?: ChatExecutionMetadata,
      inventoryUpdatedAt?: string,
      /** A newly replay-seeded fork has copied history before its first execution Session. */
      hydrateMessages = false,
    ): Promise<string | null> => {
      // Orchestration events are keyed by provider thread id. Reopening one of
      // those conversations must preserve that identity so recovered events,
      // live SSE frames, and subsequent turns all address the same session.
      const sessionId = execution?.provider
        ? conversationId
        : `${agentSlug}:${Date.now()}`;

      initChat(sessionId, {
        agentSlug,
        agentName,
        title: 'New chat',
        conversationId,
        projectSlug,
        projectName,
        executionMode: execution?.executionMode,
        executionScope: execution?.executionScope,
        agentConnectionId: execution?.agentConnectionId,
        providerId: execution?.providerId,
        defaultProviderId: execution?.defaultProviderId,
        provider: execution?.provider,
        model: execution?.model,
        modelSource: execution?.modelSource,
        defaultModel: execution?.defaultModel,
        defaultModelSource: execution?.defaultModelSource,
        providerOptions: execution?.providerOptions,
        // A replay-seeded fork has a durable Conversation and copied history,
        // but no execution Session until its first divergent turn.
        orchestrationSessionStarted:
          Boolean(execution?.provider) && !hydrateMessages,
      });

      if (execution?.provider && !hydrateMessages) {
        return sessionId;
      }

      const fetched = await fetchMessages(apiBase, agentSlug, conversationId);
      if (!fetched) {
        removeChat(sessionId);
        return null;
      }

      const key = `messages:${agentSlug}:${conversationId}`;
      const messages = conversationsStore.getSnapshot().messages[key] || [];
      const resolvedConversationUpdatedAt = resolveConversationUpdatedAt(
        queryClient,
        agentSlug,
        conversationId,
        inventoryUpdatedAt,
      );
      const normalizedMessages = normalizeConversationMessages(
        messages as ActiveChatConversationMessage[],
        resolvedConversationUpdatedAt,
      );
      const latestPlanArtifact =
        deriveLatestPlanArtifactFromMessages(normalizedMessages as any) ??
        activeChatsStore.getSnapshot()[sessionId]?.planArtifact ??
        null;
      updateChat(sessionId, {
        messages: normalizedMessages,
        planArtifact: latestPlanArtifact,
      });

      return sessionId;
    },
    [apiBase, fetchMessages, initChat, updateChat, removeChat, queryClient],
  );
}

export function useLaunchChat(apiBase: string) {
  const createChatSession = useCreateChatSession();
  const sendMessage = useSendMessage(apiBase);
  const navigation = useNavigation();

  return useCallback(
    async (
      agentSlug: string,
      agentName: string,
      initialMessage?: string,
      projectSlug?: string,
      projectName?: string,
      execution?: ChatExecutionMetadata,
    ) => {
      const sessionId = createChatSession(
        agentSlug,
        agentName,
        undefined,
        projectSlug,
        projectName,
        execution,
      );

      navigation.setActiveChat(sessionId);
      navigation.setDockState(true);

      if (initialMessage?.trim()) {
        await sendMessage(sessionId, agentSlug, undefined, initialMessage);
      }

      return sessionId;
    },
    [createChatSession, navigation, sendMessage],
  );
}

export function useRehydrateSessions(apiBase: string) {
  // station#1225 review (MEDIUM fix): resolved HERE (a real hook boundary)
  // and threaded through — `rehydrateChatSession` itself cannot call
  // `useQueryClient()`, and dropping this silently regressed the
  // `toolMappings` cache-lookup fallback the pre-extraction inline code had
  // (see `rehydrateChatSession.ts`'s file-header note).
  const queryClient = useQueryClient();

  return useCallback(async () => {
    const allChats = activeChatsStore.getSnapshot();
    for (const [sessionId, chat] of Object.entries(allChats)) {
      // station#1225: shared with the reconnect-fallback refetch
      // (`snapshotHandlers.ts`'s `applyOrchestrationSnapshot`) via
      // `rehydrateChatSession` — see that module's header for why this is
      // no longer inlined here.
      await rehydrateChatSession(apiBase, sessionId, chat, { queryClient });
    }
  }, [apiBase, queryClient]);
}
