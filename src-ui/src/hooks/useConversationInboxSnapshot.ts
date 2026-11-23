import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import {
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  listConversationInbox,
} from '@kontourai/station-sdk/client';
import {
  type QueryClient,
  type QueryFunction,
  skipToken,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
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

/**
 * The inbox read. The list and its read-only second reader both register it:
 * an observer's options replace the query's, so a refetch runs whichever
 * function the last observer set, and it must be the real read either way.
 */
export function inboxQueryFn(input: {
  client: QueryClient;
  scope: InboxScope | undefined;
  apiBase: string | undefined;
  conversationId: string;
  queryKey: readonly unknown[];
}): QueryFunction<ConversationInboxEntry[]> {
  const { client, scope, apiBase, conversationId, queryKey } = input;
  return async ({ signal }): Promise<ConversationInboxEntry[]> => {
    if (!scope?.isCurrent()) throw new Error('The Station connection changed.');
    const receiptsKey = inboxReceiptsKey(queryKey);
    const confirmedByThisRead =
      client.getQueryData<ConversationInboxEntry[]>(receiptsKey);
    const entries = await listConversationInbox(apiBase!, conversationId, {
      requestScope: scope,
      requireCredential: scope.requiresEnrolledCredential !== false,
      signal,
      timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
      onHead: (head) => {
        if (!signal.aborted && scope.isCurrent())
          client.setQueryData([...queryKey, 'head'], head);
      },
    });
    if (!scope.isCurrent()) throw new Error('The Station connection changed.');
    if (!signal.aborted && confirmedByThisRead?.length) {
      client.setQueryData<ConversationInboxEntry[]>(receiptsKey, (current) =>
        current?.filter((entry) => !confirmedByThisRead.includes(entry)),
      );
    }
    return entries;
  };
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
  const client = useQueryClient();
  // The real read, not skipToken: when this reader's options are the query's
  // latest, an invalidation refetches through them, and skipToken would be
  // invoked and throw. enabled:false keeps this reader from fetching itself.
  const query = useQuery<ConversationInboxEntry[]>({
    queryKey,
    queryFn: inboxQueryFn({ client, scope, apiBase, conversationId, queryKey }),
    enabled: false,
    gcTime: 0,
  });
  const receipts = useInboxReceipts(queryKey);
  const current =
    connection?.isCurrent() ?? (target?.requestScope ?? hostScope)?.isCurrent();
  return connection !== null && current && !query.isError && !query.isPaused
    ? visibleInboxEntries(withInboxReceipts(query.data, receipts))
    : [];
}
