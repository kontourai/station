import type { LiveActivityProjection } from '@kontourai/station-contracts/live-activity';
import { useQuery } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { fetchLiveActivity } from '../client/live-activity';
import { liveActivityQueries } from '../queryFactories';

/** Mirrors the Project/Task room heartbeat cadence, without inventing liveness. */
export function useLiveActivityQuery() {
  return useQuery<LiveActivityProjection | undefined>({
    queryKey: liveActivityQueries.current().queryKey,
    queryFn: async () => fetchLiveActivity(await _getApiBase()),
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}
