import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ChatStreamStatus } from '../../hooks/orchestration/useChatStreamStatus';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import type { ChatSession } from '../../types';
import { LazyBoundary } from '../LazyBoundary';
import {
  claimApprovalThreads,
  OPEN_APPROVAL_QUEUE_EVENT,
  revealApprovalCard,
} from '../status/approvalReveal';
import type { ChatStatusInput } from '../status/chatStatus';

// The pill's derivation and rendering load on demand, outside the entry
// chunk, and are warmed as soon as a chat pane mounts.
const loadChatStatusPillView = () =>
  import('../status/ChatStatusPillView').then((module) => ({
    default: module.ChatStatusPillView,
  }));

/**
 * The chat pane's floating status pill, derived from the chat's own record
 * (`deriveChatStatus`). While it presents this chat's approvals it claims the
 * chat's threads, so the app-wide approval queue does not float a second copy
 * of the same decision over the pane.
 */
export function useChatStatusPill({
  activeSession,
  streamStatus,
  turnLive,
  enabled,
}: {
  activeSession: ChatSession;
  streamStatus: ChatStreamStatus | undefined;
  turnLive: boolean;
  enabled: boolean;
}) {
  const pendingApprovals = activeSession.pendingApprovals ?? [];
  const approvalCount = pendingApprovals.length;
  const input: ChatStatusInput = {
    approvalCount,
    stream: streamStatus,
    turnLive,
    waitingOnUser:
      activeSession.orchestrationStatus === 'awaiting-approval' &&
      approvalCount === 0,
    activity: activeSession.conversationActivity,
    activityHint: activeSession.activityHint,
    turnStartedAt: activeSession.openTurnStartedAt,
  };
  useEffect(() => {
    if (enabled) void loadChatStatusPillView().catch(() => undefined);
  }, [enabled]);

  const threadIds = useMemo(
    () =>
      [
        activeSession.id,
        activeSession.conversationId,
        activeSession.currentSessionId,
        activeSession.conversationActivity?.openTurn?.threadId,
      ].filter((id): id is string => Boolean(id)),
    [
      activeSession.id,
      activeSession.conversationId,
      activeSession.currentSessionId,
      activeSession.conversationActivity?.openTurn?.threadId,
    ],
  );
  // Approval is the pill's highest priority: any pending one is what it shows.
  const presentingApproval = enabled && approvalCount > 0;
  useEffect(() => {
    if (!presentingApproval) return;
    return claimApprovalThreads(threadIds);
  }, [presentingApproval, threadIds]);

  // Each tap goes to the next of this chat's requests, so every one of them
  // is reachable from the pill; one that cannot be brought on screen opens
  // the queue, which then lists every request.
  const next = useRef(0);
  const requestKey = pendingApprovals.join('\u0000');
  const latestRequests = useRef(pendingApprovals);
  latestRequests.current = pendingApprovals;
  const onRevealApproval = useCallback(() => {
    const requests = latestRequests.current;
    if (requests.length === 0) return;
    const requestId = requests[next.current % requests.length]!;
    next.current += 1;
    void revealApprovalCard({ requestId }).then((shown) => {
      if (!shown) window.dispatchEvent(new Event(OPEN_APPROVAL_QUEUE_EVENT));
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new request set restarts the cycle.
  useEffect(() => {
    next.current = 0;
  }, [requestKey]);

  if (!enabled) return null;
  return (
    <LazyBoundary
      load={loadChatStatusPillView}
      shareAcrossMounts
      pending={null}
      unavailable={() => null}
      componentProps={{
        input,
        onRevealApproval,
        onRepair: () => openConnectionsModal({ mode: 'request-access' }),
      }}
    />
  );
}
