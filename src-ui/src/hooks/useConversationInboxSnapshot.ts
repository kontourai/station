import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import {
  hashKey,
  type QueryState,
  skipToken,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { useOptionalConversationConnection } from '../components/conversation/ConversationConnectionContext';
import type { StationConnection } from '../connections/station-connection';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

export type InboxScope = NonNullable<
  ReturnType<typeof useHostRequestAuthorityScope>
>;

/** Entries a reader still needs to see: not sent, not withdrawn. */
export function visibleInboxEntries(
  entries: readonly ConversationInboxEntry[] | undefined,
): ConversationInboxEntry[] {
  return (entries ?? []).filter(
    (entry) => entry.state !== 'sent' && entry.state !== 'cancelled',
  );
}

export function inboxQueryKey(
  scope: { apiBase: string; authorityKey: string } | undefined,
  conversationId: string,
  apiBase = scope?.apiBase,
) {
  return ['conversation-inbox', apiBase, scope?.authorityKey, conversationId];
}

export function inboxReceiptsKey(queryKey: readonly unknown[]) {
  return [...queryKey, 'receipts'];
}

export function useInboxReceipts(queryKey: readonly unknown[]) {
  return useQuery<ConversationInboxEntry[]>({
    queryKey: inboxReceiptsKey(queryKey),
    queryFn: skipToken,
    gcTime: 0,
  }).data;
}

export function withInboxReceipts(
  entries: ConversationInboxEntry[] | undefined,
  receipts: ConversationInboxEntry[] | undefined,
) {
  if (!receipts?.length) return entries;
  return [
    ...(entries ?? []),
    ...receipts.filter(
      (receipt) =>
        !entries?.some((entry) => entry.clientTurnId === receipt.clientTurnId),
    ),
  ];
}

/**
 * The list's inbox query as the cache holds it, without becoming one of its
 * observers. An observer's options replace the query's, so a second observer
 * with no real read (skipToken, or none) could be the one a refetch runs
 * through; a cache subscriber registers nothing. With no list mounted there
 * is no query, and so no entries.
 */
function useInboxQueryState(
  queryKey: readonly unknown[],
): QueryState<ConversationInboxEntry[]> | undefined {
  const client = useQueryClient();
  const queryHash = hashKey(queryKey);
  const subscribe = useCallback(
    (onChange: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === queryHash) onChange();
      }),
    [client, queryHash],
  );
  const read = useCallback(
    () =>
      client.getQueryCache().get<ConversationInboxEntry[]>(queryHash)?.state,
    [client, queryHash],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The entries the pending list shows now, read from the same query without
 * reading the inbox again: for a second view of that list (the chat's
 * context card). Empty while the list's own read has no current answer.
 */
export function useConversationInboxSnapshot(
  conversationId: string,
  connection?: StationConnection | null,
): ConversationInboxEntry[] {
  const hostScope = useHostRequestAuthorityScope();
  const target = useOptionalConversationConnection();
  const scope =
    connection === null
      ? undefined
      : (connection?.requestScope ?? target?.requestScope ?? hostScope);
  const apiBase =
    connection === null
      ? undefined
      : (connection?.targetApiBase ?? target?.apiBase ?? scope?.apiBase);
  const queryKey = inboxQueryKey(scope, conversationId, apiBase);
  const query = useInboxQueryState(queryKey);
  const receipts = useInboxReceipts(queryKey);
  const current =
    connection?.isCurrent() ?? (target?.requestScope ?? hostScope)?.isCurrent();
  return connection !== null &&
    current &&
    query?.status !== 'error' &&
    query?.fetchStatus !== 'paused'
    ? visibleInboxEntries(withInboxReceipts(query?.data, receipts))
    : [];
}
