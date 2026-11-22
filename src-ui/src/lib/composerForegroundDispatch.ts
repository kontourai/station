import type {
  ConversationInboxEntry,
  ConversationInboxQueuedReceipt,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { isFirstSendFailure } from '@kontourai/station-contracts/session-attention';
import { orchestrationQueries } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import type { QueryClient } from '@tanstack/react-query';
import {
  type InboxScope,
  inboxQueryKey,
  inboxReceiptsKey,
} from '../hooks/useConversationInboxSnapshot';

export {
  dispatchForeground,
  dispatchPossiblyQueuedForeground,
  dispatchQueuedForeground,
} from './foregroundMessageDispatch';

export function publishConversationInboxReceipt(
  client: QueryClient,
  scope: InboxScope | undefined,
  apiBase: string,
  receipt: ConversationInboxQueuedReceipt,
) {
  if (!scope?.isCurrent() || scope.apiBase !== apiBase) return;
  const { entry, conversationId, clientTurnId } = receipt;

  const queryKey = inboxQueryKey(scope, conversationId, apiBase);
  const receiptsKey = inboxReceiptsKey(queryKey);
  if (client.getQueryState(receiptsKey)) {
    client.setQueryData<ConversationInboxEntry[]>(receiptsKey, (previous) => [
      ...(previous ?? []).filter((item) => item.clientTurnId !== clientTurnId),
      // The receipt confirms custody. The list read owns queue order.
      { ...entry, position: undefined },
    ]);
  }
  void client.invalidateQueries(
    { queryKey, exact: true },
    { cancelRefetch: false },
  );
}

/**
 * #2310 review H1/F4: whether the cached session list still describes one of
 * these identities as having never taken a send — a Draft, or a Failed row
 * whose only failure is that its sends did not take (`send_refused` /
 * `send_failed`). Either answer is stale the moment a send is accepted, so
 * the send path must re-read the list. Read-only; `undefined` ids skipped.
 */
export function cachedSummaryAwaitsFirstTurn(
  queryClient: QueryClient,
  ids: ReadonlyArray<string | undefined>,
  scope?: ApiRequestScope,
): boolean {
  const wanted = new Set(ids.filter((id): id is string => Boolean(id)));
  const cached =
    queryClient.getQueryData<OrchestrationSessionSummary[]>(
      orchestrationQueries.sessions(scope).queryKey,
    ) ?? [];
  return cached.some(
    (session) =>
      (wanted.has(session.threadId) ||
        (session.conversationId !== undefined &&
          wanted.has(session.conversationId))) &&
      (session.draft === true || isFirstSendFailure(session)),
  );
}
