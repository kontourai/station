import { useStatsQuery } from '@kontourai/station-sdk';

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
  const {
    data: stats,
    error,
    refetch,
    isLoading,
  } = useStatsQuery(agentSlug, conversationId, {
    enabled: shouldFetch && !!agentSlug,
    ...(refetchIntervalMs === undefined
      ? {}
      : { refetchInterval: refetchIntervalMs }),
  });

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
