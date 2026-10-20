import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import {
  cancelConversationInboxEntry,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  listConversationInbox,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  type QueryClient,
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

export function useConversationInbox(conversationId: string) {
  const scope = useHostRequestAuthorityScope();
  const client = useQueryClient();
  const enabled = Boolean(conversationId && scope?.isCurrent());
  const queryKey = [
    'conversation-inbox',
    scope?.apiBase,
    scope?.authorityKey,
    conversationId,
  ];
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
        : 2_000,
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
    pendingCount: entries?.filter(
      (entry) => entry.state === 'queued' || entry.state === 'sending',
    ).length,
    refreshing: query.isFetching,
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
