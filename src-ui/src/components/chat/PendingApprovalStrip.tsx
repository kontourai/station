import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { type ToolApprovalOutcome, ToolCallDisplay } from './ToolCallDisplay';

/**
 * #2316: approvals waiting on the user that no transcript row can answer — a
 * Claude subagent's call, a Codex request with no call identity, or a turn
 * whose row the live streaming shell holds. After a reload nothing else on
 * screen could answer them.
 *
 * Deliberately NOT a transcript message: it has no message id, so it never
 * takes the last row's place (and its affordances), and nothing can rate,
 * copy, anchor or fork it. Each card answers its own request, thread and
 * prompt event.
 */
export function PendingApprovalStrip({
  requests,
  onApprove,
}: {
  requests: readonly PendingApprovalRequest[];
  onApprove: (
    request: PendingApprovalRequest,
    action: 'once' | 'trust' | 'deny',
  ) => Promise<ToolApprovalOutcome>;
}) {
  if (requests.length === 0) return null;
  return (
    <section
      className="pending-approvals"
      aria-label="Approvals waiting on you"
    >
      {requests.map((request) => (
        <ToolCallDisplay
          key={`${request.approvalThreadId}\u0000${request.approvalId}`}
          toolCall={request}
          showDetails={false}
          onApprove={(action) => onApprove(request, action)}
        />
      ))}
    </section>
  );
}
