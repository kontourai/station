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

function readStreamingContent(
  sessionId: string,
): Omit<StreamingState, 'contentRevision'> {
  const message = activeChatsStore.getSnapshot()[sessionId]?.streamingMessage;
  const content = message?.content || '';
  const parts = message?.contentParts || [];
  // Orchestration appends each text delta to both `content` and its tail
  // part. Treat that tail as the streaming tip; providers that grow only
  // `content` use the suffix after completed text parts (archive#3351).
  const textInPartsLength = parts.reduce(
    (length, part) =>
      length + (part.type === 'text' ? (part.content?.length ?? 0) : 0),
    0,
  );
  const tail = parts.at(-1);
  const hasContentSuffix = content.length > textInPartsLength;
  const hasActiveTailText =
    !hasContentSuffix && tail?.type === 'text' && Boolean(tail.content);
  return {
    hasContent: content.length > 0 || parts.length > 0,
    contentParts: hasActiveTailText ? parts.slice(0, -1) : parts,
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
  const [state, setState] = useState<StreamingState>(() => {
    return {
      // A remounted row must show the already-buffered answer immediately.
      // The 80 ms throttle applies only to new deltas received while mounted.
      ...readStreamingContent(sessionId),
      contentRevision: 0,
    };
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
    const onStoreChange = () => {
      // Both the mount seed and live subscription use the same text/part
      // split, including provider tails that grow only `content`.
      const {
        hasContent,
        contentParts: completedContentParts,
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
            contentRevision: prev.contentRevision + 1,
          };
        }
        return prev;
      });
    };
    const unsubscribe = activeChatsStore.subscribe(onStoreChange);
    // Close the gap between the render-time seed and the subscription.
    onStoreChange();

    return () => {
      unsubscribe();
      if (throttleTimerRef.current) clearTimeout(throttleTimerRef.current);
    };
  }, [sessionId, flushStreamingText]);

  return state;
}
