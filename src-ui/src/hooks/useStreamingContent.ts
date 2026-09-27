import { useCallback, useEffect, useRef, useState } from 'react';
import { activeChatsStore } from '../contexts/ActiveChatsContext';
import type { ChatContentPart } from '../contexts/active-chats-state';

type StreamingState = {
  hasContent: boolean;
  contentParts: ChatContentPart[];
  streamingText: string;
  contentRevision: number;
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

function readStreamingContent(sessionId: string) {
  const streamingMessage =
    activeChatsStore.getSnapshot()[sessionId]?.streamingMessage;
  const content = streamingMessage?.content || '';
  const contentParts = streamingMessage?.contentParts || [];
  let textInPartsLength = 0;
  for (const part of contentParts) {
    if (part.type === 'text') textInPartsLength += part.content?.length ?? 0;
  }
  const tail = contentParts.at(-1);
  const hasContentSuffix = content.length > textInPartsLength;
  const hasActiveTailText =
    !hasContentSuffix && tail?.type === 'text' && Boolean(tail.content);
  return {
    hasContent: content.length > 0 || contentParts.length > 0,
    contentParts: hasActiveTailText ? contentParts.slice(0, -1) : contentParts,
    streamingText: hasContentSuffix
      ? content.slice(textInPartsLength)
      : hasActiveTailText
        ? tail.content || ''
        : '',
  };
}

/**
 * Hook that subscribes to streaming content.
 * Returns throttled streamingText for markdown rendering
 * and state for completed contentParts.
 */
export function useStreamingContent(sessionId: string) {
  const [state, setState] = useState<StreamingState>(() => ({
    ...readStreamingContent(sessionId),
    contentRevision: 0,
  }));

  // Throttle: track latest value and flush on interval
  const latestStreamingTextRef = useRef(state.streamingText);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushedRef = useRef(state.streamingText);

  const flushStreamingText = useCallback(() => {
    throttleTimerRef.current = null;
    const text = latestStreamingTextRef.current;
    if (text !== lastFlushedRef.current) {
      lastFlushedRef.current = text;
      setState((prev) =>
        prev.streamingText === text
          ? prev
          : {
              ...prev,
              streamingText: text,
              contentRevision: prev.contentRevision + 1,
            },
      );
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const {
        hasContent,
        contentParts,
        streamingText: currentStreamingText,
      } = readStreamingContent(sessionId);
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
      setState((prev) => {
        const nextContentParts = sameContentParts(
          prev.contentParts,
          contentParts,
        )
          ? prev.contentParts
          : contentParts;
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
            contentRevision: prev.contentRevision + 1,
          };
        }
        return prev;
      });
    };
    const unsubscribe = activeChatsStore.subscribe(sync);
    sync();

    return () => {
      unsubscribe();
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, [sessionId, flushStreamingText]);

  return state;
}
