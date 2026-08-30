import { useCallback, useEffect, useRef, useState } from 'react';
import { activeChatsStore } from '../contexts/ActiveChatsContext';
import type { ChatContentPart } from '../contexts/active-chats-state';

type StreamingState = {
  hasContent: boolean;
  contentParts: ChatContentPart[];
  streamingText: string;
};

const THROTTLE_MS = 80;

function sameContentParts(
  left: ChatContentPart[],
  right: ChatContentPart[],
): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}

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

      // Orchestration appends every text delta to BOTH `content` and the tail
      // text part. Treat that active tail as the throttled tip rather than
      // publishing its newly allocated part on every token (archive#3351).
      // Providers that retain completed text parts while growing only
      // `content` still use the suffix path.
      const tail = contentParts.at(-1);
      const hasContentSuffix = content.length > textInParts.length;
      const hasActiveTailText =
        !hasContentSuffix && tail?.type === 'text' && Boolean(tail.content);
      const completedContentParts = hasActiveTailText
        ? contentParts.slice(0, -1)
        : contentParts;
      const currentStreamingText = hasContentSuffix
        ? content.slice(textInParts.length)
        : hasActiveTailText
          ? tail.content || ''
          : '';
      latestStreamingTextRef.current = currentStreamingText;

      // Schedule throttled flush for streaming text
      if (!currentStreamingText) {
        if (throttleTimerRef.current) {
          clearTimeout(throttleTimerRef.current);
          throttleTimerRef.current = null;
        }
        lastFlushedRef.current = '';
      } else if (!throttleTimerRef.current) {
        throttleTimerRef.current = setTimeout(flushStreamingText, THROTTLE_MS);
      }

      // Update contentParts and hasContent immediately (these change infrequently)
      const hasContent = content.length > 0 || contentParts.length > 0;
      setState((prev) => {
        const nextContentParts = sameContentParts(
          prev.contentParts,
          completedContentParts,
        )
          ? prev.contentParts
          : completedContentParts;
        const nextStreamingText = currentStreamingText
          ? prev.streamingText
          : '';
        if (
          prev.hasContent !== hasContent ||
          prev.contentParts !== nextContentParts ||
          prev.streamingText !== nextStreamingText
        ) {
          return {
            hasContent,
            contentParts: nextContentParts,
            streamingText: nextStreamingText,
          };
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
