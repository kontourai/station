import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  fetchResourcePosture,
  type ResourcePostureVM,
  useResourcePostureQuery,
} from '../query-domains/resourcePosture';

function mockJsonResponse(payload: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

// station#3089: the SDK half of "route -> query -> rendered state" — this
// is the exact response envelope `GET /api/system/resource-posture` returns
// (see `src-server/routes/system/__tests__/resource-posture-routes.test.ts`,
// which proves the route side of the same shape) and the exact VM the UI
// developer System tab consumes (`src-ui/src/__tests__/SystemTab.test.tsx`).
describe('resourcePosture SDK domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches the current resource posture and hits the exact route', async () => {
    const posture: ResourcePostureVM = {
      kind: 'critical',
      busyPercent: 97,
      cpuCount: 8,
      sampledAt: 12345,
      sampleMs: 500,
      thresholdPercent: 95,
      source: 'runtime-probe',
    };
    mockJsonResponse({ success: true, data: posture });

    await expect(fetchResourcePosture()).resolves.toEqual(posture);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/system/resource-posture',
    );
  });

  it('surfaces a server-reported error', async () => {
    mockJsonResponse({ success: false, error: 'boom' }, false);
    await expect(fetchResourcePosture()).rejects.toThrow('boom');
  });

  it('exports a usable query hook', () => {
    expect(typeof useResourcePostureQuery).toBe('function');
  });
});
