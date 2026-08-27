import { LIVE_ACTIVITY_SCHEMA_VERSION } from '@kontourai/station-contracts/live-activity';
import { expect, test } from 'vitest';
import { createLiveActivityRoutes } from '../live-activity.js';

const projection = {
  schemaVersion: LIVE_ACTIVITY_SCHEMA_VERSION,
  observedAt: 1,
  connectedClients: 0,
  participants: [
    {
      actor: { kind: 'agent' as const, label: 'Codex' },
      scope: {
        projectId: 'project-1',
        projectSlug: 'station',
        taskId: 'task-1',
      },
      work: {
        sessionId: 'session-1',
        workName: 'Review auth',
        workState: 'reviewing' as const,
        startedAt: 1,
      },
    },
  ],
};

test('composes an identity-free connected aggregate with the runtime projection', async () => {
  const app = createLiveActivityRoutes({
    roomRuntime: {
      liveActivity: async () => ({ kind: 'available' as const, projection }),
    } as any,
    connectedClientPresence: {
      snapshot: () => new Map([['private-device-id', { sessionCount: 3 }]]),
    } as any,
    activePairedDeviceIds: () => ['private-device-id'],
  });
  const response = await app.request('/');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ success: true, data: { connectedClients: 3 } });
  expect(JSON.stringify(body)).not.toContain('private-device-id');
});

test('is unavailable in hosted mode and never creates a public fallback', async () => {
  const app = createLiveActivityRoutes({
    connectedClientPresence: { snapshot: () => new Map() } as any,
    activePairedDeviceIds: () => [],
    hosted: () => true,
  });
  expect((await app.request('/')).status).toBe(404);
});
