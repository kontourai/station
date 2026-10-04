import { respondToRequest } from '@kontourai/station-sdk/client';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { McpElicitationCard } from './McpElicitationCard';

/**
 * #3284: answers one open tool server form through the orchestration
 * `respondToRequest` command, pinned to the exact opened event the person
 * saw. The server validates accepted content against that form again.
 */
export function McpElicitationRequest({
  request,
}: {
  request: PendingApprovalRequest;
}) {
  const scope = useHostRequestAuthorityScope();
  const { mcpElicitation, approvalId, approvalThreadId, approvalEventId } =
    request;
  if (
    !scope ||
    !mcpElicitation ||
    !approvalId ||
    !approvalThreadId ||
    !approvalEventId
  )
    return (
      <p role="status">Connect to this Station to answer the tool server.</p>
    );
  const requestKey = [
    scope.apiBase,
    scope.authorityKey,
    approvalThreadId,
    approvalId,
    approvalEventId,
  ]
    .map(encodeURIComponent)
    .join(':');
  return (
    <McpElicitationCard
      key={requestKey}
      form={mcpElicitation}
      onRespond={async (action, content) => {
        await respondToRequest(
          scope.apiBase,
          {
            threadId: approvalThreadId,
            requestId: approvalId,
            expectedRequestEventId: approvalEventId,
            decision: action,
            ...(action === 'accept' && content
              ? { elicitationContent: content }
              : {}),
          },
          { requestScope: scope },
        );
      }}
    />
  );
}
