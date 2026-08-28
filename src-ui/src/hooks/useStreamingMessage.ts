import { useCallback } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';
import { useStreaming } from '../contexts/StreamingContext';

/**
 * archive#3168: this hook previously also exposed `handleStreamEvent`, an
 * AI-SDK-style ('tool-call'/'tool-result'/'text-delta'/…) stream-event
 * dispatcher built on the handler classes under `./streaming/` (including
 * the now-deleted `ToolLifecycleHandler`). It had no production caller —
 * its one consumer, `useActiveChatSessionMessaging.ts`, destructures only
 * `clearStreamingMessage` from this hook's return value — and its `type:
 * 'error'` classification branch duplicated logic that the live
 * orchestration path already covers via the same shared
 * `chatErrorTranslation` module (`turnHandlers.ts`'s `runtime.error`
 * handling). Removed rather than left in place — see archive#3117's
 * removal note on the tests this replaced
 * (`streaming/__tests__/ToolLifecycleHandler.test.ts`, deleted) and
 * `docs/adr/0014-*`, which records every interactive caller routing through
 * `POST /api/orchestration/chat` instead.
 */
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
