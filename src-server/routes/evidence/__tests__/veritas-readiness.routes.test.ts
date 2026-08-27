import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  veritasReadinessRuns: { add: vi.fn() },
  veritasReadinessDuration: { record: vi.fn() },
  veritasReadinessInits: { add: vi.fn() },
}));

const { createVeritasReadinessRoutes } = await import(
  '../veritas-readiness.js'
);
const { VeritasCliError, VeritasNotConfiguredError } = await import(
  '../../../services/evidence/veritas-readiness-service.js'
);

const SNAPSHOT = {
  generatedAt: '2026-06-12T00:00:00.000Z',
  overall: 'ready' as const,
  cli: {
    runId: 'veritas-123',
    message: 'Evidence Check, report, and standards feedback draft completed.',
    reportArtifactPath: '.kontourai/veritas/evidence/veritas-123.json',
    sourceKind: 'working-tree',
    evidenceCheckLabels: ['npm test'],
    evidenceCheckFailure: null,
  },
  requirements: [
    {
      id: 'evidence-check:required-evidence-check',
      kind: 'evidence-check' as const,
      label: 'npm test',
      status: 'satisfied' as const,
      summary: 'Evidence checks passed',
      claimIds: ['fx.evidence-check.npm-test'],
    },
  ],
  counts: {
    satisfied: 1,
    missing: 0,
    stale: 0,
    failing: 0,
    advisory: 0,
    recheckable: 0,
    accepted: 0,
  },
  trustReport: null,
};

function createMockService(
  overrides: Partial<{
    detectWorkspace: ReturnType<typeof vi.fn>;
    getReadiness: ReturnType<typeof vi.fn>;
    initWorkspace: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    detectWorkspace:
      overrides.detectWorkspace ??
      vi.fn().mockReturnValue({ configured: true, cliPath: '/ws/bin/veritas' }),
    getReadiness: overrides.getReadiness ?? vi.fn().mockResolvedValue(SNAPSHOT),
    initWorkspace:
      overrides.initWorkspace ??
      vi.fn().mockResolvedValue({ outcome: 'created' }),
  };
}

function createApp(service = createMockService()) {
  const app = createVeritasReadinessRoutes(service as never, {
    getWorkspacePath: (slug) => (slug === 'dev' ? '/workspace/dev' : undefined),
  });
  return { app, service };
}

async function get(app: ReturnType<typeof createApp>['app'], path: string) {
  // Routes are mounted under /api/projects/:slug/readiness; emulate the mount.
  const { Hono } = await import('hono');
  const root = new Hono();
  root.route('/api/projects/:slug/readiness', app);
  return root.request(`http://localhost${path}`);
}

async function post(app: ReturnType<typeof createApp>['app'], path: string) {
  const { Hono } = await import('hono');
  const root = new Hono();
  root.route('/api/projects/:slug/readiness', app);
  return root.request(`http://localhost${path}`, { method: 'POST' });
}

describe('veritas readiness routes', () => {
  test('GET returns the snapshot with the configured flag', async () => {
    const { app, service } = createApp();
    const response = await get(app, '/api/projects/dev/readiness');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(body.data.configured).toBe(true);
    expect(body.data.overall).toBe('ready');
    expect(body.data.generatedAt).toBe('2026-06-12T00:00:00.000Z');
    expect(body.data.requirements).toHaveLength(1);
    expect(service.getReadiness).toHaveBeenCalledWith('/workspace/dev', {
      refresh: false,
    });
  });

  test('GET ?refresh=true forces a fresh run', async () => {
    const { app, service } = createApp();
    const response = await get(app, '/api/projects/dev/readiness?refresh=true');
    expect(response.status).toBe(200);
    expect(service.getReadiness).toHaveBeenCalledWith('/workspace/dev', {
      refresh: true,
    });
  });

  test('GET ?check=evidence passes the check subset through', async () => {
    const { app, service } = createApp();
    await get(app, '/api/projects/dev/readiness?check=evidence');
    expect(service.getReadiness).toHaveBeenCalledWith('/workspace/dev', {
      refresh: false,
      check: 'evidence',
    });
  });

  test('GET rejects an unknown check subset', async () => {
    const { app } = createApp();
    const response = await get(app, '/api/projects/dev/readiness?check=nope');
    expect(response.status).toBe(400);
  });

  test('not-configured workspaces report configured:false, not an error', async () => {
    const service = createMockService({
      detectWorkspace: vi
        .fn()
        .mockReturnValue({ configured: false, reason: 'no-veritas-dir' }),
    });
    const { app } = createApp(service);
    const response = await get(app, '/api/projects/dev/readiness');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ configured: false, reason: 'no-veritas-dir' });
    expect(service.getReadiness).not.toHaveBeenCalled();
  });

  test('races to not-configured inside the run also report configured:false', async () => {
    const service = createMockService({
      getReadiness: vi
        .fn()
        .mockRejectedValue(new VeritasNotConfiguredError('gone', 'no-cli')),
    });
    const { app } = createApp(service);
    const response = await get(app, '/api/projects/dev/readiness');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.data).toEqual({ configured: false, reason: 'no-cli' });
  });

  test('CLI failures map to 502 with exit code and stderr tail', async () => {
    const service = createMockService({
      getReadiness: vi
        .fn()
        .mockRejectedValue(
          new VeritasCliError(
            'veritas readiness exited with code 2',
            2,
            'boom',
          ),
        ),
    });
    const { app } = createApp(service);
    const response = await get(app, '/api/projects/dev/readiness');
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.success).toBe(false);
    expect(body.exitCode).toBe(2);
    expect(body.stderrTail).toBe('boom');
  });

  test('unexpected failures map to 500', async () => {
    const service = createMockService({
      getReadiness: vi.fn().mockRejectedValue(new Error('disk on fire')),
    });
    const { app } = createApp(service);
    const response = await get(app, '/api/projects/dev/readiness');
    expect(response.status).toBe(500);
    const body = await readJson(response);
    expect(body.error).toContain('disk on fire');
  });

  test('projects with no workspace report not-configured (no-workspace), not 404', async () => {
    const { app } = createApp();
    const response = await get(app, '/api/projects/nope/readiness');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ configured: false, reason: 'no-workspace' });
  });

  test('POST /init scaffolds a workspace via the service', async () => {
    const { app, service } = createApp();
    const response = await post(app, '/api/projects/dev/readiness/init');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(body.data.outcome).toBe('created');
    expect(service.initWorkspace).toHaveBeenCalledWith('/workspace/dev');
  });

  test('POST /init is idempotent — already-initialized passes through', async () => {
    const service = createMockService({
      initWorkspace: vi
        .fn()
        .mockResolvedValue({ outcome: 'already-initialized' }),
    });
    const { app } = createApp(service);
    const response = await post(app, '/api/projects/dev/readiness/init');
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.data.outcome).toBe('already-initialized');
  });

  test('POST /init reports no-cli with a copyable command', async () => {
    const service = createMockService({
      initWorkspace: vi
        .fn()
        .mockResolvedValue({ outcome: 'no-cli', command: 'npx veritas init' }),
    });
    const { app } = createApp(service);
    const body = await readJson(
      await post(app, '/api/projects/dev/readiness/init'),
    );
    expect(body.data.outcome).toBe('no-cli');
    expect(body.data.command).toContain('veritas init');
  });

  test('POST /init maps a CLI failure to 502', async () => {
    const service = createMockService({
      initWorkspace: vi
        .fn()
        .mockRejectedValue(
          new VeritasCliError('veritas init exited with code 3', 3, 'boom'),
        ),
    });
    const { app } = createApp(service);
    const response = await post(app, '/api/projects/dev/readiness/init');
    expect(response.status).toBe(502);
    const body = await readJson(response);
    expect(body.exitCode).toBe(3);
  });
});
