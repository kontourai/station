import { useEffect } from 'react';
import type { ChatUIState } from '../../contexts/active-chats-state';

export interface ConversationOpenRevalidatorProps {
  sessionId: string;
  conversationId: string;
  apiBase: string;
  updateChat: (sessionId: string, patch: Partial<ChatUIState>) => void;
}

/** Re-proves a persisted child binding before the surrounding pane mutates. */
export function ConversationOpenRevalidator({
  sessionId,
  conversationId,
  apiBase,
  updateChat,
}: ConversationOpenRevalidatorProps) {
  useEffect(() => {
    let cancelled = false;
    void import('./conversationOpenController')
      .then(async (controller) => {
        const resolution =
          await controller.resolveConversationOpenAuthoritatively(
            conversationId,
            apiBase,
          );
        if (!cancelled)
          updateChat(sessionId, controller.conversationOpenPatch(resolution));
      })
      .catch(() => {
        if (cancelled) return;
        updateChat(sessionId, {
          conversationOpenPending: false,
          conversationOpenFailed: true,
          currentSessionId: undefined,
          orchestrationSessionStarted: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, conversationId, sessionId, updateChat]);

  return null;
}
