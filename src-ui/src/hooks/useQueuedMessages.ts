import { useCallback, useState } from 'react';
import { useActiveChatActions } from '../contexts/ActiveChatsContext';

export function useQueuedMessages(sessionId: string | null) {
  const {
    removeQueuedMessage,
    editQueuedMessage,
    reorderQueuedMessage,
    updateChat,
  } = useActiveChatActions();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEdit = useCallback(
    (index: number, currentValue: string) => {
      if (!sessionId) return;
      setEditingIndex(index);
      setEditValue(currentValue);
      updateChat(sessionId, { isEditingQueue: true });
    },
    [sessionId, updateChat],
  );

  const cancelEdit = useCallback(() => {
    if (!sessionId) return;
    setEditingIndex(null);
    setEditValue('');
    updateChat(sessionId, { isEditingQueue: false });
  }, [sessionId, updateChat]);

  const saveEdit = useCallback(() => {
    if (!sessionId || editingIndex === null) return;
    if (editValue.trim()) {
      editQueuedMessage(sessionId, editingIndex, editValue.trim());
    } else {
      removeQueuedMessage(sessionId, editingIndex);
    }
    setEditingIndex(null);
    setEditValue('');
    updateChat(sessionId, { isEditingQueue: false });
  }, [
    sessionId,
    editingIndex,
    editValue,
    editQueuedMessage,
    removeQueuedMessage,
    updateChat,
  ]);

  const remove = useCallback(
    (index: number) => {
      if (!sessionId) return;
      removeQueuedMessage(sessionId, index);
    },
    [sessionId, removeQueuedMessage],
  );

  // Boundary-guarded on the real array index (not any display-reversed
  // index a caller might otherwise be tempted to pass — see
  // QueuedMessages.tsx, which reverses the list for display).
  const moveUp = useCallback(
    (index: number) => {
      if (!sessionId || index <= 0) return;
      reorderQueuedMessage(sessionId, index, index - 1);
    },
    [sessionId, reorderQueuedMessage],
  );

  const moveDown = useCallback(
    (index: number, total: number) => {
      if (!sessionId || index >= total - 1) return;
      reorderQueuedMessage(sessionId, index, index + 1);
    },
    [sessionId, reorderQueuedMessage],
  );

  return {
    editingIndex,
    editValue,
    setEditValue,
    startEdit,
    cancelEdit,
    saveEdit,
    remove,
    moveUp,
    moveDown,
  };
}
