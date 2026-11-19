import { useOrchestrationCommandReceiptsQuery } from '@kontourai/station-sdk';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';

export function useReportedDelegationStart(threadId: string | undefined) {
  const authority = useAuthorityPersistence();
  const enabled = authority.status === 'verified' && Boolean(threadId);
  const receipts = useOrchestrationCommandReceiptsQuery(threadId, { enabled });
  if (!enabled) return null;
  const start = receipts.data?.find((receipt) => {
    // Host lifecycle commands can appear in receipts even when they are
    // outside the client command submission union.
    const commandType: string = receipt.commandType;
    return (
      receipt.threadId === threadId &&
      commandType === 'startSession' &&
      receipt.status === 'accepted'
    );
  });
  return start?.clientOrigin?.reported.surface === 'cli'
    ? 'CLI (reported)'
    : null;
}
