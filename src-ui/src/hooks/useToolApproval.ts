import { submitToolApproval } from '@kontourai/station-sdk';
import { useCallback } from 'react';
import { log } from '@/utils/logger';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../contexts/ActiveChatsContext';
import { useToast } from '../contexts/ToastContext';

export function useToolApproval(_apiBase: string) {
  const { updateChat } = useActiveChatActions();
  const { dismissToast } = useToast();

  return useCallback(
    async (
      sessionId: string,
      _agentSlug: string,
      approvalId: string,
      toolName: string,
      action: 'once' | 'trust' | 'deny',
    ) => {
      const state = activeChatsStore.getSnapshot()[sessionId];
      if (!state) return;

      const approved = action !== 'deny';

      // Dismiss the toast for this approval
      const toastId = state.approvalToasts?.get(approvalId);
      if (toastId) {
        dismissToast(toastId);
      }

      // Clean up approvalToasts mapping
      if (state.approvalToasts) {
        const newApprovalToasts = new Map(state.approvalToasts);
        newApprovalToasts.delete(approvalId);
        updateChat(sessionId, { approvalToasts: newApprovalToasts });
      }

      // For 'trust', add tool to session-specific autoApprove list
      if (action === 'trust') {
        const sessionAutoApprove = [...(state.sessionAutoApprove || [])];
        if (!sessionAutoApprove.includes(toolName)) {
          sessionAutoApprove.push(toolName);
        }
        updateChat(sessionId, { sessionAutoApprove });
      }

      // Remove from pending approvals
      const pendingApprovals = (state.pendingApprovals || []).filter(
        (id) => id !== approvalId,
      );
      updateChat(sessionId, { pendingApprovals });

      // Update tool call state in streaming message if present
      if (state.streamingMessage?.contentParts) {
        const updatedParts = state.streamingMessage.contentParts.map((part) => {
          if (
            part.type === 'tool-invocation' &&
            part.approvalId === approvalId
          ) {
            return {
              ...part,
              needsApproval: false,
              cancelled: !approved,
              approvalStatus: (action === 'trust'
                ? 'auto-approved'
                : approved
                  ? 'user-approved'
                  : 'user-denied') as
                | 'auto-approved'
                | 'user-approved'
                | 'user-denied',
            };
          }
          return part;
        });

        updateChat(sessionId, {
          streamingMessage: {
            ...state.streamingMessage,
            contentParts: updatedParts,
          },
        });
      }

      // Send approval to backend
      try {
        await submitToolApproval(approvalId, approved);
      } catch (err) {
        log.api('Failed to send tool approval:', err);
      }
    },
    [updateChat, dismissToast],
  );
}
