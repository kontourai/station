import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
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
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

type InboxScope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
interface Cancellation {
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

function inboxQueryKey(
  scope: ReturnType<typeof useHostRequestAuthorityScope>,
  conversationId: string,
) {
  return [
    'conversation-inbox',
    scope?.apiBase,
    scope?.authorityKey,
    conversationId,
  ];
}

/**
 * The entries the pending list shows now, read from the same query without
 * reading the inbox again: for a second view of that list (the chat's
 * context card). Empty while the list's own read has no current answer.
 */
export function useConversationInboxSnapshot(
  conversationId: string,
): ConversationInboxEntry[] {
  const scope = useHostRequestAuthorityScope();
  const query = useQuery<ConversationInboxEntry[]>({
    queryKey: inboxQueryKey(scope, conversationId),
    queryFn: skipToken,
    gcTime: 0,
  });
  return query.status === 'success' && query.fetchStatus !== 'paused'
    ? visibleInboxEntries(query.data)
    : [];
}

export function useConversationInbox(
  conversationId: string,
  { active = false }: { active?: boolean } = {},
) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const enabled = Boolean(conversationId && scope?.isCurrent());
  const queryKey = inboxQueryKey(scope, conversationId);
  const query = useQuery<ConversationInboxEntry[]>({
    queryKey,
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    refetchInterval: (current) =>
      current.state.error instanceof StationHttpError &&
      [401, 403, 404].includes(current.state.error.status)
        ? false
        : active || visibleInboxEntries(current.state.data).length > 0
          ? INBOX_ACTIVE_POLL_MS
          : INBOX_IDLE_POLL_MS,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }): Promise<ConversationInboxEntry[]> => {
      if (!scope?.isCurrent())
        throw new Error('The Station connection changed.');
      const entries = await listConversationInbox(
        scope.apiBase,
        conversationId,
        {
          requestScope: scope,
          requireCredential: scope.requiresEnrolledCredential !== false,
          signal,
          timeoutMs: DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
        },
      );
      if (!scope.isCurrent())
        throw new Error('The Station connection changed.');
      return entries;
    },
  });
  const availability =
    !enabled || query.isError || query.isPaused
      ? 'unavailable'
      : query.isSuccess
        ? 'available'
        : 'loading';
  const entries = availability === 'available' ? query.data : undefined;
  // A failed read keeps TanStack's last successful data; it is not shown (it
  // may be stale), but it says whether there was anything to lose sight of.
  const lostSightOfEntries =
    availability === 'unavailable' &&
    visibleInboxEntries(query.data).length > 0;
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
        request.scope.apiBase,
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
        scope,
        client,
        queryKey,
        conversationId,
        key,
      });
    },
  };
}
