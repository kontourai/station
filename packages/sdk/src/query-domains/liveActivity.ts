import type { LiveActivityProjection } from '@kontourai/station-contracts/live-activity';
import { useQuery } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { fetchLiveActivity } from '../client/live-activity';
import { liveActivityQueries } from '../queryFactories';

/**
 * How often the projection is re-read, and half of the delay a UI must own up
 * to: a participant leaves the server's projection when its heartbeat lease
 * expires (`ttlMs: 30_000`), and a client cannot notice sooner than its next
 * poll. Exported to give the interval one source of truth and a tripwire, not
 * because anything derives the sentence from it: the tray quotes "about forty
 * seconds" in prose. `packages/sdk/src/__tests__/live-activity.test.ts` pins
 * this number and `ProjectSidebarFooter.test.tsx` pins that copy, so moving
 * the poll reds a test rather than silently making the copy optimistic.
 */
export const LIVE_ACTIVITY_POLL_INTERVAL_MS = 10_000;

/**
 * Mirrors the Project/Task room heartbeat cadence, without inventing liveness.
 *
 * ABSENCE IS A VALUE, NOT AN ERROR. `fetchLiveActivity` answers `undefined`
 * for a 404, which the route returns in three cases that are all "this Station
 * does not publish live work" and none of which is a failure: a hosted
 * Station, a Station with no room runtime, and a runtime whose activity is not
 * available (`src-server/routes/orchestration/live-activity.ts`). That is a
 * capability signal the transport is careful to preserve.
 *
 * A query, however, cannot HOLD `undefined`: query-core rejects a queryFn that
 * resolves it, so the query lands in `status: 'error'` and every consumer sees
 * a failing Station. Mapping to `null` here is what keeps the distinction
 * alive across the seam — `data === null` means the Station answered and does
 * not publish live work, `isError` means it did not answer — instead of
 * destroying it one layer above the transport that took care to make it.
 */
export function useLiveActivityQuery() {
  return useQuery<LiveActivityProjection | null>({
    queryKey: liveActivityQueries.current().queryKey,
    queryFn: async () => (await fetchLiveActivity(await _getApiBase())) ?? null,
    staleTime: LIVE_ACTIVITY_POLL_INTERVAL_MS,
    refetchInterval: LIVE_ACTIVITY_POLL_INTERVAL_MS,
  });
}
