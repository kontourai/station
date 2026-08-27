import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../client/http', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

import { LIVE_ACTIVITY_SCHEMA_VERSION } from '@kontourai/station-contracts/live-activity';
import { fetchLiveActivity } from '../client/live-activity.js';

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
