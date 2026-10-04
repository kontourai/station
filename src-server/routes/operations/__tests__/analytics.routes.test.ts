import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { UsageAggregator } from '../../../analytics/usage-aggregator.js';
import { createEmptyUsageStats } from '../../../analytics/usage-aggregator-state.js';
import {
  bindRuntimeLocalOperator,
  isBoundRuntimeLocalOperator,
  type RuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  analyticsOps: { add: vi.fn() },
}));

const { createAnalyticsRoutes } = await import('../analytics.js');
const makeHome = trackTempDirs();

test('ordinary analytics and rescan responses omit the operator-only person breakdown', async () => {
  const aggregator = new UsageAggregator(makeHome('station-private-usage-'));
  const stats = createEmptyUsageStats();
  const principal = humanPrincipal('oidc', 'recorded-user', 'Recorded person');
  stats.byPrincipal = {
    [principal.id]: {
      principal,
      usage: {
        messages: 1,
        inputTokens: 12,
        outputTokens: 4,
        cost: 0,
      },
    },
  };
  vi.spyOn(aggregator, 'readStats').mockResolvedValue(stats);
  vi.spyOn(aggregator, 'fullRescan').mockResolvedValue(stats);
  const app = createAnalyticsRoutes(
    aggregator,
    undefined,
    undefined,
    undefined,
    'instance',
    () => true,
  );
  for (const [path, method] of [
    ['/usage', 'GET'],
    ['/usage?from=2026-10-01&to=2026-10-04', 'GET'],
    ['/rescan', 'POST'],
  ]) {
    const response = await app.request(path, { method });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.data.byPrincipal).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(principal.id);
  }
  const protectedBody = await json(await app.request('/station-usage'));
  expect(protectedBody.data.byPrincipal[principal.id].usage.inputTokens).toBe(
    12,
  );
});

test('station overview requires bound operator authority and reads the whole local instance', async () => {
  const home = makeHome('station-operator-usage-');
  for (const [agent, inputTokens] of [
    ['one', 11],
    ['two', 23],
  ] as const) {
    const dir = join(home, 'agents', agent, 'memory', 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'conversation.ndjson'),
      JSON.stringify({
        role: 'assistant',
        timestamp: '2026-10-04T12:00:00.000Z',
        metadata: { usage: { inputTokens, outputTokens: 2, estimatedCost: 0 } },
      }),
    );
  }
  const aggregator = new UsageAggregator(home);
  const read = vi.spyOn(aggregator, 'readStats');
  let principal: RuntimeAuthenticatedRequestPrincipal | undefined;
  const app = new Hono();
  app.use('*', async (c, next) => {
    bindRuntimeLocalOperator(c.req.raw, principal);
    await next();
  });
  app.route(
    '/analytics',
    createAnalyticsRoutes(
      aggregator,
      undefined,
      undefined,
      undefined,
      'this-instance',
      isBoundRuntimeLocalOperator,
    ),
  );
  for (const caller of [
    undefined,
    {
      credential: 'test-paired-device',
      authority: undefined,
      source: 'bearer' as const,
      pairingSource: 'same-origin' as const,
    },
  ]) {
    principal = caller;
    const response = await app.request(
      '/analytics/station-usage?operator=1&userId=human:local:operator',
      {
        headers: { 'x-operator': 'true' },
      },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(read).not.toHaveBeenCalled();
  }
  principal = {
    credential: 'test-local-grant',
    authority: undefined,
    source: 'bearer',
    locality: 'home-possession',
  };
  const response = await app.request('/analytics/station-usage');
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(body.scope).toEqual({ kind: 'station', stationId: 'this-instance' });
  expect(body.data.lifetime.totalInputTokens).toBe(34);
  expect(body.data.byAgent.one.messages).toBe(1);
  expect(body.data.byAgent.two.messages).toBe(1);
  principal = undefined;
  expect((await app.request('/analytics/station-usage')).status).toBe(403);
  expect(read).toHaveBeenCalledTimes(1);
});

test('rescanning the same measured messages in a different order preserves cost eligibility', async () => {
  const home = makeHome('station-profile-cost-rounding-');
  const dir = join(home, 'agents', 'sample', 'memory', 'sessions');
  await mkdir(dir, { recursive: true });
  const rows = Array.from({ length: 3000 }, (_, index) =>
    JSON.stringify({
      role: 'assistant',
      metadata: {
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          estimatedCost: index < 1500 ? 0.001 : 0.008,
        },
      },
    }),
  );
  const file = join(dir, 'one.ndjson');
  const app = createAnalyticsRoutes(new UsageAggregator(home));
  for (const ordered of [rows, [...rows].reverse()]) {
    await writeFile(file, ordered.join('\n'));
    expect((await app.request('/rescan', { method: 'POST' })).status).toBe(200);
    const body = await json(await app.request('/achievements'));
    const milestone = body.data.find(
      (item: { id: string }) => item.id === 'cost-conscious',
    );
    expect(milestone.unlocked).toBe(true);
    expect(milestone.measurementUnavailableReason).toBeUndefined();
  }
});

test.each([
  {
    name: 'missing',
    estimatedCost: undefined,
    skipped: false,
    eligible: false,
  },
  { name: 'reported zero', estimatedCost: 0, skipped: false, eligible: true },
  {
    name: 'unreadable record',
    estimatedCost: 0,
    skipped: true,
    eligible: false,
  },
])(
  'cost milestones handle saved-message costs: $name',
  async ({ estimatedCost, skipped, eligible }) => {
    const home = makeHome('station-profile-message-cost-');
    const dir = join(home, 'agents', 'sample', 'memory', 'sessions');
    await mkdir(dir, { recursive: true });
    const message = {
      role: 'assistant',
      metadata: {
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          ...(estimatedCost === undefined ? {} : { estimatedCost }),
        },
      },
    };
    await writeFile(
      join(dir, 'one.ndjson'),
      Array.from({ length: 60 }, () => JSON.stringify(message)).join('\n') +
        (skipped ? '\n{invalid' : ''),
    );
    const aggregator = new UsageAggregator(home);
    const body = await json(
      await createAnalyticsRoutes(aggregator).request('/achievements'),
    );
    const milestone = body.data.find(
      (item: { id: string }) => item.id === 'cost-conscious',
    );
    expect(milestone.unlocked).toBe(eligible);
    if (!eligible) {
      expect(milestone.measurementUnavailableReason).toBeTruthy();
      expect(milestone.progress).toBeUndefined();
    }
  },
);

test.each(['incrementalUpdate', 'applyEnrichmentUsage'] as const)(
  '%s cannot certify cost coverage before the changed message is rescanned',
  async (method) => {
    const home = makeHome('station-profile-cost-update-');
    const aggregator = new UsageAggregator(home, {
      get: () => ({
        listSessionUsage: () => [
          {
            threadId: 'engine',
            conversationId: 'engine',
            usage: { turns: 60, toolCalls: 0, reportedCostUsd: 0 },
          },
        ],
      }),
    });
    const app = createAnalyticsRoutes(aggregator);
    await app.request('/achievements');
    const dir = join(home, 'agents', 'sample', 'memory', 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'one.ndjson'),
      JSON.stringify({
        role: 'assistant',
        metadata: { usage: { inputTokens: 10 } },
      }),
    );
    await aggregator[method](
      { role: 'assistant', metadata: { usage: { inputTokens: 10 } } },
      'sample',
      'one',
    );
    const body = await json(await app.request('/achievements'));
    const milestone = body.data.find(
      (item: { id: string }) => item.id === 'cost-conscious',
    );
    expect(milestone.unlocked).toBe(false);
    expect(milestone.measurementUnavailableReason).toBeTruthy();
  },
);

test('a corrected current token figure does not retain an obsolete cost-coverage gap', async () => {
  const usage = {
    turns: 60,
    toolCalls: 0,
    inputTokens: 100,
    reportedCostUsd: 0,
  };
  const aggregator = new UsageAggregator(
    makeHome('station-profile-retained-cost-'),
    {
      get: () => ({
        listSessionUsage: () => [
          { threadId: 'engine', conversationId: 'engine', usage },
        ],
      }),
    },
  );
  await aggregator.fullRescan();
  usage.inputTokens = 10;
  await aggregator.fullRescan();
  const body = await json(
    await createAnalyticsRoutes(aggregator).request('/achievements'),
  );
  const milestone = body.data.find(
    (item: { id: string }) => item.id === 'cost-conscious',
  );
  expect(milestone.unlocked).toBe(true);
  expect(milestone.measurementUnavailableReason).toBeUndefined();
});

test.each([undefined, 0])(
  'cost milestones distinguish missing engine cost from a reported %s',
  async (reportedCostUsd) => {
    const aggregator = new UsageAggregator(makeHome('station-profile-cost-'), {
      get: () => ({
        listSessionUsage: () => [
          {
            threadId: 'thread-cost',
            conversationId: 'cost',
            usage: {
              provider: 'codex',
              turns: 60,
              toolCalls: 0,
              ...(reportedCostUsd === undefined ? {} : { reportedCostUsd }),
            },
          },
        ],
      }),
    });
    const body = await json(
      await createAnalyticsRoutes(aggregator).request('/achievements'),
    );
    const milestone = body.data.find(
      (item: { id: string }) => item.id === 'cost-conscious',
    );
    expect(milestone.unlocked).toBe(reportedCostUsd !== undefined);
    if (reportedCostUsd === undefined) {
      expect(milestone.measurementUnavailableReason).toBeTruthy();
      expect(milestone.progress).toBeUndefined();
      expect(milestone.progressPercent).toBeUndefined();
    }
  },
);

test('usage reads refresh engine totals and achievements after the snapshot expires', async () => {
  const home = makeHome('station-profile-freshness-');
  const usage = { turns: 1, toolCalls: 0, inputTokens: 50 };
  const aggregator = new UsageAggregator(home, {
    get: () => ({
      listSessionUsage: () => [
        {
          threadId: 'thread-1',
          conversationId: 'conversation-1',
          agentSlug: 'codex',
          usage,
        },
      ],
    }),
  });
  const app = createAnalyticsRoutes(aggregator);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  try {
    const first = await json(await app.request('/usage'));
    expect(first.data.lifetime.totalMessages).toBe(1);
    expect(first.data.snapshot.rescannedAt).toBeTruthy();
    usage.turns = 100;
    usage.inputTokens = 5000;
    clock.mockReturnValue(clock() + 60_001);
    const achievements = await json(await app.request('/achievements'));
    expect(
      achievements.data.find(
        (item: { id: string }) => item.id === 'conversationalist',
      ).unlocked,
    ).toBe(true);
    const next = await json(await app.request('/usage'));
    expect(next.data.lifetime.totalMessages).toBe(100);
    expect(next.data.lifetime.totalInputTokens).toBe(5000);
  } finally {
    clock.mockRestore();
  }
});

test('reset leaves a usable projection rebuilt from the next retained message', async () => {
  const home = makeHome('station-profile-reset-');
  const aggregator = new UsageAggregator(home);
  await aggregator.reset();
  const dir = join(home, 'agents', 'sample', 'memory', 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'one.ndjson'),
    JSON.stringify({ role: 'assistant' }),
  );
  await aggregator.incrementalUpdate({ role: 'assistant' }, 'sample', 'one');
  expect((await aggregator.readStats()).lifetime.totalMessages).toBe(1);
});

function createMockAggregator() {
  const loadStats = vi
    .fn()
    .mockResolvedValue({ byDate: {}, totalMessages: 0, totalCost: 0 });
  return {
    loadStats,
    readStats: () => loadStats(),
    getAchievements: vi.fn().mockResolvedValue([]),
    fullRescan: vi.fn().mockResolvedValue({ byDate: {} }),
    reset: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Analytics Routes', () => {
  test('GET /usage without a range returns the aggregator stats unchanged', async () => {
    const agg = createMockAggregator();
    const app = createAnalyticsRoutes(agg as any);
    const body = await json(await app.request('/usage'));
    expect(body).toEqual({
      success: true,
      data: { byDate: {}, totalMessages: 0, totalCost: 0 },
    });
    expect(agg.loadStats).toHaveBeenCalledOnce();
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
