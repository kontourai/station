import {
  inspectAttentionRequest,
  resolveOrchestrationRequest,
  submitToolApproval,
} from '@kontourai/station-sdk';
import { useCallback } from 'react';
import type { ToolApprovalOutcome } from '../components/chat/ToolCallDisplay';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../contexts/ActiveChatsContext';
import { useToast } from '../contexts/ToastContext';

export type ToolApprovalAction = 'once' | 'trust' | 'deny';

/** The decision an orchestration adapter's `respondToRequest` understands. */
export function orchestrationDecisionForToolApproval(
  action: ToolApprovalAction,
): 'accept' | 'acceptForSession' | 'decline' {
  // Same mapping the approval toast uses (`approvalHandlers.ts`): the "Allow
  // <tool> for this session" grant is the adapter's session grant for this
  // tool, not a local list.
  return action === 'once'
    ? 'accept'
    : action === 'trust'
      ? 'acceptForSession'
      : 'decline';
}

/**
 * The inline approval card's answer.
 *
 * #2316: every card is built from a `request.opened` runtime event (the
 * transcript projection is the only writer of `approvalId`), and its request
 * id lives only in the adapter session that minted it. Claude, ACP, Codex and
 * Station-agent sessions all answer through orchestration `respondToRequest`
 * on that session (the Station-agent adapter resolves its ApprovalRegistry
 * entry from there). The card used to post to `/tool-approval/:id`, which
 * consults only the ApprovalRegistry, so a Claude session's request 404'd and
 * the click did nothing. `approvalThreadId` (the event's own `threadId`) is
 * the discriminator: present → orchestration; absent → the registry route,
 * kept only for a part that does not carry the field.
 *
 * `approvalEventId` (the `request.opened` event id) rides along as
 * `expectedRequestEventId`, so the server answers only the exact prompt the
 * user saw, after verifying it is still open and answerable.
 *
 * Resolves only when the server accepted the decision and REJECTS otherwise
 * (HTTP error, network failure, `success: false`), so the card can say the
 * decision did not land instead of pretending it did. One refusal is not a
 * failure: when the request was ALREADY answered (e.g. from the toast), the
 * request itself says so, and the call resolves `already-settled`. That is
 * read from the request's current state, never guessed from the error text.
 * Local bookkeeping (toast, pending list, streaming row) changes only after
 * success; the card itself clears when the durable `request.resolved`
 * arrives.
 */
export function useToolApproval(apiBase: string) {
  const { updateChat } = useActiveChatActions();
  const { dismissToast } = useToast();

  return useCallback(
    async (
      sessionId: string,
      _agentSlug: string,
      approvalId: string,
      toolName: string,
      action: ToolApprovalAction,
      approvalThreadId?: string,
      approvalEventId?: string,
    ): Promise<ToolApprovalOutcome> => {
      const approved = action !== 'deny';
      let outcome: ToolApprovalOutcome = 'answered';

      if (approvalThreadId) {
        try {
          await resolveOrchestrationRequest({
            apiBase,
            threadId: approvalThreadId,
            requestId: approvalId,
            ...(approvalEventId
              ? { expectedRequestEventId: approvalEventId }
              : {}),
            decision: orchestrationDecisionForToolApproval(action),
          });
        } catch (error) {
          if (
            !approvalEventId ||
            !(await requestAlreadyResolved(apiBase, {
              threadId: approvalThreadId,
              requestId: approvalId,
              requestEventId: approvalEventId,
            }))
          )
            throw error;
          outcome = 'already-settled';
        }
      } else {
        const result = await submitToolApproval(approvalId, approved);
        if (!result?.success) {
          throw new Error(
            result?.error || 'Station did not accept this approval decision.',
          );
        }
      }

      const state = activeChatsStore.getSnapshot()[sessionId];
      if (!state) return outcome;

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

      // Remove from pending approvals
      const pendingApprovals = (state.pendingApprovals || []).filter(
        (id) => id !== approvalId,
      );
      updateChat(sessionId, { pendingApprovals });

      // Which decision settled an already-answered request is not ours to
      // claim; the durable `request.resolved` carries it.
      if (outcome === 'already-settled') return outcome;

      // For 'trust', add tool to session-specific autoApprove list
      if (action === 'trust') {
        const sessionAutoApprove = [...(state.sessionAutoApprove || [])];
        if (!sessionAutoApprove.includes(toolName)) {
          sessionAutoApprove.push(toolName);
        }
        updateChat(sessionId, { sessionAutoApprove });
      }

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
      return outcome;
    },
    [apiBase, updateChat, dismissToast],
  );
}

/**
 * Whether a refused answer was refused because the request is already
 * answered. Any doubt (the read fails, the request changed, it is still open)
 * is `false`, so a genuine failure stays loud.
 */
async function requestAlreadyResolved(
  apiBase: string,
  reference: { threadId: string; requestId: string; requestEventId: string },
): Promise<boolean> {
  try {
    const inspected = await inspectAttentionRequest(apiBase, reference);
    return inspected.state === 'resolved';
  } catch {
    return false;
  }
}
