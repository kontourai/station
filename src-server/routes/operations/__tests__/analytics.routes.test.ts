import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  analyticsOps: { add: vi.fn() },
}));

const { createAnalyticsRoutes } = await import('../analytics.js');

function createMockAggregator() {
  return {
    loadStats: vi
      .fn()
      .mockResolvedValue({ byDate: {}, totalMessages: 0, totalCost: 0 }),
    getAchievements: vi.fn().mockResolvedValue([]),
    fullRescan: vi.fn().mockResolvedValue({ byDate: {} }),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Analytics Routes', () => {
  test('GET /usage returns stats', async () => {
    const agg = createMockAggregator();
    const app = createAnalyticsRoutes(agg as any);
    const body = await json(await app.request('/usage'));
    expect(body.data).toBeDefined();
  });

  test('GET /usage returns 500 when not initialized', async () => {
    const app = createAnalyticsRoutes(undefined);
    const res = await app.request('/usage');
    expect(res.status).toBe(500);
  });

  test('GET /usage with date range filters', async () => {
    const agg = createMockAggregator();
    agg.loadStats.mockResolvedValue({
      byDate: {
        '2026-03-20': { messages: 5, cost: 0.1 },
        '2026-03-21': { messages: 3, cost: 0.05 },
      },
    });
    const app = createAnalyticsRoutes(agg as any);
    const body = await json(
      await app.request('/usage?from=2026-03-21&to=2026-03-21'),
    );
    expect(Object.keys(body.data.byDate)).toEqual(['2026-03-21']);
    expect(body.data.rangeSummary).toBeDefined();
  });

  test('GET /achievements returns list', async () => {
    const agg = createMockAggregator();
    const app = createAnalyticsRoutes(agg as any);
    const body = await json(await app.request('/achievements'));
    expect(body.data).toEqual([]);
  });

  test('POST /rescan triggers full rescan', async () => {
    const agg = createMockAggregator();
    const app = createAnalyticsRoutes(agg as any);
    const body = await json(await app.request('/rescan', { method: 'POST' }));
    expect(body.message).toContain('rescan');
    expect(agg.fullRescan).toHaveBeenCalled();
  });

  test('DELETE /usage resets stats', async () => {
    const agg = createMockAggregator();
    const app = createAnalyticsRoutes(agg as any);
    const body = await json(await app.request('/usage', { method: 'DELETE' }));
    expect(body.success).toBe(true);
    expect(agg.reset).toHaveBeenCalled();
  });

  test('GET /usage-rollup is bounded and delegates only a read capability', async () => {
    const read = vi.fn().mockResolvedValue({
      window: { from: '2026-08-01', to: '2026-08-07' },
      rows: [],
      receipts: [],
      coverage: [{ stationId: 'local', state: 'partial' }],
    });
    const authority = sessionReadAuthorityFromRequest(
      'usage-reader',
      undefined,
      undefined,
    );
    const app = createAnalyticsRoutes(
      undefined,
      { read } as any,
      () => authority,
    );
    const body = await json(
      await app.request('/usage-rollup?days=7&groupBy=model&pageSize=25'),
    );
    expect(body.data.coverage[0].state).toBe('partial');
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ groupBy: 'model', pageSize: 25 }),
      authority,
    );
    expect((await app.request('/usage-rollup?days=8')).status).toBe(400);
    expect((await app.request('/usage-rollup?pageSize=101')).status).toBe(400);
  });

  test('GET /usage-rollup fails closed when no request authority can be minted', async () => {
    const app = createAnalyticsRoutes(undefined, { read: vi.fn() } as any);
    expect((await app.request('/usage-rollup?days=7')).status).toBe(403);
  });

  test.each([
    [
      'complete',
      {
        receipts: [],
        coverage: {
          stationId: 'local',
          state: 'complete',
          window: { from: expect.any(String), to: expect.any(String) },
        },
      },
      'complete',
    ],
    [
      'partial',
      {
        receipts: [],
        coverage: {
          stationId: 'local',
          state: 'partial',
          reason: 'terminal turns missing usage reports',
          window: { from: expect.any(String), to: expect.any(String) },
        },
      },
      'partial',
    ],
    ['empty', { receipts: [] }, 'unknown'],
  ] as const)(
    'GET /usage-rollup carries local %s coverage to the UI response',
    async (_, page, expectedState) => {
      const readUsageReceipts = vi.fn(() => page);
      const authority = sessionReadAuthorityFromRequest(
        'usage-reader',
        undefined,
        undefined,
      );
      const app = createAnalyticsRoutes(
        { readUsageReceipts } as any,
        undefined,
        () => authority,
      );
      const body = await json(await app.request('/usage-rollup?days=7'));
      expect(body.data.coverage[0]).toMatchObject({ state: expectedState });
    },
  );

  test('GET /usage-rollup carries a hosted missing-tenant coverage gap to the UI response', async () => {
    const hostedRegistry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
    });
    const authority = sessionReadAuthorityFromRequest(
      'usage-reader',
      undefined,
      hostedRegistry,
    );
    const readUsageReceipts = vi.fn((_station, passedAuthority) => {
      expect(passedAuthority).toBe(authority);
      return {
        receipts: [],
        coverage: {
          stationId: 'local',
          state: 'unknown' as const,
          reason: 'hosted tenant context missing',
          freshness: 'unknown' as const,
          window: { from: '2026-08-19', to: '2026-08-25' },
        },
      };
    });
    const app = createAnalyticsRoutes(
      { readUsageReceipts } as any,
      undefined,
      () => authority,
    );
    const body = await json(await app.request('/usage-rollup?days=7'));
    expect(body.data.coverage[0]).toMatchObject({
      state: 'unknown',
      reason: 'hosted tenant context missing',
    });
  });
});
