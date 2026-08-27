import { useQueryClient } from '@kontourai/station-sdk';
import { type ReactNode, useCallback, useMemo } from 'react';
import { ConversationsContext } from './conversation-context';
import type { ConversationsContextType } from './conversation-types';
import { conversationsStore } from './conversations-store';

export * from './conversation-hooks';
export type * from './conversation-types';
export * from './conversations-store';

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const fetchMessages = useCallback<ConversationsContextType['fetchMessages']>(
    (apiBase, agentSlug, conversationId) =>
      conversationsStore.fetchMessages(
        apiBase,
        agentSlug,
        conversationId,
        queryClient,
      ),
    [queryClient],
  );

  const refreshMessages = useCallback<
    ConversationsContextType['refreshMessages']
  >(
    (apiBase, agentSlug, conversationId) =>
      conversationsStore.refreshMessages(
        apiBase,
        agentSlug,
        conversationId,
        queryClient,
      ),
    [queryClient],
  );

  const deleteConversation = useCallback<
    ConversationsContextType['deleteConversation']
  >(
    (apiBase, agentSlug, conversationId) =>
      conversationsStore.deleteConversation(apiBase, agentSlug, conversationId),
    [],
  );

  const setStatus = useCallback<ConversationsContextType['setStatus']>(
    (agentSlug, conversationId, status) => {
      conversationsStore.setStatus(agentSlug, conversationId, status);
    },
    [],
  );

  // station#3796: one memoised value per provider — a fresh object literal
  // here republishes the context to every consumer on any render of this
  // provider, whatever the render was actually about.
  const value = useMemo(
    () => ({ fetchMessages, refreshMessages, deleteConversation, setStatus }),
    [fetchMessages, refreshMessages, deleteConversation, setStatus],
  );

  return (
    <ConversationsContext.Provider value={value}>
      {children}
    </ConversationsContext.Provider>
  );
}
