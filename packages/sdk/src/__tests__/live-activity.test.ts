import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../client/http', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

import { LIVE_ACTIVITY_SCHEMA_VERSION } from '@kontourai/station-contracts/live-activity';
import { fetchLiveActivity } from '../client/live-activity.js';
import { LIVE_ACTIVITY_POLL_INTERVAL_MS } from '../query-domains/liveActivity.js';

beforeEach(() => mocks.authenticatedFetch.mockReset());

test('parses the Activity projection and treats personal-mode unavailability as absent', async () => {
  mocks.authenticatedFetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
          observedAt: 1,
          connectedClients: 1,
          participants: [],
        },
      }),
      { status: 200 },
    ),
  );
  await expect(
    fetchLiveActivity('https://station.test'),
  ).resolves.toMatchObject({ connectedClients: 1 });
  mocks.authenticatedFetch.mockResolvedValueOnce(
    new Response('', { status: 404 }),
  );
  await expect(
    fetchLiveActivity('https://station.test'),
  ).resolves.toBeUndefined();
});

/**
 * The poll is half of a bound a user reads. The sidebar presence tray tells
 * the user a participant that stops heartbeating is dropped "up to about forty
 * seconds" later, and that forty is the server's 30s lease
 * (`DEFAULT_LIVE_WORK_BOUNDS.ttlMs`, pinned in
 * `src-server/services/orchestration/__tests__/project-task-room-runtime.test.ts`)
 * PLUS this interval. Raising the poll for battery — an entirely reasonable
 * change — silently makes that copy optimistic, so the number is pinned here
 * beside the transport it governs rather than left as the one term of the
 * sum nothing asserts.
 */
test('the poll interval the presence copy is bounded by', () => {
  expect(LIVE_ACTIVITY_POLL_INTERVAL_MS).toBe(10_000);
  // 30_000 (server lease) + 10_000 (this poll) is the "about forty seconds"
  // `ProjectSidebarPresenceTray` states and `ProjectSidebarFooter.test.tsx`
  // asserts. Change either term and the copy must move with it.
  expect(30_000 + LIVE_ACTIVITY_POLL_INTERVAL_MS).toBe(40_000);
});
