import { toolRequestIsPlanReview } from '@kontourai/station-shared/tool-request-preview';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import type { PendingApprovalRequest } from '../../hooks/orchestration/pendingRequestRows';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { useApprovalAnswering } from '../conversation/useApprovalAnswering';
import { InputRequestCard } from './InputRequestCard';
import { InputRequestUrlCard } from './InputRequestUrlCard';

/**
 * #3390: answers one open form request — a harness question or a tool
 * server's elicitation — through the orchestration `respondToRequest`
 * command, pinned to the exact opened event the person saw. The server
 * validates accepted content against that event's form again.
 *
 * A link request (an MCP sign-in page, a URL-mode elicitation) goes the same
 * way with no content: `accept` once the person opened it, or `cancel`.
 */
export function InputRequestRequest({
  request,
}: {
  request: PendingApprovalRequest;
}) {
  const host = useHostRequestAuthorityScope();
  const target = useOptionalConversationConnection();
  const scope = target?.requestScope ?? host;
  const apiBase = target?.apiBase ?? scope?.apiBase;
  const answer = useApprovalAnswering(apiBase ?? '');
  const { namespace, status } = useAuthorityPersistence();
  const {
    inputRequest,
    inputRequestUrl,
    approvalId,
    approvalThreadId,
    approvalEventId,
    approvalToolName,
  } = request;
  if (
    target?.record?.readOnly ||
    target?.record?.answeringDeniedReason ||
    (target?.station &&
      (!target.station.isCurrent() ||
        target.station.capabilities.inputAnswer.state !== 'allowed')) ||
    !scope ||
    (!inputRequest && !inputRequestUrl) ||
    !approvalId ||
    !approvalThreadId ||
    !approvalEventId
  )
    return (
      <p role="status">
        {target?.record?.answeringDeniedReason ??
          'Connect to this Station to answer this request.'}
      </p>
    );
  const requestKey = [
    apiBase!,
    scope.authorityKey,
    approvalThreadId,
    approvalId,
    approvalEventId,
  ]
    .map(encodeURIComponent)
    .join(':');
  if (!inputRequest)
    return inputRequestUrl ? (
      <InputRequestUrlCard
        key={requestKey}
        request={inputRequestUrl}
        onRespond={async (action) => {
          if (target?.record?.readOnly)
            throw new Error('This session is read only.');
          await answer.input(
            {
              threadId: approvalThreadId,
              requestId: approvalId,
              requestEventId: approvalEventId,
            },
            action,
            undefined,
            scope,
          );
          target?.record?.onAnswered?.();
        }}
      />
    ) : null;
  // Drafts are kept for an engine's own questions, as they were before
  // #3390, and only under a verified authority namespace. A tool server's
  // form is not drafted: MCP has no way to mark a field private.
  const draftKey =
    inputRequest.source.startsWith('harness:') &&
    namespace &&
    status === 'verified'
      ? [
          target?.station?.stationKey ?? namespace,
          approvalThreadId,
          approvalId,
          approvalEventId,
        ]
          .map(encodeURIComponent)
          .join(':')
      : undefined;
  return (
    <InputRequestCard
      key={requestKey}
      form={inputRequest}
      draftKey={draftKey}
      planReview={toolRequestIsPlanReview(approvalToolName)}
      onRespond={async (action, content) => {
        if (target?.record?.readOnly)
          throw new Error('This session is read only.');
        await answer.input(
          {
            threadId: approvalThreadId,
            requestId: approvalId,
            requestEventId: approvalEventId,
          },
          action,
          content,
          scope,
        );
        target?.record?.onAnswered?.();
      }}
    />
  );
}
