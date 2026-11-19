import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs();
test('scheduler route requests and confirmed executions export separate populations', async () => {
  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  expect(metrics.setGlobalMeterProvider(provider)).toBe(true);
  const { SchedulerService } = await import('../scheduler-service.js');
  const { createSchedulerLedger } = await import('../scheduler-ledger.js');
  const { createSchedulerRoutes } = await import(
    '../../../routes/operations/scheduler.js'
  );
  const { createLogger } = await import('../../../utils/logger.js');
  const ledger = createSchedulerLedger({
    directory: makeTempDir('scheduler-telemetry-'),
  });
  // The ordinary scheduler startup tick sees an already-due occurrence.
  ledger.create({
    name: 'private-automatic-job',
    prompt: 'private-automatic-prompt',
    schedule: { kind: 'every', everyMs: 3_600_000 },
    enabled: true,
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  });
  const logger = createLogger({ name: 'scheduler-telemetry', level: 'warn' });
  const invoke = vi.fn(async ({ prompt }: { prompt: string }) => {
    if (prompt === 'refuse') {
      return { kind: 'definitely-not-invoked' as const, error: 'refused' };
    }
    if (prompt === 'fail') {
      return { kind: 'failed' as const, error: 'provider error' };
    }
    if (prompt === 'unknown') {
      return {
        kind: 'indeterminate' as const,
        error: 'provider response lost',
      };
    }
    return { kind: 'completed' as const, output: 'done' };
  });
  const scheduler = new SchedulerService({
    logger,
    builtin: { ledger, turnAdapter: { invoke } },
  });
  const routes = createSchedulerRoutes(scheduler, logger);
  const request = (method: string, path: string, body?: object) =>
    routes.request(path, {
      method,
      ...(body
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
  const latest = async () => {
    await provider.forceFlush();
    return exporter
      .getMetrics()
      .at(-1)!
      .scopeMetrics.flatMap((scope) => scope.metrics);
  };
  const jobRuns = async () =>
    (await latest()).find(
      (metric) => metric.descriptor.name === 'station.scheduler.job.runs',
    )?.dataPoints;
  const create = async (name: string, prompt: string) => {
    const response = await request('POST', '/jobs', {
      name,
      prompt,
      cron: '0 0 1 1 *',
    });
    expect(response.ok, await response.text()).toBe(true);
  };
  try {
    await vi.waitFor(async () =>
      expect(
        (await scheduler.getJobLogs('private-automatic-job'))[0],
      ).toMatchObject({
        state: 'completed',
        manual: false,
      }),
    );
    expect(await jobRuns()).toMatchObject([
      { attributes: { source: 'built-in', status: 'success' }, value: 1 },
    ]);

    await create('private-management-job', 'never execute');
    expect(
      (
        await request('PUT', '/jobs/private-management-job', {
          prompt: 'edited',
        })
      ).ok,
    ).toBe(true);
    expect(
      (await request('PUT', '/jobs/private-management-job/disable')).ok,
    ).toBe(true);
    expect(
      (await request('PUT', '/jobs/private-management-job/enable')).ok,
    ).toBe(true);
    expect((await request('DELETE', '/jobs/private-management-job')).ok).toBe(
      true,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await jobRuns()).toMatchObject([
      { attributes: { source: 'built-in', status: 'success' }, value: 1 },
    ]);

    for (const [prompt, status] of [
      ['complete', 200],
      ['fail', 409],
      ['refuse', 422],
      ['unknown', 409],
    ] as const) {
      const name = `private-manual-${prompt}`;
      await create(name, prompt);
      const result = await request('POST', `/jobs/${name}/run`);
      expect(result.status, await result.text()).toBe(status);
      if (prompt === 'fail' || prompt === 'unknown') {
        expect((await scheduler.getJobLogs(name))[0]?.state).toBe(
          prompt === 'fail' ? 'failed' : 'indeterminate',
        );
      }
    }
    const measured = await latest();
    const schedulerMetrics = measured.filter((metric) =>
      metric.descriptor.name.startsWith('station.scheduler.'),
    );
    const counts = measured.find(
      (metric) => metric.descriptor.name === 'station.scheduler.job.runs',
    );
    expect(
      counts?.dataPoints.map(({ attributes, value }) => ({
        attributes,
        value,
      })),
    ).toEqual([
      { attributes: { source: 'built-in', status: 'success' }, value: 2 },
      { attributes: { source: 'built-in', status: 'error' }, value: 1 },
    ]);
    const duration = measured.find(
      (metric) => metric.descriptor.name === 'station.scheduler.job.duration',
    );
    expect(duration?.dataPoints).toMatchObject([
      {
        attributes: { source: 'built-in', status: 'success' },
        value: { count: 2 },
      },
      {
        attributes: { source: 'built-in', status: 'error' },
        value: { count: 1 },
      },
    ]);
    const management = measured.find(
      (metric) =>
        metric.descriptor.name === 'station.scheduler.management.operations',
    );
    expect(
      management?.dataPoints.map(({ attributes, value }) => ({
        attributes,
        value,
      })),
    ).toEqual([
      { attributes: { op: 'create_job' }, value: 5 },
      { attributes: { op: 'edit_job' }, value: 1 },
      { attributes: { op: 'disable_job' }, value: 1 },
      { attributes: { op: 'enable_job' }, value: 1 },
      { attributes: { op: 'delete_job' }, value: 1 },
      { attributes: { op: 'run_job' }, value: 4 },
    ]);
    expect(JSON.stringify(schedulerMetrics)).not.toContain('private-');
  } finally {
    await scheduler.stop();
    await provider.shutdown();
    metrics.disable();
  }
});
