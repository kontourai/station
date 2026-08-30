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
    });
    act(() => vi.advanceTimersByTime(79));
    expect(hook.result.current.streamingText).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.streamingText).toBe('ab');
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
});
