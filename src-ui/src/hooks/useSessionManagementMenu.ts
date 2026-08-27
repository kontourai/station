import {
  useDeleteConversationMutation,
  useRegenerateConversationTitleMutation,
  useRenameConversationMutation,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { log } from '../utils/logger';

interface Conversation {
  id: string;
  agentSlug: string;
  agentName?: string;
  title?: string;
  updatedAt: string;
  mutable?: boolean;
  metadata?: {
    titleSource?: string;
    stats?: {
      turns?: number;
      totalTokens?: number;
      contextWindowPercentage?: number;
    };
  };
}

interface Session {
  id: string;
  conversationId: string;
  agentSlug: string;
}

interface Agent {
  slug: string;
  name: string;
}

interface UseSessionManagementMenuOptions {
  sessions: Session[];
  agents: Agent[];
  onTitleUpdate: (sessionId: string, newTitle: string) => void;
  onDelete: (sessionId: string) => void;
}

export function useSessionManagementMenu({
  sessions,
  onTitleUpdate,
  onDelete,
}: UseSessionManagementMenuOptions) {
  const { showToast } = useToast();
  const renameConversationMutation = useRenameConversationMutation();
  const regenerateTitleMutation = useRegenerateConversationTitleMutation();
  const deleteConversationMutation = useDeleteConversationMutation();

  const [isOpen, setIsOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [actionError, setActionError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    conv: Conversation;
  } | null>(null);
  const [regenerateConfirm, setRegenerateConfirm] = useState<{
    conv: Conversation;
  } | null>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);

  const handleRename = useCallback(
    async (conv: Conversation) => {
      if (conv.mutable === false) return;
      if (!newTitle.trim() || newTitle === conv.title) {
        setRenamingId(null);
        return;
      }

      try {
        setActionError(null);
        await renameConversationMutation.mutateAsync({
          agentSlug: conv.agentSlug,
          conversationId: conv.id,
          title: newTitle.trim(),
        });
        const activeSession = sessions.find(
          (s) => s.conversationId === conv.id,
        );
        if (activeSession) {
          onTitleUpdate(activeSession.id, newTitle.trim());
        }
        setRenamingId(null);
      } catch (error) {
        log.api('Failed to rename conversation:', error);
        setActionError({
          id: conv.id,
          message:
            error instanceof Error
              ? error.message
              : 'Failed to rename conversation',
        });
      }
    },
    [renameConversationMutation, sessions, onTitleUpdate, newTitle],
  );

  const handleDelete = useCallback((conv: Conversation) => {
    if (conv.mutable === false) return;
    setDeleteConfirm({ conv });
  }, []);

  const handleRegenerateTitle = useCallback(
    async (conv: Conversation) => {
      if (conv.mutable === false) return;
      if (conv.metadata?.titleSource === 'user') {
        setRegenerateConfirm({ conv });
        return;
      }
      setActionError(null);
      try {
        await regenerateTitleMutation.mutateAsync({
          agentSlug: conv.agentSlug,
          conversationId: conv.id,
        });
      } catch (error) {
        log.api('Failed to regenerate conversation title:', error);
        setActionError({
          id: conv.id,
          message:
            error instanceof Error
              ? error.message
              : 'Failed to regenerate conversation title',
        });
      }
    },
    [regenerateTitleMutation],
  );

  const confirmRegenerateTitle = useCallback(async () => {
    if (!regenerateConfirm) return;
    const conv = regenerateConfirm.conv;
    setRegenerateConfirm(null);
    setActionError(null);
    try {
      await regenerateTitleMutation.mutateAsync({
        agentSlug: conv.agentSlug,
        conversationId: conv.id,
        replaceManualTitle: true,
      });
    } catch (error) {
      log.api('Failed to regenerate conversation title:', error);
      setActionError({
        id: conv.id,
        message:
          error instanceof Error
            ? error.message
            : 'Failed to regenerate conversation title',
      });
    }
  }, [regenerateConfirm, regenerateTitleMutation]);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    const conv = deleteConfirm.conv;
    setDeleteConfirm(null);

    try {
      await deleteConversationMutation.mutateAsync({
        agentSlug: conv.agentSlug,
        conversationId: conv.id,
      });
      const activeSession = sessions.find((s) => s.conversationId === conv.id);
      if (activeSession) {
        onDelete(activeSession.id);
      }
    } catch (error) {
      log.api('Failed to delete conversation:', error);
      showToast('Failed to delete conversation. Check console for details.');
    }
  }, [
    deleteConfirm,
    deleteConversationMutation,
    sessions,
    onDelete,
    showToast,
  ]);

  const clearAll = useCallback(
    async (conversations: Conversation[]) => {
      setShowClearAllConfirm(false);

      try {
        for (const conv of conversations.filter(
          (conversation) => conversation.mutable !== false,
        )) {
          await deleteConversationMutation.mutateAsync({
            agentSlug: conv.agentSlug,
            conversationId: conv.id,
          });

          const activeSession = sessions.find(
            (s) => s.conversationId === conv.id,
          );
          if (activeSession) {
            onDelete(activeSession.id);
          }
        }
      } catch (error) {
        log.api('Failed to clear all conversations:', error);
        showToast(
          'Failed to clear all conversations. Check console for details.',
        );
      }
    },
    [deleteConversationMutation, sessions, onDelete, showToast],
  );

  const startRename = useCallback((conv: Conversation) => {
    if (conv.mutable === false) return;
    setRenamingId(conv.id);
    setNewTitle(conv.title || '');
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  const cancelDelete = useCallback(() => {
    setDeleteConfirm(null);
  }, []);

  const cancelRegenerateTitle = useCallback(() => {
    setRegenerateConfirm(null);
  }, []);

  return {
    isOpen,
    setIsOpen,
    renamingId,
    newTitle,
    setNewTitle,
    deleteConfirm,
    regenerateConfirm,
    showClearAllConfirm,
    setShowClearAllConfirm,
    inputRef,
    handleRename,
    handleDelete,
    confirmDelete,
    cancelDelete,
    confirmRegenerateTitle,
    cancelRegenerateTitle,
    clearAll,
    startRename,
    cancelRename,
    handleRegenerateTitle,
    actionError,
  };
}
