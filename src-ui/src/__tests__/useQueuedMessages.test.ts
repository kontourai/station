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

describe('useQueuedMessages — abandoned edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lowers isEditingQueue when the editor unmounts mid-edit', () => {
    const { result, unmount } = renderHook(() =>
      useQueuedMessages('session-1'),
    );
    act(() => {
      result.current.startEdit(0, 'draft');
    });
    expect(updateChatMock).toHaveBeenLastCalledWith('session-1', {
      isEditingQueue: true,
    });

    unmount();

    expect(updateChatMock).toHaveBeenLastCalledWith('session-1', {
      isEditingQueue: false,
    });
  });

  it('lowers it on the chat it was raised for when the list is handed another chat', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useQueuedMessages(sessionId),
      { initialProps: { sessionId: 'session-1' } },
    );
    act(() => {
      result.current.startEdit(1, 'draft');
    });

    rerender({ sessionId: 'session-2' });

    expect(updateChatMock).toHaveBeenLastCalledWith('session-1', {
      isEditingQueue: false,
    });
    expect(result.current.editingIndex).toBeNull();
  });

  it('leaves the flag alone when this instance never raised it, or already lowered it', () => {
    const idle = renderHook(() => useQueuedMessages('session-1'));
    idle.unmount();
    expect(updateChatMock).not.toHaveBeenCalled();

    const cancelled = renderHook(() => useQueuedMessages('session-1'));
    act(() => {
      cancelled.result.current.startEdit(0, 'draft');
    });
    act(() => {
      cancelled.result.current.cancelEdit();
    });
    updateChatMock.mockClear();
    cancelled.unmount();
    expect(updateChatMock).not.toHaveBeenCalled();
  });
});
