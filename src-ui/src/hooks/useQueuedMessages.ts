import { useCallback, useEffect, useRef, useState } from 'react';
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
  // The chat whose `isEditingQueue` this instance raised and has not lowered.
  const editingSessionIdRef = useRef<string | null>(null);

  // An editor that goes away without Save or Cancel (the list unmounts on a
  // chat switch, and a removed input fires no blur) must not leave the flag
  // behind: the queue neither drains nor sends while it is set. Only the
  // instance that raised it lowers it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; the cleanup reads the chat from the ref.
  useEffect(
    () => () => {
      const editingSessionId = editingSessionIdRef.current;
      if (!editingSessionId) return;
      editingSessionIdRef.current = null;
      setEditingIndex(null);
      setEditValue('');
      updateChat(editingSessionId, { isEditingQueue: false });
    },
    [sessionId, updateChat],
  );

  const startEdit = useCallback(
    (index: number, currentValue: string) => {
      if (!sessionId) return;
      setEditingIndex(index);
      setEditValue(currentValue);
      editingSessionIdRef.current = sessionId;
      updateChat(sessionId, { isEditingQueue: true });
    },
    [sessionId, updateChat],
  );

  const cancelEdit = useCallback(() => {
    if (!sessionId) return;
    setEditingIndex(null);
    setEditValue('');
    editingSessionIdRef.current = null;
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
    editingSessionIdRef.current = null;
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
