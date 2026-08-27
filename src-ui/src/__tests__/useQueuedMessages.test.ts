/**
 * @vitest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const removeQueuedMessageMock = vi.fn();
const editQueuedMessageMock = vi.fn();
const reorderQueuedMessageMock = vi.fn();
const updateChatMock = vi.fn();

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({
    removeQueuedMessage: removeQueuedMessageMock,
    editQueuedMessage: editQueuedMessageMock,
    reorderQueuedMessage: reorderQueuedMessageMock,
    updateChat: updateChatMock,
  }),
}));

import { useQueuedMessages } from '../hooks/useQueuedMessages';

describe('useQueuedMessages — reorder (#613)', () => {
  const sessionId = 'session-1';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('moveUp swaps a message with its predecessor via reorderQueuedMessage(index, index-1)', () => {
    const { result } = renderHook(() => useQueuedMessages(sessionId));

    act(() => {
      result.current.moveUp(2);
    });

    expect(reorderQueuedMessageMock).toHaveBeenCalledWith(sessionId, 2, 1);
  });

  it('moveUp is a no-op at the top boundary (index 0)', () => {
    const { result } = renderHook(() => useQueuedMessages(sessionId));

    act(() => {
      result.current.moveUp(0);
    });

    expect(reorderQueuedMessageMock).not.toHaveBeenCalled();
  });

  it('moveDown swaps a message with its successor via reorderQueuedMessage(index, index+1)', () => {
    const { result } = renderHook(() => useQueuedMessages(sessionId));

    act(() => {
      result.current.moveDown(0, 3);
    });

    expect(reorderQueuedMessageMock).toHaveBeenCalledWith(sessionId, 0, 1);
  });

  it('moveDown is a no-op at the bottom boundary (index === total - 1)', () => {
    const { result } = renderHook(() => useQueuedMessages(sessionId));

    act(() => {
      result.current.moveDown(2, 3);
    });

    expect(reorderQueuedMessageMock).not.toHaveBeenCalled();
  });

  it('moveUp/moveDown are no-ops without a sessionId', () => {
    const { result } = renderHook(() => useQueuedMessages(null));

    act(() => {
      result.current.moveUp(1);
      result.current.moveDown(0, 3);
    });

    expect(reorderQueuedMessageMock).not.toHaveBeenCalled();
  });
});
