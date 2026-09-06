import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { useStreaming } from '../contexts/StreamingContext';

/** Clear both the stream buffer and its active-chat presentation state. */
export function useStreamingMessage() {
  const { updateChat } = useActiveChatActions();
  const { clearStreamingMessage: clearStreamingMsg } = useStreaming();

  const clearStreamingMessage = useCallback(
    (sessionId: string) => {
      clearStreamingMsg(sessionId);
      updateChat(sessionId, {
        streamingMessage: undefined,
        isProcessingStep: false,
      });
    },
    [clearStreamingMsg, updateChat],
  );

  return { clearStreamingMessage };
}
