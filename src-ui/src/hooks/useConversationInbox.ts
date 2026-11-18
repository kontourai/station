import type {
  ConversationInboxEntry,
  ConversationInboxQueuedReceipt,
} from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  cancelConversationInboxEntry,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  listConversationInbox,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  type QueryClient,
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { useOptionalConversationConnection } from '../components/conversation/ConversationConnectionContext';
import type { StationConnection } from '../connections/station-connection';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useConstrainedNetwork } from '../platform/networkCost';
import { subscribeSharedOrchestrationStream } from './orchestration/sharedStreamListeners';

type InboxScope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
interface Cancellation {
  apiBase: string;
  scope: InboxScope;
  client: QueryClient;
  queryKey: readonly unknown[];
  conversationId: string;
  key: string;
}

/** Entries a reader still needs to see: not sent, not withdrawn. */
export function visibleInboxEntries(
  entries: readonly ConversationInboxEntry[] | undefined,
): ConversationInboxEntry[] {
  return (entries ?? []).filter(
    (entry) => entry.state !== 'sent' && entry.state !== 'cancelled',
  );
}

/**
 * How often to read the inbox. Station holds a follow-up only behind a
 * running turn, so while this client sees the conversation working, or the
 * last read showed held messages, it reads every 2s; otherwise a slower read
 * still finds a message another client queued behind a turn this client has
 * not seen start. Turn facts on the event stream and focus/reconnect read
 * again in between.
 */
export const INBOX_ACTIVE_POLL_MS = 2_000;
export const INBOX_IDLE_POLL_MS = 15_000;

/**
 * A read that fails (a phone's network blip, a relay hop, a stalled host) is
 * retried twice before the list reports it lost sight of the entries. While a
 * retry is pending the query keeps its last answer, so the pending list does
 * not flicker between its rows and "Couldn't load" on every missed poll. An
 * authority or absence answer is final and is not retried.
 */
export const INBOX_READ_RETRIES = 2;
export const INBOX_READ_RETRY_DELAY_MS = 400;

function isFinalInboxError(error: unknown): boolean {
  return (
    error instanceof StationHttpError && [401, 403, 404].includes(error.status)
  );
}

function inboxQueryKey(
  scope: { apiBase: string; authorityKey: string } | undefined,
  conversationId: string,
  apiBase = scope?.apiBase,
) {
  return ['conversation-inbox', apiBase, scope?.authorityKey, conversationId];
}

function inboxReceiptsKey(queryKey: readonly unknown[]) {
  return [...queryKey, 'receipts'];
}

function useInboxReceipts(queryKey: readonly unknown[]) {
  return useQuery<ConversationInboxEntry[]>({
    queryKey: inboxReceiptsKey(queryKey),
    queryFn: skipToken,
    gcTime: 0,
  }).data;
}

function withInboxReceipts(
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
  const query = useQuery<ConversationInboxEntry[]>({
    queryKey,
    queryFn: skipToken,
    gcTime: 0,
  });
  const receipts = useInboxReceipts(queryKey);
  return scope?.isCurrent() && !query.isError && !query.isPaused
    ? visibleInboxEntries(withInboxReceipts(query.data, receipts))
    : [];
}

export function useConversationInbox(
  conversationId: string,
  { active = false }: { active?: boolean } = {},
) {
  const hostScope = useHostRequestAuthorityScope();
  const target = useOptionalConversationConnection();
  const scope = target?.requestScope ?? hostScope;
  const apiBase = target?.apiBase ?? scope?.apiBase;
  const constrainedNetwork = useConstrainedNetwork();
  const client = useQueryClient();
  const enabled = Boolean(conversationId && scope?.isCurrent());
  const queryKey = inboxQueryKey(scope, conversationId, apiBase);
  const query = useQuery<ConversationInboxEntry[]>({
    queryKey,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: (failures, error) =>
      failures < INBOX_READ_RETRIES &&
      !isFinalInboxError(error) &&
      Boolean(scope?.isCurrent()),
    retryDelay: INBOX_READ_RETRY_DELAY_MS,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchInterval: (current) =>
      current.state.error instanceof StationHttpError &&
      [401, 403, 404].includes(current.state.error.status)
        ? false
        : active || visibleInboxEntries(current.state.data).length > 0
          ? constrainedNetwork
            ? 10_000
            : INBOX_ACTIVE_POLL_MS
          : INBOX_IDLE_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }): Promise<ConversationInboxEntry[]> => {
      if (!scope?.isCurrent())
        throw new Error('The Station connection changed.');
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
      if (!scope.isCurrent())
        throw new Error('The Station connection changed.');
      if (!signal.aborted && confirmedByThisRead?.length) {
        client.setQueryData<ConversationInboxEntry[]>(receiptsKey, (current) =>
          current?.filter((entry) => !confirmedByThisRead.includes(entry)),
        );
      }
      return entries;
    },
  });
  const receipts = useInboxReceipts(queryKey);
  useEffect(() => {
    if (!scope || !conversationId) return;
    const subscription = subscribeSharedOrchestrationStream(apiBase!, {
      onMessage: (frame) => {
        if (
          frame.event !== SERVER_EVENTS.ORCHESTRATION_INBOX_CHANGED ||
          !scope.isCurrent()
        )
          return;
        let changed: unknown;
        try {
          changed = JSON.parse(frame.data);
        } catch {
          return;
        }
        if (
          !changed ||
          typeof changed !== 'object' ||
          !('conversationId' in changed) ||
          changed.conversationId !== conversationId
        )
          return;
        void client.invalidateQueries({
          queryKey: [
            'conversation-inbox',
            apiBase,
            scope.authorityKey,
            conversationId,
          ],
          exact: true,
        });
      },
    });
    return () => subscription.close();
  }, [scope, apiBase, client, conversationId]);
  const availability =
    !enabled || query.isError || query.isPaused
      ? 'unavailable'
      : query.isSuccess
        ? 'available'
        : 'loading';
  const entries =
    availability === 'unavailable'
      ? undefined
      : withInboxReceipts(query.data, receipts);
  // A failed read keeps TanStack's last successful data; it is not shown (it
  // may be stale), but it says whether there was anything to lose sight of.
  const lostSightOfEntries =
    availability === 'unavailable' &&
    (visibleInboxEntries(query.data).length > 0 ||
      query.data?.some(
        (entry) => entry.kind === 'display' && entry.state === 'sent',
      ) === true);
  const cancellation = useMutation({
    mutationKey: [...queryKey, 'cancel'],
    retry: false,
    mutationFn: async (request: Cancellation) => {
      if (!request.scope.isCurrent())
        throw new Error('The Station connection changed.');
      await request.client.cancelQueries({
        queryKey: request.queryKey,
        exact: true,
      });
      if (!request.scope.isCurrent())
        throw new Error('The Station connection changed.');
      const entry = await cancelConversationInboxEntry(
        request.apiBase,
        request.conversationId,
        request.key,
        {
          requestScope: request.scope,
          requireCredential: request.scope.requiresEnrolledCredential !== false,
          timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
        },
      );
      if (!request.scope.isCurrent())
        throw new Error('The Station connection changed.');
      if (
        entry.conversationId !== request.conversationId ||
        entry.clientTurnId !== request.key
      )
        throw new Error('Station returned a different queued message.');
      return entry;
    },
    onSettled: async (_entry, _error, request) => {
      if (request.scope.isCurrent()) {
        await request.client.cancelQueries({
          queryKey: request.queryKey,
          exact: true,
        });
        if (!request.scope.isCurrent()) return;
        await request.client.invalidateQueries({
          queryKey: request.queryKey,
          exact: true,
        });
      }
    },
  });

  return {
    availability,
    entries,
    lostSightOfEntries,
    refresh: () => {
      if (enabled && scope?.isCurrent())
        void query.refetch({ cancelRefetch: false });
    },
    removing: cancellation.isPending,
    removalError: cancellation.isError,
    remove: async (key: string) => {
      const entry = entries?.find((item) => item.clientTurnId === key);
      if (
        !scope?.isCurrent() ||
        !entry ||
        !['queued', 'unconfirmed', 'refused'].includes(entry.state)
      )
        throw new Error('Read this queued message again before removing it.');
      return cancellation.mutateAsync({
        apiBase: apiBase!,
        scope,
        client,
        queryKey,
        conversationId,
        key,
      });
    },
  };
}
