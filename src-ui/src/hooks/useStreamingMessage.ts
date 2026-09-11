import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';

/** Clear both the stream buffer and its active-chat presentation state. */
export function useStreamingMessage() {
  const { updateChat } = useActiveChatActions();

  const clearStreamingMessage = useCallback(
    (sessionId: string) => {
      updateChat(sessionId, {
        streamingMessage: undefined,
        isProcessingStep: false,
      });
    },
    [updateChat],
  );

  return { clearStreamingMessage };
}
