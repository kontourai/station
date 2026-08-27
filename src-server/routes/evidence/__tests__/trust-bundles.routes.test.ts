import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  trustBundleLists: { add: vi.fn() },
  trustBundleReads: { add: vi.fn() },
}));

const { createTrustBundleRoutes } = await import('../trust-bundles.js');
const { TrustBundleNotFoundError } = await import(
  '../../../services/evidence/trust-bundle-service.js'
);

const SUMMARY = {
  id: 'survey-session',
  fileName: 'survey-session.json',
  path: '/ws/.station/trust-bundles/survey-session.json',
  source: 'workspace' as const,
  modifiedAt: '2026-06-12T00:00:00.000Z',
  valid: true,
  bundleSource: 'survey-review-workbench',
  claimCount: 3,
  claimsByStatus: { verified: 2, proposed: 1 },
  transparencyGapCount: 1,
};

const REPORT_RESULT = {
  id: 'survey-session',
  path: '/ws/.station/trust-bundles/survey-session.json',
  source: 'workspace' as const,
  modifiedAt: '2026-06-12T00:00:00.000Z',
  valid: true,
  report: {
    id: 'report-1',
    generatedAt: '2026-06-12T00:00:00.000Z',
    claims: [],
    evidence: [],
    transparencyGaps: [],
    summary: { totalClaims: 3, byStatus: { verified: 2, proposed: 1 } },
  },
};

function createMockService(
  overrides: Partial<{
    listBundles: ReturnType<typeof vi.fn>;
    getTrustReport: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    listBundles: overrides.listBundles ?? vi.fn().mockResolvedValue([SUMMARY]),
    getTrustReport:
      overrides.getTrustReport ?? vi.fn().mockResolvedValue(REPORT_RESULT),
  };
}

function createApp(service = createMockService()) {
  const app = createTrustBundleRoutes(service as never, {
    resolveLocations: (slug) =>
      slug === 'dev'
        ? {
            workspacePath: '/workspace/dev',
            pluginDataDir: '/home/projects/dev/plugin-data',
          }
        : undefined,
  });
  return { app, service };
}

async function get(app: ReturnType<typeof createApp>['app'], path: string) {
  // Routes are mounted under /api/projects/:slug/trust-bundles; emulate it.
  const { Hono } = await import('hono');
  const root = new Hono();
  root.route('/api/projects/:slug/trust-bundles', app);
  return root.request(`http://localhost${path}`);
}

describe('trust bundle routes', () => {
  test('GET lists bundle summaries with resolved locations', async () => {
    const { app, service } = createApp();
    const response = await get(app, '/api/projects/dev/trust-bundles');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('survey-session');
    expect(body.data[0].claimsByStatus.verified).toBe(2);
    expect(service.listBundles).toHaveBeenCalledWith({
      workspacePath: '/workspace/dev',
      pluginDataDir: '/home/projects/dev/plugin-data',
    });
  });

  test('GET /:id returns the trust report', async () => {
    const { app, service } = createApp();
    const response = await get(
      app,
      '/api/projects/dev/trust-bundles/survey-session',
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.data.valid).toBe(true);
    expect(body.data.report.summary.totalClaims).toBe(3);
    expect(service.getTrustReport).toHaveBeenCalledWith(
      {
        workspacePath: '/workspace/dev',
        pluginDataDir: '/home/projects/dev/plugin-data',
      },
      'survey-session',
    );
  });

  test('GET /:id reports invalid bundles as data, not an error status', async () => {
    const service = createMockService({
      getTrustReport: vi.fn().mockResolvedValue({
        ...REPORT_RESULT,
        valid: false,
        error: 'Trust bundle is missing required schemaVersion',
        report: null,
      }),
    });
    const { app } = createApp(service);
    const response = await get(
      app,
      '/api/projects/dev/trust-bundles/survey-session',
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(body.data.valid).toBe(false);
    expect(body.data.error).toContain('schemaVersion');
  });

  test('GET /:id maps unknown bundles to 404', async () => {
    const service = createMockService({
      getTrustReport: vi
        .fn()
        .mockRejectedValue(
          new TrustBundleNotFoundError('Trust bundle not found: nope'),
        ),
    });
    const { app } = createApp(service);
    const response = await get(app, '/api/projects/dev/trust-bundles/nope');
    expect(response.status).toBe(404);
  });

  test('unexpected failures map to 500', async () => {
    const service = createMockService({
      listBundles: vi.fn().mockRejectedValue(new Error('disk on fire')),
    });
    const { app } = createApp(service);
    const response = await get(app, '/api/projects/dev/trust-bundles');
    expect(response.status).toBe(500);
    const body = await readJson(response);
    expect(body.error).toContain('disk on fire');
  });

  test('unknown projects return 404', async () => {
    const { app } = createApp();
    const response = await get(app, '/api/projects/nope/trust-bundles');
    expect(response.status).toBe(404);
  });

  test('hosted public trust routes return the same generic 404 before project resolution or service reads', async () => {
    const service = createMockService();
    const resolveLocations = vi.fn(() => {
      throw new Error('must not resolve a personal Project');
    });
    const app = createTrustBundleRoutes(service as never, {
      available: () => false,
      resolveLocations,
    });
    for (const path of [
      '/api/projects/project-a/trust-bundles',
      '/api/projects/project-a/trust-bundles/bundle-a',
    ]) {
      const response = await get(app, path);
      expect(response.status).toBe(404);
      expect(await readJson(response)).toEqual({
        success: false,
        error: 'Project not found',
      });
    }
    expect(resolveLocations).not.toHaveBeenCalled();
    expect(service.listBundles).not.toHaveBeenCalled();
    expect(service.getTrustReport).not.toHaveBeenCalled();
  });
});
