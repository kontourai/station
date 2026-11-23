import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  cancelConversationInboxEntry,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect } from 'react';
import { useOptionalConversationConnection } from '../components/conversation/ConversationConnectionContext';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useConstrainedNetwork } from '../platform/networkCost';
import { subscribeSharedOrchestrationStream } from './orchestration/sharedStreamListeners';
import {
  inboxQueryFn,
  inboxQueryKey,
  useInboxReceipts,
  visibleInboxEntries,
  withInboxReceipts,
} from './useConversationInboxSnapshot';

export { visibleInboxEntries } from './useConversationInboxSnapshot';

type InboxScope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
interface Cancellation {
  apiBase: string;
  scope: InboxScope;
  client: QueryClient;
  queryKey: readonly unknown[];
  conversationId: string;
  key: string;
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
    queryFn: inboxQueryFn({ client, scope, apiBase, conversationId, queryKey }),
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
  const observedEntries = withInboxReceipts(query.data, receipts);
  const entries = availability === 'unavailable' ? undefined : observedEntries;
  const lostSightOfEntries =
    availability === 'unavailable' &&
    (visibleInboxEntries(observedEntries).length > 0 ||
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
