import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useNavigation } from '../contexts/NavigationContext';
import type { FileAttachment } from '../types';
import type { ChatExecutionMetadata } from '../utils/execution';
import { useOpenConversation } from './useActiveChatSessionLifecycle';

export interface ShareTarget {
  conversationId: string;
  agentSlug: string;
  agentName: string;
}

/**
 * Open an existing conversation and seed pre-built attachments into its
 * composer — the "share to this conversation" action behind the picker.
 *
 * This reuses the exact primitives the rest of the dock uses to open a
 * conversation ({@link useOpenConversation}) and to mutate composer state
 * (`updateChat` → `activeChatsStore`), then focuses the dock the same way
 * `useLaunchChat` does. The attachments are appended to whatever the composer
 * already holds so an in-progress draft is never clobbered.
 */
export function useShareToConversation(apiBase: string) {
  const openConversation = useOpenConversation(apiBase);
  const { updateChat } = useActiveChatActions();
  const navigation = useNavigation();

  return useCallback(
    async (
      target: ShareTarget,
      attachments: FileAttachment[],
      execution?: ChatExecutionMetadata,
    ): Promise<string | null> => {
      const sessionId = await openConversation(
        target.conversationId,
        target.agentSlug,
        target.agentName,
        undefined,
        undefined,
        execution,
      );
      // station#1312 review: `openConversation` now reports a failed
      // conversation fetch (`null`) instead of silently opening an empty
      // tab — nothing to share the attachments into.
      if (sessionId === null) return null;

      if (attachments.length > 0) {
        const existing =
          activeChatsStore.getSnapshot()[sessionId]?.attachments ?? [];
        updateChat(sessionId, { attachments: [...existing, ...attachments] });
      }

      navigation.setActiveChat(sessionId);
      navigation.setDockState(true);

      return sessionId;
    },
    [openConversation, updateChat, navigation],
  );
}
