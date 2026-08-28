import { useStatsQuery } from '@kontourai/station-sdk';

export function useStats(
  agentSlug: string,
  conversationId: string,
  _apiBase?: string,
  shouldFetch: boolean = true,
) {
  const {
    data: stats,
    error,
    refetch,
    isLoading,
  } = useStatsQuery(agentSlug, conversationId, {
    enabled: shouldFetch && !!agentSlug,
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
