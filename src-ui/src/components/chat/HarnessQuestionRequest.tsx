import { respondToRequest } from '@kontourai/station-sdk/client';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { HarnessQuestionCard } from './HarnessQuestionCard';

export function HarnessQuestionRequest({
  request,
}: {
  request: PendingApprovalRequest;
}) {
  const scope = useHostRequestAuthorityScope();
  const { namespace, status } = useAuthorityPersistence();
  const { questionnaire, approvalId, approvalThreadId, approvalEventId } =
    request;
  if (
    !scope ||
    !questionnaire ||
    !approvalId ||
    !approvalThreadId ||
    !approvalEventId
  )
    return (
      <p role="status">
        Connect to this Station to answer the agent’s questions.
      </p>
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
  const draftKey =
    namespace && status === 'verified'
      ? [namespace, approvalThreadId, approvalId, approvalEventId]
          .map(encodeURIComponent)
          .join(':')
      : undefined;
  return (
    <HarnessQuestionCard
      key={requestKey}
      questionnaire={questionnaire}
      draftKey={draftKey}
      onSubmit={async (answers) => {
        await respondToRequest(
          scope.apiBase,
          {
            threadId: approvalThreadId,
            requestId: approvalId,
            expectedRequestEventId: approvalEventId,
            decision: 'accept',
            answers,
          },
          { requestScope: scope },
        );
      }}
    />
  );
}
