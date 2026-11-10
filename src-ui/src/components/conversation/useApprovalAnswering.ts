import type {
  AttentionPeerRequestReference,
  AttentionRequestReference,
} from '@kontourai/station-contracts/attention';
import {
  attentionRequestQueryKey,
  submitToolApproval,
} from '@kontourai/station-sdk';
import {
  inspectAttentionRequest,
  respondToRequest,
  StationRequestAuthorityError,
} from '@kontourai/station-sdk/client';
import { useCallback } from 'react';
import { useActiveChatActions } from '../../contexts/ActiveChatsContext';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useToast } from '../../contexts/ToastContext';
import type { ToolApprovalOutcome } from '../chat/ToolCallDisplay';
import { useOptionalConversationConnection } from './ConversationConnectionContext';
import { createTaskConversationActions } from './task-conversation-actions';

type ToolApprovalAction =
  | 'once'
  | 'trust'
  | 'trust-server'
  | 'trust-rule'
  | 'deny';
type CapturedApprovalAuthority = NonNullable<
  ReturnType<typeof useHostRequestAuthorityScope>
>;

/** The decision an orchestration adapter's `respondToRequest` understands. */
function orchestrationDecisionForToolApproval(
  action: ToolApprovalAction,
): 'accept' | 'acceptForSession' | 'decline' {
  // Same mapping the approval toast uses (`approvalHandlers.ts`): the "Allow
  // <tool> for this session" grant is the adapter's session grant for this
  // tool, not a local list.
  return action === 'once'
    ? 'accept'
    : action === 'trust' || action === 'trust-server' || action === 'trust-rule'
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
 * failure: when the request is no longer open (answered from the toast,
 * closed by the engine, cancelled, or expired), the request itself says so,
 * and the call resolves `already-settled`. That is
 * read from the request's current state, never guessed from the error text.
 * Local bookkeeping (toast, pending list, streaming row) changes only after
 * success; the card itself clears when the durable `request.resolved`
 * arrives.
 */
export function useApprovalAnswering(apiBase: string) {
  const target = useOptionalConversationConnection();
  apiBase = target?.apiBase ?? apiBase;
  const actions = useActiveChatActions(true);
  const updateChat = actions?.updateChat ?? activeChatsStore.updateChat;
  const toast = useToast(true);
  const dismissToast = toast?.dismissToast;

  const assert = useCallback(
    (
      scope: CapturedApprovalAuthority,
      capability: 'approvalAnswer' | 'approvalInspect' | 'inputAnswer',
    ) => {
      if (
        !scope.isCurrent() ||
        (target?.requestScope &&
          (scope.apiBase !== target.requestScope.apiBase ||
            scope.authorityKey !== target.requestScope.authorityKey)) ||
        target?.record?.readOnly ||
        target?.record?.answeringDeniedReason ||
        (target?.station &&
          (!target.station.isCurrent() ||
            target.station.capabilities[capability].state !== 'allowed'))
      )
        throw new StationRequestAuthorityError();
    },
    [target],
  );
  const inspect = useCallback(
    async (
      reference: AttentionRequestReference,
      scope: CapturedApprovalAuthority,
      signal?: AbortSignal,
    ) => {
      assert(scope, 'approvalInspect');
      const result = await inspectAttentionRequest(
        target?.apiBase ?? scope.apiBase,
        reference,
        {
          requestScope: scope,
          signal,
        },
      );
      assert(scope, 'approvalInspect');
      return result;
    },
    [assert, target],
  );
  const exact = useCallback(
    async (
      reference: AttentionRequestReference,
      decision: 'accept' | 'decline',
      scope: CapturedApprovalAuthority,
    ) => {
      assert(scope, 'approvalAnswer');
      const result = await respondToRequest(
        target?.apiBase ?? scope.apiBase,
        {
          threadId: reference.threadId,
          requestId: reference.requestId,
          expectedRequestEventId: reference.requestEventId,
          decision,
        },
        { requestScope: scope },
      );
      assert(scope, 'approvalAnswer');
      return result;
    },
    [assert, target],
  );
  const inspectionKey = useCallback(
    (reference: AttentionRequestReference, scope: CapturedApprovalAuthority) =>
      attentionRequestQueryKey(reference, {
        apiBase: target?.apiBase ?? scope.apiBase,
        authorityKey: target?.station?.runtimeKey ?? scope.authorityKey,
      }),
    [target],
  );
  const task = useCallback(
    (
      reference: AttentionPeerRequestReference,
      decision: 'accept' | 'decline',
      scope: CapturedApprovalAuthority,
    ) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return createTaskConversationActions({
        apiBase: scope.apiBase,
        requestScope: scope,
        capabilities: {
          stop: { state: 'denied', reason: 'permission-required' },
          approvalAnswer: { state: 'allowed' },
        },
      }).answer(reference.taskId, {
        requestId: reference.requestId,
        environmentId: reference.environmentId,
        decision,
      });
    },
    [],
  );

  const input = useCallback(
    (
      reference: AttentionRequestReference,
      decision: 'accept' | 'decline' | 'cancel',
      content: Parameters<typeof respondToRequest>[1]['content'],
      scope: CapturedApprovalAuthority,
    ) => {
      assert(scope, 'inputAnswer');
      return respondToRequest(
        target?.apiBase ?? scope.apiBase,
        {
          threadId: reference.threadId,
          requestId: reference.requestId,
          expectedRequestEventId: reference.requestEventId,
          decision,
          ...(decision === 'accept' && content ? { content } : {}),
        },
        { requestScope: scope },
      );
    },
    [assert, target],
  );
  const taskInput = useCallback(
    (
      reference: AttentionPeerRequestReference & {
        threadId: string;
        requestEventId: string;
      },
      message: string,
      scope: CapturedApprovalAuthority,
    ) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return createTaskConversationActions({
        apiBase: scope.apiBase,
        requestScope: scope,
        capabilities: {
          stop: { state: 'denied', reason: 'permission-required' },
          approvalAnswer: { state: 'denied', reason: 'permission-required' },
          inputAnswer: { state: 'allowed' },
        },
      }).answerInput(reference.taskId, {
        message,
        environmentId: reference.environmentId,
        expectedInputRequest: {
          threadId: reference.threadId,
          requestId: reference.requestId,
          requestEventId: reference.requestEventId,
        },
      });
    },
    [],
  );

  const answer = useCallback(
    async (
      sessionId: string,
      _agentSlug: string,
      approvalId: string,
      toolName: string,
      action: ToolApprovalAction,
      approvalThreadId?: string,
      approvalEventId?: string,
    ): Promise<ToolApprovalOutcome> => {
      const station = target?.station;
      if (target?.record?.readOnly || target?.record?.answeringDeniedReason)
        throw new Error('This session is read only.');
      const capability =
        action === 'trust-server'
          ? 'approvalTrustServer'
          : action === 'trust' || action === 'trust-rule'
            ? 'approvalTrustTool'
            : 'approvalAnswer';
      if (
        station &&
        (!station.isCurrent() ||
          station.capabilities[capability].state !== 'allowed')
      )
        throw new Error('This connection cannot answer this request.');
      const approved = action !== 'deny';
      let outcome: ToolApprovalOutcome = 'answered';

      if (approvalThreadId) {
        // Loaded on demand (entry-chunk budget); a failed load rejects, which
        // the card reports as a decision that did not land.
        const { answerOrchestrationRequest } = await import(
          '../../hooks/orchestration/answerRequest'
        );
        outcome = await answerOrchestrationRequest(apiBase, {
          requestScope: target?.requestScope,
          threadId: approvalThreadId,
          requestId: approvalId,
          requestEventId: approvalEventId,
          decision: orchestrationDecisionForToolApproval(action),
          // The typed choice, never the label: the same `acceptForSession`
          // decision, widened to the whole Station browser server.
          ...(action === 'trust-server'
            ? { sessionGrantScope: 'server' }
            : action === 'trust-rule'
              ? { sessionGrantScope: 'rule' }
              : {}),
        });
      } else {
        if (station && station.routeKind !== 'host')
          throw new Error('This approval needs a current request reference.');
        const result = await submitToolApproval(approvalId, approved);
        if (!result?.success) {
          throw new Error(
            result?.error || 'Station did not accept this approval decision.',
          );
        }
      }

      if (target?.record) {
        target.record.onAnswered?.();
        return outcome;
      }
      const state = activeChatsStore.getSnapshot()[sessionId];
      if (!state) return outcome;

      // Dismiss the toast for this approval
      const toastId = state.approvalToasts?.get(approvalId);
      if (toastId) {
        dismissToast?.(toastId);
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
      const { [approvalId]: _answered, ...pendingApprovalTurnIds } =
        state.pendingApprovalTurnIds ?? {};
      updateChat(sessionId, {
        pendingApprovals,
        pendingApprovalTurnIds,
        ...(outcome === 'answered'
          ? {
              answeredApprovals: [
                ...new Set([...(state.answeredApprovals ?? []), approvalId]),
              ],
            }
          : {}),
      });

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
              approvalStatus: (action === 'trust' ||
              action === 'trust-server' ||
              action === 'trust-rule'
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
    [apiBase, target, updateChat, dismissToast],
  );
  return Object.assign(answer, {
    inspect,
    inspectionKey,
    exact,
    input,
    task,
    taskInput,
    answerAllowed:
      !target?.record?.readOnly &&
      !target?.record?.answeringDeniedReason &&
      (!target?.station ||
        (target.station.isCurrent() &&
          target.station.capabilities.approvalAnswer.state === 'allowed')),
  });
}
