import { describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { createResourcePostureRoutes } from '../resource-posture-routes.js';

// station#3089: proves the route half of "route -> query -> rendered state"
// — the SDK-side half (`packages/sdk/src/__tests__/resourcePosture.test.ts`)
// and the UI-side half
// (`src-ui/src/__tests__/ResourcePostureBannerSource.test.tsx`) both consume
// this exact response envelope, so a change to this shape that isn't
// reflected there is the seam these three tests together are meant to catch.
describe('GET /resource-posture', () => {
  test('reads the exact posture object the shared probe observed, unmodified', async () => {
    const posture = {
      kind: 'critical' as const,
      busyPercent: 97,
      cpuCount: 8,
      sampledAt: 12345,
      sampleMs: 500,
      thresholdPercent: 95,
      source: 'test-probe',
    };
    const app = createResourcePostureRoutes({
      resourcePosture: { observe: async () => posture },
    });

    const response = await app.request('/resource-posture');
    expect(response.status).toBe(200);
    const body = await readJson<{ success: boolean; data: typeof posture }>(
      response,
    );
    expect(body).toEqual({ success: true, data: posture });
  });

  test('reports healthy posture the same way — the route never filters by kind', async () => {
    const posture = {
      kind: 'healthy' as const,
      busyPercent: 12,
      cpuCount: 8,
      sampledAt: 12345,
      sampleMs: 500,
      thresholdPercent: 85,
      source: 'test-probe',
    };
    const app = createResourcePostureRoutes({
      resourcePosture: { observe: async () => posture },
    });

    const body = await readJson<{ success: boolean; data: typeof posture }>(
      await app.request('/resource-posture'),
    );
    expect(body).toEqual({ success: true, data: posture });
  });

  test('degrades to 503 rather than fabricating a healthy reading when no probe is wired', async () => {
    const app = createResourcePostureRoutes({});

    const response = await app.request('/resource-posture');
    expect(response.status).toBe(503);
    const body = await readJson<{ success: boolean; error: string }>(response);
    expect(body.success).toBe(false);
  });
});
