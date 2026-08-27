import { useCallback, useEffect, useRef, useState } from 'react';
import { activeChatsStore } from '../contexts/ActiveChatsContext';
import type { ChatContentPart } from '../contexts/active-chats-state';

type StreamingState = {
  hasContent: boolean;
  contentParts: ChatContentPart[];
  streamingText: string;
};

const THROTTLE_MS = 80;

/**
 * Hook that subscribes to streaming content.
 * Returns throttled streamingText for markdown rendering
 * and state for completed contentParts.
 */
export function useStreamingContent(sessionId: string) {
  const [state, setState] = useState<StreamingState>({
    hasContent: false,
    contentParts: [],
    streamingText: '',
  });

  // Throttle: track latest value and flush on interval
  const latestStreamingTextRef = useRef('');
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushedRef = useRef('');

  const flushStreamingText = useCallback(() => {
    throttleTimerRef.current = null;
    const text = latestStreamingTextRef.current;
    if (text !== lastFlushedRef.current) {
      lastFlushedRef.current = text;
      setState((prev) =>
        prev.streamingText === text ? prev : { ...prev, streamingText: text },
      );
    }
  }, []);

  useEffect(() => {
    const unsubscribe = activeChatsStore.subscribe(() => {
      const chat = activeChatsStore.getSnapshot()[sessionId];
      const streamingMessage = chat?.streamingMessage;
      const content = streamingMessage?.content || '';
      const contentParts = streamingMessage?.contentParts || [];

      // Calculate text that's already in contentParts
      const textInParts = contentParts
        .filter((p) => p.type === 'text')
        .map((p) => p.content || '')
        .join('');

      const currentStreamingText = content.slice(textInParts.length);
      latestStreamingTextRef.current = currentStreamingText;

      // Schedule throttled flush for streaming text
      if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(flushStreamingText, THROTTLE_MS);
      }

      // Update contentParts and hasContent immediately (these change infrequently)
      const hasContent = content.length > 0 || contentParts.length > 0;
      setState((prev) => {
        if (
          prev.hasContent !== hasContent ||
          prev.contentParts !== contentParts
        ) {
          return { ...prev, hasContent, contentParts };
        }
        return prev;
      });
    });

    return () => {
      unsubscribe();
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, [sessionId, flushStreamingText]);

  return state;
}
