import { useStatsQuery } from '@kontourai/station-sdk';
import { useOptionalConversationConnection } from '../components/conversation/ConversationConnectionContext';

const skipRefetch = async () => undefined;

export function useStats(
  agentSlug: string,
  conversationId: string,
  _apiBase?: string,
  shouldFetch: boolean = true,
  /**
   * Poll cadence while the read is enabled. The server writes conversation
   * stats from a turn-end hook, several awaits after the transcript the client
   * counts — so a caller that refreshes on message count alone can read the
   * previous turn's numbers and keep showing them. React Query owns the poll:
   * it is inert while `enabled` is false, and `refetchIntervalInBackground`
   * defaults to false, so a hidden tab is not polled either.
   */
  refetchIntervalMs?: number,
) {
  const target = useOptionalConversationConnection();
  // A relay reaches the paired Station only through its chat tunnel, whose
  // ceiling (`peer-chat-policy.ts`) has no agent-stats read: the source
  // Station refuses it with a 404 every time. A relay chat has no stats, and
  // `refetch` is withheld too: React Query's refetch ignores `enabled`, and
  // callers refetch on every message-count change.
  const relay = target?.station?.routeKind === 'relay';
  const {
    data: stats,
    error,
    refetch: refetchStats,
    isLoading,
  } = useStatsQuery(agentSlug, conversationId, {
    readTarget: target?.station,
    enabled: shouldFetch && !!agentSlug && !relay,
    ...(refetchIntervalMs === undefined
      ? {}
      : { refetchInterval: refetchIntervalMs }),
  });

  const refetch = relay ? skipRefetch : refetchStats;

  return {
    stats: stats || null,
    // this hook dropped the query error, so a failed stats read
    // reached the modal indistinguishable from a successful empty one and was
    // drawn as "No stats available" — a measurement claim over a read that
    // never returned. The error is a fact the hook holds; every consumer gets
    // it, and the modal decides how to render it.
    error: error ?? null,
    refetch,
    loading: isLoading,
  };
}
