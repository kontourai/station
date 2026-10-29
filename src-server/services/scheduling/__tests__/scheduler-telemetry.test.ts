import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs();
test('scheduler metrics export opaque job ids instead of private job names', async () => {
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
  const { createLogger } = await import('../../../utils/logger.js');
  const directory = makeTempDir('pr4289-r4-metrics-');
  const scheduler = new SchedulerService({
    logger: createLogger({ name: 'round4-metrics', level: 'warn' }),
    builtin: {
      ledger: createSchedulerLedger({ directory }),
      turnAdapter: {
        invoke: async () => ({ kind: 'completed', output: 'legacy output' }),
      },
      conversationRuns: {
        run: async () => ({
          kind: 'failed',
          error: 'round4-metrics-private-error',
          conversationId: 'conv-private',
        }),
      },
    },
  });
  try {
    await scheduler.addJob({
      name: 'round4-metrics-private-job',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      prompt: 'round4-metrics-private-prompt',
      target: { kind: 'conversation', conversationId: 'conv-private' },
      createdBy: { userId: 'victim' },
    });
    await scheduler.addJob({
      name: 'round5-legacy-private-job',
      schedule: { kind: 'every', everyMs: 3_600_000 },
      prompt: 'round5-legacy-private-prompt',
    });
    const jobs = await scheduler.listJobs();
    const ids = jobs.map((job) => job.unattendedPrincipal!.jobId);
    await scheduler.runJob('round4-metrics-private-job');
    await scheduler.runJob('round5-legacy-private-job');
    await provider.forceFlush();
    const schedulerMetrics = exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
      .filter((m) => m.descriptor.name.startsWith('station.scheduler.job.'));
    expect(schedulerMetrics.length).toBeGreaterThanOrEqual(2);
    const points = schedulerMetrics.flatMap((metric) =>
      metric.dataPoints.map((point) => point.attributes),
    );
    for (const id of ids)
      expect(points.some((point) => point.job_id === id)).toBe(true);
    expect(points.some((point) => point.status === 'success')).toBe(
      true,
    );
    expect(points.some((point) => point.status === 'error')).toBe(
      true,
    );
    expect(
      points.every((point) => !Object.hasOwn(point, 'job')),
    ).toBe(true);
    expect(JSON.stringify(schedulerMetrics)).not.toContain(
      'round5-legacy-private',
    );
    expect(JSON.stringify(schedulerMetrics)).not.toContain(
      'round4-metrics-private-job',
    );
  } finally {
    await scheduler.stop();
    await provider.shutdown();
    metrics.disable();
  }
});
