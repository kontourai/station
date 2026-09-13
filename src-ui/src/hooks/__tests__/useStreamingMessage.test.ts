/**
 * @vitest-environment jsdom
 *
 * archive#3168: this hook previously also exposed `handleStreamEvent` (the
 * dead AI-SDK-style stream-event dispatcher removed in the same change —
 * see useStreamingMessage.ts's header comment). These tests covered its
 * `type: 'error'` classification branch and were removed with it; the
 * equivalent live-path error classification is covered by
 * `orchestration/__tests__/turnHandlers*.test.ts`. What remains here is
 * `clearStreamingMessage`, the hook's one production-reachable export.
 *
 * It also used to clear a `StreamingContext` entry. That provider's map was
 * only ever written by `setStreamingMessage`, which had no production
 * caller, so the second clear had nothing to clear; the context is deleted
 * and this asserts the one surviving effect — and that it is the only one.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateChatMock = vi.fn();
vi.mock('../../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: () => ({}) },
  useActiveChatActions: () => ({ updateChat: updateChatMock }),
}));

import { useStreamingMessage } from '../useStreamingMessage';

describe('useStreamingMessage — clearStreamingMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the chat streaming state', () => {
    const { result } = renderHook(() => useStreamingMessage());

    result.current.clearStreamingMessage('session-1');

    expect(updateChatMock).toHaveBeenCalledOnce();
    expect(updateChatMock).toHaveBeenCalledWith('session-1', {
      streamingMessage: undefined,
      isProcessingStep: false,
    });
  });
});
