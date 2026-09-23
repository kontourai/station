import { toolRequestDisplayName } from '@kontourai/station-shared/tool-request-preview';
import { useEffect, useRef, useState } from 'react';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { type ToolApprovalOutcome, ToolCallDisplay } from './ToolCallDisplay';

const requestKey = (request: PendingApprovalRequest) =>
  `${request.approvalThreadId}\u0000${request.approvalId}`;

/**
 * #2344: what a screen reader hears when a request joins the strip. Each
 * request is announced once, when it first appears: a re-render with the same
 * requests changes nothing, and a request that has been announced is never
 * announced again while it waits. The text sits in a new keyed node per
 * announcement, so two requests for the same tool in a row are both heard
 * (an unchanged text node would not be).
 */
function useNewApprovalAnnouncement(
  requests: readonly PendingApprovalRequest[],
) {
  const announced = useRef(new Set<string>());
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' });
  const keys = requests.map(requestKey).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `keys` is the identity of `requests`; a new array with the same requests must not re-run this.
  useEffect(() => {
    const fresh = requests.filter(
      (request) => !announced.current.has(requestKey(request)),
    );
    // Forget the ones that left, so the set stays the size of the strip.
    announced.current = new Set(requests.map(requestKey));
    if (fresh.length === 0) return;
    const names = fresh.map(
      (request) =>
        toolRequestDisplayName(request.toolName || request.name) || 'a tool',
    );
    setAnnouncement((previous) => ({
      id: previous.id + 1,
      text:
        fresh.length === 1
          ? `Approval needed: ${names[0]}`
          : `${fresh.length} approvals needed: ${names.join(', ')}`,
    }));
  }, [keys]);
  return announcement;
}

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
 *
 * Mounted even while empty: its polite live region has to exist BEFORE the
 * first request arrives, or that request's announcement is not heard.
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
  const announcement = useNewApprovalAnnouncement(requests);
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {announcement.text ? (
          <span key={announcement.id}>{announcement.text}</span>
        ) : null}
      </div>
      {requests.length > 0 && (
        <section
          className="pending-approvals"
          aria-label="Approvals waiting on you"
        >
          {requests.map((request) => (
            <ToolCallDisplay
              key={requestKey(request)}
              toolCall={request}
              showDetails={false}
              onApprove={(action) => onApprove(request, action)}
            />
          ))}
        </section>
      )}
    </>
  );
}
