import { getConversationTurnDirectory } from '@kontourai/station-sdk/client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';

export function useTranscriptTurnDirectory(conversationId?: string) {
  const hostScope = useHostRequestAuthorityScope();
  const connection = useOptionalConversationConnection();
  const scope = connection ? connection.requestScope : hostScope;
  const apiBase = connection?.apiBase ?? scope?.apiBase;
  return useInfiniteQuery({
    queryKey: [
      'conversation-turn-directory',
      apiBase,
      scope?.authorityKey,
      connection?.station?.runtimeKey,
      conversationId,
    ],
    initialPageParam: undefined as
      | { cursor: string; turnCount: number }
      | undefined,
    queryFn: ({ signal, pageParam }) =>
      getConversationTurnDirectory(
        apiBase!,
        conversationId!,
        pageParam?.cursor,
        {
          signal,
          turnCountSnapshot: pageParam?.turnCount,
          requestScope: scope!,
        },
      ),
    getNextPageParam: (page) =>
      page?.nextCursor
        ? { cursor: page.nextCursor, turnCount: page.session.turnCount }
        : undefined,
    enabled:
      !!conversationId &&
      !!scope?.isCurrent() &&
      (!connection?.station || connection.station.isCurrent()),
    retry: false,
    staleTime: 30_000,
  });
}
