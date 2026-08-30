import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import {
  NativeInvocationStorageUnavailableError,
  RunService,
} from '../../../services/orchestration/run-service.js';
import { SchedulerStorageUnavailableError } from '../../../services/scheduling/scheduler-ledger.js';
import { createRunRoutes } from '../runs.js';

const logger = { error: vi.fn() };
const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
});
const alphaAuthority = () =>
  sessionReadAuthorityFromRequest(
    'alpha-user',
    { tenantId: tenantId('alpha') },
    hostedRegistry,
  );

describe('Run Routes', () => {
  test('GET / lists mixed-source runs through a neutral read surface', async () => {
    const service = {
      listRuns: vi.fn().mockResolvedValue([
        {
          runId: 'orchestration:codex:thread-1',
          providerId: 'codex',
          source: 'orchestration',
          sourceId: 'thread-1',
          status: 'completed',
          startedAt: '2026-04-25T12:00:00.000Z',
          updatedAt: '2026-04-25T12:00:03.000Z',
          retryEligible: false,
          attempt: 1,
        },
        {
          runId: 'schedule:built-in:daily:daily-1',
          providerId: 'built-in',
          source: 'schedule',
          sourceId: 'daily',
          status: 'failed',
          startedAt: '2026-04-25T12:00:00.000Z',
          updatedAt: '2026-04-25T12:00:03.000Z',
          retryEligible: true,
          attempt: 1,
        },
      ]),
      readRun: vi.fn(),
      readOutput: vi.fn(),
    };
    const app = createRunRoutes(service as any, logger as any, () =>
      sessionReadAuthorityFromRequest('test-user', undefined, undefined),
    );

    const res = await app.request('/?source=schedule&providerId=built-in');
    const body = await readJson(res);

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(service.listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'test-user', mode: 'personal' }),
      {
        source: 'schedule',
        providerId: 'built-in',
        sourceId: undefined,
      },
    );
  });

  test('GET / accepts the canonical voice run source filter', async () => {
    const service = {
      listRuns: vi.fn().mockResolvedValue([]),
      readRun: vi.fn(),
      readOutput: vi.fn(),
    };
    const app = createRunRoutes(service as any, logger as any, () =>
      sessionReadAuthorityFromRequest('test-user', undefined, undefined),
    );
    const res = await app.request('/?source=voice');
    expect(res.status).toBe(200);
    expect(service.listRuns).toHaveBeenCalledWith(expect.anything(), {
      source: 'voice',
      providerId: undefined,
      sourceId: undefined,
    });
  });

  test('GET /:runId reads a run by source-qualified id', async () => {
    const service = {
      listRuns: vi.fn(),
      readRun: vi.fn().mockResolvedValue({
        runId: 'schedule:built-in:daily:daily-1',
        providerId: 'built-in',
        source: 'schedule',
        sourceId: 'daily',
        status: 'completed',
        startedAt: '2026-04-25T12:00:00.000Z',
        updatedAt: '2026-04-25T12:00:03.000Z',
        retryEligible: false,
        attempt: 1,
      }),
      readOutput: vi.fn(),
    };
    const app = createRunRoutes(service as any, logger as any, () =>
      sessionReadAuthorityFromRequest('test-user', undefined, undefined),
    );

    const res = await app.request('/schedule:built-in:daily:daily-1');
    const body = await readJson(res);

    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      runId: 'schedule:built-in:daily:daily-1',
      source: 'schedule',
    });
  });

  test('POST /output resolves opaque output references through the service bridge', async () => {
    const service = {
      listRuns: vi.fn(),
      readRun: vi.fn(),
      readOutput: vi.fn().mockResolvedValue('run output'),
    };
    const app = createRunRoutes(service as any, logger as any, () =>
      sessionReadAuthorityFromRequest('test-user', undefined, undefined),
    );

    const ref = {
      source: 'schedule',
      providerId: 'built-in',
      runId: 'schedule:built-in:daily:daily-1',
      artifactId: 'daily-1',
      kind: 'output',
    };
    const res = await app.request('/output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ref),
    });
    const body = await readJson(res);

    expect(body).toEqual({ success: true, data: { content: 'run output' } });
    expect(service.readOutput).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ userId: 'test-user', mode: 'personal' }),
    );
  });

  test('hosted mode omits unbound schedule runs and output while retaining authorized orchestration runs', async () => {
    const orchestrationService = {
      listAgentRuns: vi.fn().mockResolvedValue([
        {
          runId: 'alpha-thread',
          sessionId: 'alpha-thread',
          providerId: 'codex',
          startedAt: '2026-04-25T12:00:00.000Z',
          updatedAt: '2026-04-25T12:00:03.000Z',
          status: 'completed',
          attempt: 1,
          eventCount: 1,
        },
      ]),
      readAgentRun: vi.fn(),
    };
    const schedulerService = {
      listRunSummaries: vi.fn(),
      readRunSummary: vi.fn(),
      readOutputRef: vi.fn(),
    };
    const service = new RunService(
      orchestrationService as any,
      schedulerService as any,
      {
        begin: () => ({ kind: 'unavailable' }),
        list: () => ({ kind: 'available', runs: [] }),
        read: () => ({ kind: 'available', run: null }),
        reconcile: () => ({ kind: 'available' }),
      } as any,
      {
        list: () => ({ kind: 'available', runs: [] }),
        read: () => ({ kind: 'available', run: null }),
      } as any,
    );
    const app = createRunRoutes(service, logger as any, alphaAuthority);

    const list = await readJson(await app.request('/?source=schedule'));
    const detail = await app.request('/schedule:built-in:daily:daily-1');
    const output = await app.request('/output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'schedule',
        providerId: 'built-in',
        runId: 'schedule:built-in:daily:daily-1',
        artifactId: 'daily-1',
        kind: 'output',
      }),
    });

    expect(list).toEqual({ success: true, data: [] });
    expect(detail.status).toBe(404);
    expect(output.status).toBe(404);
    expect(schedulerService.listRunSummaries).not.toHaveBeenCalled();
    expect(schedulerService.readRunSummary).not.toHaveBeenCalled();
    expect(schedulerService.readOutputRef).not.toHaveBeenCalled();

    const orchestration = await readJson(await app.request('/'));
    expect(orchestration.data).toEqual([
      expect.objectContaining({
        source: 'orchestration',
        sourceId: 'alpha-thread',
      }),
    ]);
    expect(orchestrationService.listAgentRuns).toHaveBeenCalledWith(
      alphaAuthority(),
    );
  });

  test('does not expose mutation routes', async () => {
    const app = createRunRoutes(
      { listRuns: vi.fn(), readRun: vi.fn(), readOutput: vi.fn() } as any,
      logger as any,
    );

    expect((await app.request('/', { method: 'POST' })).status).toBe(404);
    expect(
      (
        await app.request('/schedule:built-in:daily:daily-1', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);
  });

  test('maps scheduler durable-state unavailability to 503', async () => {
    const app = createRunRoutes(
      {
        listRuns: vi
          .fn()
          .mockRejectedValue(new SchedulerStorageUnavailableError()),
        readRun: vi.fn(),
        readOutput: vi.fn(),
      } as any,
      logger as any,
    );

    const response = await app.request('/');
    expect(response.status).toBe(503);
    await expect(readJson(response)).resolves.toMatchObject({
      success: false,
      error: 'Scheduler storage is temporarily unavailable',
    });
  });

  test('maps native invoke run-storage unavailability to 503', async () => {
    const app = createRunRoutes(
      {
        listRuns: vi
          .fn()
          .mockRejectedValue(new NativeInvocationStorageUnavailableError()),
        readRun: vi.fn(),
        readOutput: vi.fn(),
      } as any,
      logger as any,
    );

    expect((await app.request('/?source=invoke')).status).toBe(503);
  });
});
