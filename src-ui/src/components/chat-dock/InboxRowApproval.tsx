import { fetchAttention } from '@kontourai/station-sdk';
import { StationRequestAuthorityError } from '@kontourai/station-sdk/client';
import { useQuery } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { ExactRequestInline } from '../attention/ExactRequestInline';

/** The inbox row can address only an exact approval for its own execution. */
export default function InboxRowApproval({ threadId }: { threadId: string }) {
  const scope = useHostRequestAuthorityScope();
  const attention = useQuery({
    queryKey: [
      'inbox-approval-references',
      scope?.apiBase,
      scope?.authorityKey,
    ],
    queryFn: ({ signal }) => {
      if (!scope?.isCurrent()) throw new StationRequestAuthorityError();
      return fetchAttention(scope.apiBase, { requestScope: scope, signal });
    },
    enabled: scope?.isCurrent() === true,
    refetchInterval: 10_000,
  });
  if (!scope?.isCurrent() || attention.isError) return null;
  const approvals = attention.data?.items.filter(
    (item) =>
      item.kind === 'approval' && item.requestReference?.threadId === threadId,
  );
  const approval = approvals?.length === 1 ? approvals[0] : undefined;
  if (approval?.kind !== 'approval' || !approval.requestReference) return null;
  return (
    <ExactRequestInline reference={approval.requestReference} conversationRow />
  );
}
