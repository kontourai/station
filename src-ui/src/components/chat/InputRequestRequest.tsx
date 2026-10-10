import { respondToRequest } from '@kontourai/station-sdk/client';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { InputRequestCard } from './InputRequestCard';

/**
 * #3390: answers one open form request — a harness question or a tool
 * server's elicitation — through the orchestration `respondToRequest`
 * command, pinned to the exact opened event the person saw. The server
 * validates accepted content against that event's form again.
 */
export function InputRequestRequest({
  request,
}: {
  request: PendingApprovalRequest;
}) {
  const scope = useHostRequestAuthorityScope();
  const { namespace, status } = useAuthorityPersistence();
  const { inputRequest, approvalId, approvalThreadId, approvalEventId } =
    request;
  if (
    !scope ||
    !inputRequest ||
    !approvalId ||
    !approvalThreadId ||
    !approvalEventId
  )
    return <p role="status">Connect to this Station to answer this request.</p>;
  const requestKey = [
    scope.apiBase,
    scope.authorityKey,
    approvalThreadId,
    approvalId,
    approvalEventId,
  ]
    .map(encodeURIComponent)
    .join(':');
  // Drafts are kept for an engine's own questions, as they were before
  // #3390, and only under a verified authority namespace. A tool server's
  // form is not drafted: MCP has no way to mark a field private.
  const draftKey =
    inputRequest.source.startsWith('harness:') &&
    namespace &&
    status === 'verified'
      ? [namespace, approvalThreadId, approvalId, approvalEventId]
          .map(encodeURIComponent)
          .join(':')
      : undefined;
  return (
    <InputRequestCard
      key={requestKey}
      form={inputRequest}
      draftKey={draftKey}
      onRespond={async (action, content) => {
        await respondToRequest(
          scope.apiBase,
          {
            threadId: approvalThreadId,
            requestId: approvalId,
            expectedRequestEventId: approvalEventId,
            decision: action,
            ...(action === 'accept' && content ? { content } : {}),
          },
          { requestScope: scope },
        );
      }}
    />
  );
}
