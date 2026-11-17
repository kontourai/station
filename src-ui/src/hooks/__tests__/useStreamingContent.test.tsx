/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChatUIState } from '../../contexts/active-chats-state';

const store = vi.hoisted(() => {
  let listener: (() => void) | undefined;
  let snapshot: Record<string, Partial<ChatUIState>> = {};
  return {
    activeChatsStore: {
      getSnapshot: () => snapshot,
      subscribe: (next: () => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    publish(next: Record<string, Partial<ChatUIState>>) {
      snapshot = next;
      listener?.();
    },
    reset() {
      listener = undefined;
      snapshot = {};
    },
  };
});

vi.mock('../../contexts/ActiveChatsContext', () => ({
  activeChatsStore: store.activeChatsStore,
}));

import { useStreamingContent } from '../useStreamingContent';

describe('useStreamingContent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a remounted row immediately reads buffered text from the store', () => {
    store.publish({
      session: {
        streamingMessage: {
          role: 'assistant',
          content: 'already here',
          contentParts: [{ type: 'text', content: 'already here' }],
        },
      },
    });
    const hook = renderHook(() => useStreamingContent('session'));
    expect(hook.result.current.streamingText).toBe('already here');
    expect(hook.result.current.hasContent).toBe(true);
  });

  test('routes per-token orchestration tail parts through the 80ms text flush', () => {
    const hook = renderHook(() => useStreamingContent('session'));

    act(() => {
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'a',
            contentParts: [{ type: 'text', content: 'a' }],
          },
        },
      });
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'ab',
            contentParts: [{ type: 'text', content: 'ab' }],
          },
        },
      });
    });

    expect(hook.result.current).toEqual({
      hasContent: true,
      contentParts: [],
      streamingText: '',
      contentRevision: 1,
    });
    act(() => vi.advanceTimersByTime(79));
    expect(hook.result.current.streamingText).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.streamingText).toBe('ab');
  });

  test('a hidden page renders no streamed text until it is shown', () => {
    let hidden = true;
    const hiddenProperty = vi
      .spyOn(document, 'hidden', 'get')
      .mockImplementation(() => hidden);
    try {
      const hook = renderHook(() => useStreamingContent('session'));
      act(() => {
        store.publish({
          session: {
            streamingMessage: {
              role: 'assistant',
              content: 'while away',
              contentParts: [{ type: 'text', content: 'while away' }],
            },
          },
        });
        vi.advanceTimersByTime(500);
      });
      expect(hook.result.current.streamingText).toBe('');

      hidden = false;
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(hook.result.current.streamingText).toBe('while away');
    } finally {
      hiddenProperty.mockRestore();
    }
  });

  test('a row handed another streaming chat shows that chat and keeps flushing', () => {
    const streaming = (content: string): Partial<ChatUIState> => ({
      streamingMessage: {
        role: 'assistant',
        content,
        contentParts: [{ type: 'text', content }],
      },
    });
    store.publish({ first: streaming('from first'), second: streaming('s') });
    // Mounting mid-stream arms the first chat's 80ms flush.
    const hook = renderHook(({ sessionId }) => useStreamingContent(sessionId), {
      initialProps: { sessionId: 'first' },
    });
    expect(hook.result.current.streamingText).toBe('from first');

    hook.rerender({ sessionId: 'second' });
    expect(hook.result.current.streamingText).toBe('s');

    act(() => {
      store.publish({
        first: streaming('from first'),
        second: streaming('second grows'),
      });
      vi.advanceTimersByTime(80);
    });
    expect(hook.result.current.streamingText).toBe('second grows');
  });

  test('publishes a completed text part immediately at a tool boundary', () => {
    const hook = renderHook(() => useStreamingContent('session'));
    act(() => {
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'done',
            contentParts: [{ type: 'text', content: 'done' }],
          },
        },
      });
      vi.advanceTimersByTime(80);
    });
    expect(hook.result.current.streamingText).toBe('done');

    act(() => {
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'done',
            contentParts: [
              { type: 'text', content: 'done' },
              {
                type: 'tool-invocation',
                toolCallId: 'tool-1',
                toolName: 'verify',
                state: 'running',
              },
            ],
          },
        },
      });
    });

    expect(hook.result.current.streamingText).toBe('');
    expect(hook.result.current.contentParts).toHaveLength(2);
  });

  test('retains completed text parts when content has a separate suffix', () => {
    const hook = renderHook(() => useStreamingContent('session'));
    act(() => {
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'completed tail',
            contentParts: [{ type: 'text', content: 'completed' }],
          },
        },
      });
      vi.advanceTimersByTime(80);
    });

    expect(hook.result.current.contentParts).toEqual([
      { type: 'text', content: 'completed' },
    ]);
    expect(hook.result.current.streamingText).toBe(' tail');
  });

  test('publishes a monotonic cheap revision for part and throttled text growth', () => {
    const hook = renderHook(() => useStreamingContent('session'));
    expect(hook.result.current.contentRevision).toBe(0);

    act(() => {
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'a',
            contentParts: [{ type: 'text', content: 'a' }],
          },
        },
      });
    });
    expect(hook.result.current.contentRevision).toBe(1);

    act(() => vi.advanceTimersByTime(80));
    expect(hook.result.current.contentRevision).toBe(2);

    act(() => {
      store.publish({
        session: {
          streamingMessage: {
            role: 'assistant',
            content: 'a',
            contentParts: [
              { type: 'text', content: 'a' },
              { type: 'tool-invocation', toolCallId: 'tool-1' },
            ],
          },
        },
      });
    });
    expect(hook.result.current.contentRevision).toBe(3);
  });
});
