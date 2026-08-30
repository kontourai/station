import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { SchedulerJobConflictError } from '../../../services/scheduling/builtin-scheduler.js';
import {
  SchedulerStorageCorruptError,
  SchedulerStorageUnavailableError,
} from '../../../services/scheduling/scheduler-ledger.js';

const metricMocks = vi.hoisted(() => ({ schedulerJobRunsAdd: vi.fn() }));

vi.mock('../../../telemetry/metrics.js', () => ({
  schedulerJobRuns: { add: metricMocks.schedulerJobRunsAdd },
}));

const { createSchedulerRoutes } = await import('../scheduler.js');

// Realistic shapes matching what the UI reads
const mockJob = {
  target: 'daily-report',
  name: 'daily-report',
  cron: '0 9 * * *',
  prompt: 'Generate daily report',
  agent: 'station',
  enabled: true,
  lastRun: '2026-03-26T09:00:00Z',
  nextRun: '2026-03-27T09:00:00Z',
  provider: 'builtin',
};

const mockStats = {
  providers: {
    builtin: { totalJobs: 2, totalRuns: 10, successRate: 0.9 },
  },
  summary: { totalJobs: 2, totalRuns: 10, successRate: 0.9 },
};

const mockStatus = {
  providers: {
    builtin: {
      id: 'builtin',
      displayName: 'Built-in',
      running: true,
      lastTick: '2026-03-27T07:00:00Z',
    },
  },
};

const mockProvider = {
  id: 'builtin',
  displayName: 'Built-in Scheduler',
  capabilities: ['cron', 'manual'],
};

function createMockService() {
  return {
    listProviders: vi.fn().mockReturnValue([mockProvider]),
    listJobs: vi.fn().mockResolvedValue([mockJob]),
    getStats: vi.fn().mockResolvedValue(mockStats),
    getStatus: vi.fn().mockResolvedValue(mockStatus),
    previewSchedule: vi
      .fn()
      .mockResolvedValue(['2026-03-28T09:00:00Z', '2026-03-29T09:00:00Z']),
    getJobLogs: vi.fn().mockResolvedValue([
      {
        timestamp: '2026-03-27T09:00:00Z',
        status: 'success',
        output: '/path/to/output.md',
      },
    ]),
    addJob: vi.fn().mockResolvedValue('created'),
    editJob: vi.fn().mockResolvedValue('updated'),
    runJob: vi
      .fn()
      .mockResolvedValue({ outcome: 'completed', message: 'started' }),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    broadcast: vi.fn(),
  };
}

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.example.test' },
    { id: 'bravo', authority: 'bravo.example.test' },
  ],
});

function hostedAuthority(tenant: 'alpha' | 'bravo') {
  return sessionReadAuthorityFromRequest(
    `${tenant}-user`,
    { tenantId: tenantId(tenant) },
    hostedRegistry,
  );
}

function setup(hosted = false) {
  const svc = createMockService();
  const app = createSchedulerRoutes(
    svc as any,
    logger as any,
    hosted
      ? { readAuthorityForRequest: () => hostedAuthority('alpha') }
      : undefined,
  );
  return { app, svc };
}

describe('Scheduler Routes', () => {
  test('maps the ledger unavailable outcome to stable 503 rather than an empty job list', async () => {
    const { app, svc } = setup();
    svc.listJobs.mockRejectedValueOnce(new SchedulerStorageUnavailableError());
    const response = await app.request('/jobs');
    expect(response.status).toBe(503);
    await expect(json(response)).resolves.toMatchObject({
      success: false,
      error: 'Scheduler storage is temporarily unavailable',
    });
  });

  test('a corrupt ledger is not a 503 "come back later" (station#3220)', async () => {
    const { app, svc } = setup();
    svc.listJobs.mockRejectedValueOnce(new SchedulerStorageCorruptError());
    const response = await app.request('/jobs');
    // 503 tells a client the scheduler is busy and to retry. Damaged bytes are
    // not busy, and the body has to carry the repair the operator must run.
    expect(response.status).toBe(500);
    await expect(json(response)).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('station home restore'),
    });
  });

  test.each([
    ['/stats', 'getStats'],
    ['/status', 'getStatus'],
  ])(
    'maps scheduler storage unavailable from %s to 503',
    async (path, method) => {
      const { app, svc } = setup();
      svc[method as 'getStats' | 'getStatus'].mockRejectedValueOnce(
        new SchedulerStorageUnavailableError(),
      );
      expect((await app.request(path)).status).toBe(503);
    },
  );

  test('hosted mode suppresses the entire unbound scheduler read, SSE, webhook, and mutation surface', async () => {
    const { app, svc } = setup(true);
    const requests = [
      ['GET', '/providers'],
      ['GET', '/events'],
      ['POST', '/webhook'],
      ['GET', '/jobs'],
      ['GET', '/stats'],
      ['GET', '/status'],
      ['GET', '/jobs/preview-schedule?cron=*+*+*+*+*'],
      ['GET', '/jobs/daily-report/logs'],
      ['POST', '/jobs'],
      ['PUT', '/jobs/daily-report'],
      ['POST', '/jobs/daily-report/run'],
      ['PUT', '/jobs/daily-report/enable'],
      ['PUT', '/jobs/daily-report/disable'],
      ['DELETE', '/jobs/daily-report'],
    ] as const;

    for (const [method, path] of requests) {
      const response = await app.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await json(response)).toEqual({
        success: false,
        error: 'Scheduler not found',
      });
    }
    for (const dependency of Object.values(svc)) {
      if (typeof dependency === 'function') {
        expect(dependency).not.toHaveBeenCalled();
      }
    }
  });

  test('POST /jobs rejects ambiguous cron plus schedule input', async () => {
    const { app, svc } = setup();
    const response = await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'ambiguous',
        prompt: 'do not guess',
        cron: '0 9 * * *',
        schedule: { kind: 'every', everyMs: 60_000 },
      }),
    });
    expect(response.status).toBe(400);
    expect(svc.addJob).not.toHaveBeenCalled();
  });

  // ── Contract: SDK schedulerFetch expects { success: true, data: T } ──

  test('GET /providers returns { success, data } with id/displayName/capabilities', async () => {
    const { app } = setup();
    const body = await json(await app.request('/providers'));
    expect(body).toEqual({ success: true, data: [mockProvider] });
    expect(body.data[0]).toHaveProperty('id');
    expect(body.data[0]).toHaveProperty('displayName');
    expect(body.data[0]).toHaveProperty('capabilities');
  });

  test('GET /jobs returns { success, data } with job objects', async () => {
    const { app } = setup();
    const body = await json(await app.request('/jobs'));
    expect(body.success).toBe(true);
    expect(body.data[0]).toMatchObject({
      target: 'daily-report',
      name: 'daily-report',
      cron: '0 9 * * *',
      enabled: true,
    });
  });

  test('GET /jobs returns 500 on error', async () => {
    const { app, svc } = setup();
    svc.listJobs.mockRejectedValue(new Error('fail'));
    const res = await app.request('/jobs');
    expect(res.status).toBe(500);
  });

  test('GET /stats returns { success, data } with providers + summary', async () => {
    const { app } = setup();
    const body = await json(await app.request('/stats'));
    expect(body.success).toBe(true);
    // UI reads stats.providers and stats.summary.totalRuns/successRate
    expect(body.data.providers).toBeDefined();
    expect(body.data.summary).toMatchObject({
      totalJobs: expect.any(Number),
      totalRuns: expect.any(Number),
      successRate: expect.any(Number),
    });
  });

  test('GET /status returns { success, data } with providers map', async () => {
    const { app } = setup();
    const body = await json(await app.request('/status'));
    expect(body.success).toBe(true);
    // UI reads status.providers
    expect(body.data.providers).toBeDefined();
    expect(body.data.providers.builtin).toHaveProperty('running');
  });

  test('GET /jobs/preview-schedule returns array of date strings', async () => {
    const { app } = setup();
    const body = await json(
      await app.request('/jobs/preview-schedule?cron=*/5+*+*+*+*'),
    );
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  test('GET /jobs/preview-schedule returns 400 without cron', async () => {
    const { app } = setup();
    const res = await app.request('/jobs/preview-schedule');
    expect(res.status).toBe(400);
  });

  test('GET /jobs/:target/logs returns array of log entries', async () => {
    const { app } = setup();
    const body = await json(await app.request('/jobs/daily-report/logs'));
    expect(body.success).toBe(true);
    expect(body.data[0]).toHaveProperty('timestamp');
    expect(body.data[0]).toHaveProperty('status');
  });

  test('POST /jobs creates a job and returns { success, data }', async () => {
    const { app, svc } = setup();
    const body = await json(
      await app.request('/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-job', prompt: 'do stuff' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(svc.addJob).toHaveBeenCalled();
  });

  test('POST /jobs returns a rendered conflict contract for a duplicate name', async () => {
    const { app, svc } = setup();
    svc.addJob.mockRejectedValueOnce(new SchedulerJobConflictError('test-job'));

    const response = await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-job', prompt: 'do stuff' }),
    });

    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toEqual({
      success: false,
      error: "Job 'test-job' already exists",
    });
  });

  test.each([
    { kind: 'cron', expr: '0 9 * * *', timezone: 'America/Denver' },
    { kind: 'every', everyMs: 300_000 },
    { kind: 'at', timeMs: 1_800_000_000_000, deleteAfterRun: true },
  ])('POST /jobs accepts the canonical $kind schedule', async (schedule) => {
    const { app, svc } = setup();
    const response = await app.request('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `test-${schedule.kind}`,
        prompt: 'wake and inspect',
        schedule,
      }),
    });
    expect(response.status).toBe(200);
    expect(svc.addJob).toHaveBeenCalledWith(
      expect.objectContaining({ schedule }),
    );
  });

  test('PUT /jobs updates a canonical schedule without reducing it to cron', async () => {
    const { app, svc } = setup();
    const schedule = { kind: 'every', everyMs: 60_000 } as const;
    const response = await app.request('/jobs/daily-report', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule }),
    });
    expect(response.status).toBe(200);
    expect(svc.editJob).toHaveBeenCalledWith('daily-report', { schedule });
  });

  test('POST /jobs/:target/run preserves an indeterminate manual receipt instead of reporting success', async () => {
    const { app, svc } = setup();
    svc.runJob.mockResolvedValueOnce({
      outcome: 'indeterminate',
      message: 'provider invocation may have started',
      runId: 'schedule:built-in:daily-report:run-1',
    });
    const response = await app.request('/jobs/daily-report/run', {
      method: 'POST',
    });
    expect(response.status).toBe(409);
    await expect(json(response)).resolves.toMatchObject({
      success: false,
      data: {
        output:
          'Scheduler job may have started. Inspect the associated run before acting again.',
        receipt: {
          outcome: 'indeterminate',
          runId: 'schedule:built-in:daily-report:run-1',
        },
      },
    });
  });

  test('POST /jobs/:target/run reports a manual resource-posture refusal truthfully', async () => {
    const { app, svc } = setup();
    svc.runJob.mockResolvedValueOnce({
      outcome: 'refused',
      message:
        "Job 'daily-report' refused: Scheduler job refused: resource posture=degraded, observed busyPercent=90",
      runId: 'schedule:built-in:daily-report:run-1',
    });

    const response = await app.request('/jobs/daily-report/run', {
      method: 'POST',
    });

    expect(response.status).toBe(422);
    await expect(json(response)).resolves.toMatchObject({
      success: false,
      code: 'scheduler_run_refused',
      outcome: 'refused',
      error:
        "Job 'daily-report' refused: Scheduler job refused: resource posture=degraded, observed busyPercent=90",
      data: {
        receipt: {
          outcome: 'refused',
        },
      },
    });
  });

  test('POST /jobs/:target/run projects hostile provider detail instead of serializing it outward', async () => {
    const { app, svc } = setup();
    svc.runJob.mockResolvedValueOnce({
      outcome: 'failed',
      message: 'provider token=secret and /private/path',
      runId: 'schedule:built-in:daily-report:run-1',
    });

    const response = await app.request('/jobs/daily-report/run', {
      method: 'POST',
    });
    expect(response.status).toBe(422);
    await expect(json(response)).resolves.toEqual({
      success: false,
      data: {
        output: 'Scheduler job failed. Inspect the associated run for details.',
        receipt: {
          outcome: 'failed',
          message:
            'Scheduler job failed. Inspect the associated run for details.',
          runId: 'schedule:built-in:daily-report:run-1',
        },
      },
      error: 'Scheduler job failed. Inspect the associated run for details.',
    });
  });

  test('PUT /jobs/:target edits a job', async () => {
    const { app, svc } = setup();
    const body = await json(
      await app.request('/jobs/daily-report', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'updated prompt' }),
      }),
    );
    expect(body.success).toBe(true);
    expect(svc.editJob).toHaveBeenCalledWith(
      'daily-report',
      expect.any(Object),
    );
  });

  test('POST /jobs/:target/run triggers a run', async () => {
    const { app, svc } = setup();
    const body = await json(
      await app.request('/jobs/daily-report/run', { method: 'POST' }),
    );
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ output: 'Scheduler job completed.' });
    expect(svc.runJob).toHaveBeenCalledWith('daily-report');
  });

  test('POST /jobs/:target/run adds a receipt without changing the legacy output field', async () => {
    const { app, svc } = setup();
    svc.runJob.mockResolvedValueOnce({
      outcome: 'completed',
      message: 'private provider detail',
      runId: 'schedule:built-in:daily-report:run-1',
    });

    const body = await json(
      await app.request('/jobs/daily-report/run', { method: 'POST' }),
    );
    expect(body).toEqual({
      success: true,
      data: {
        output: 'Scheduler job completed.',
        receipt: {
          outcome: 'completed',
          message: 'Scheduler job completed.',
          runId: 'schedule:built-in:daily-report:run-1',
        },
      },
    });
  });

  test('POST /jobs/:target/run preserves a completed result when its metric observer throws', async () => {
    const { app, svc } = setup();
    metricMocks.schedulerJobRunsAdd.mockImplementationOnce(() => {
      throw new Error('metrics unavailable');
    });
    svc.runJob.mockResolvedValueOnce({
      outcome: 'completed',
      message: 'private provider detail',
      runId: 'schedule:built-in:daily-report:run-1',
    });

    const response = await app.request('/jobs/daily-report/run', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toMatchObject({
      success: true,
      data: { receipt: { outcome: 'completed' } },
    });
  });

  // SDK schedulerMutate returns json.data — these return { success: true } with no data field.
  // That's fine (mutations don't use the return value), but verify the shape is stable.

  test('PUT /jobs/:target/enable returns { success: true }', async () => {
    const { app, svc } = setup();
    const body = await json(
      await app.request('/jobs/daily-report/enable', { method: 'PUT' }),
    );
    expect(body).toEqual({ success: true });
    expect(svc.enableJob).toHaveBeenCalledWith('daily-report');
  });

  test('PUT /jobs/:target/disable returns { success: true }', async () => {
    const { app, svc } = setup();
    const body = await json(
      await app.request('/jobs/daily-report/disable', { method: 'PUT' }),
    );
    expect(body).toEqual({ success: true });
    expect(svc.disableJob).toHaveBeenCalledWith('daily-report');
  });

  test('DELETE /jobs/:target returns { success: true }', async () => {
    const { app, svc } = setup();
    const body = await json(
      await app.request('/jobs/daily-report', { method: 'DELETE' }),
    );
    expect(body).toEqual({ success: true });
    expect(svc.removeJob).toHaveBeenCalledWith('daily-report');
  });
});
