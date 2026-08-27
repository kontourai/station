import { useConversationsQuery } from '@kontourai/station-sdk';
import {
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';
import { log } from '@/utils/logger';
import { ConversationsContext } from './conversation-context';
import type {
  ConversationData,
  ConversationStatus,
  MessageData,
} from './conversation-types';
import { conversationsStore } from './conversations-store';

function useConversationsContext() {
  const context = useContext(ConversationsContext);
  if (!context) {
    throw new Error(
      'Conversation hooks must be used within ConversationsProvider',
    );
  }
  return context;
}

export function useConversations(agentSlug: string): ConversationData[] {
  const { data, error } = useConversationsQuery(agentSlug);

  if (error) log.api(`Failed to fetch conversations for ${agentSlug}:`, error);

  return (data || []).map((conversation: any) => ({
    ...conversation,
    agentSlug: conversation.resourceId || agentSlug,
  }));
}

// Asserted by proof:repo-governance.
// fallow-ignore-next-line unused-export
export function useMessages(
  apiBase: string,
  agentSlug: string,
  conversationId: string,
  shouldFetch: boolean = true,
): MessageData[] {
  const { fetchMessages } = useConversationsContext();

  const snapshot = useSyncExternalStore(
    conversationsStore.subscribe,
    conversationsStore.getSnapshot,
    conversationsStore.getSnapshot,
  );

  useEffect(() => {
    if (shouldFetch && agentSlug && conversationId) {
      fetchMessages(apiBase, agentSlug, conversationId);
    }
  }, [apiBase, agentSlug, conversationId, shouldFetch, fetchMessages]);

  return snapshot.messages[`messages:${agentSlug}:${conversationId}`] || [];
}

export function useConversationActions() {
  const context = useConversationsContext();
  return {
    fetchMessages: context.fetchMessages,
    deleteConversation: context.deleteConversation,
    refreshMessages: context.refreshMessages,
    setStatus: context.setStatus,
  };
}

export function useConversationStatus(
  agentSlug: string,
  conversationId: string,
) {
  const context = useConversationsContext();

  const snapshot = useSyncExternalStore(
    conversationsStore.subscribe,
    conversationsStore.getSnapshot,
    conversationsStore.getSnapshot,
  );

  const key = `${agentSlug}:${conversationId}`;
  const status = snapshot.statuses[key] || 'idle';

  const setStatus = useCallback(
    (newStatus: ConversationStatus) => {
      context.setStatus(agentSlug, conversationId, newStatus);
    },
    [agentSlug, conversationId, context],
  );

  return { status, setStatus };
}
