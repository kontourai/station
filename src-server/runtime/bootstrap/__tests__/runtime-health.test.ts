import { afterEach, describe, expect, test, vi } from 'vitest';
import { runtimeEventLoopLag } from '../../../telemetry/metrics.js';
import {
  EVENT_LOOP_STALL_REPORT_DELAY_MS,
  EVENT_LOOP_STALL_WARN_MS,
  runRuntimeHealthChecks,
  startRuntimeEventLoopLagMonitoring,
  startRuntimeHealthChecks,
} from '../runtime-health.js';

const idleResources = {
  cpuUserMicros: 0,
  cpuSystemMicros: 0,
  majorPageFaults: 0,
  rssBytes: 0,
  heapUsedBytes: 0,
};

describe('runtime-health', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('startRuntimeHealthChecks runs immediately and schedules repeats', async () => {
    vi.useFakeTimers();
    const runHealthChecks = vi.fn(async () => {});
    const timers: NodeJS.Timeout[] = [];
    const logger = { debug: vi.fn(), warn: vi.fn() };

    await startRuntimeHealthChecks({
      timers,
      logger,
      interval: 1000,
      runHealthChecks,
    });

    expect(runHealthChecks).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);

    expect(runHealthChecks).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith('Health checks started', {
      interval: 1000,
    });

    for (const timer of timers) clearInterval(timer);
  });

  test('records monotonic event-loop lag and treats early wakeups as zero', () => {
    let now = 100;
    let tick: (() => void) | undefined;
    const timers: NodeJS.Timeout[] = [];
    const logger = { debug: vi.fn() };
    const recordLag = vi.fn();
    const timer = {} as NodeJS.Timeout;

    startRuntimeEventLoopLagMonitoring({
      timers,
      logger,
      interval: 1_000,
      now: () => now,
      scheduleInterval: (callback) => {
        tick = callback;
        return timer;
      },
      recordLag,
    });

    now = 1_175;
    tick?.();
    now = 2_100;
    tick?.();

    expect(recordLag).toHaveBeenNthCalledWith(1, 75);
    expect(recordLag).toHaveBeenNthCalledWith(2, 0);
    expect(timers).toEqual([timer]);
    expect(logger.debug).toHaveBeenCalledWith(
      'Event-loop lag monitoring started',
      { interval: 1_000 },
    );
  });

  test('records the sample through the shared runtime event-loop histogram', () => {
    let now = 0;
    let tick: (() => void) | undefined;
    const record = vi.spyOn(runtimeEventLoopLag, 'record');

    startRuntimeEventLoopLagMonitoring({
      timers: [],
      logger: { debug: vi.fn() },
      interval: 100,
      now: () => now,
      scheduleInterval: (callback) => {
        tick = callback;
        return {} as NodeJS.Timeout;
      },
    });

    now = 150;
    tick?.();

    expect(record).toHaveBeenCalledWith(50);
  });

  // #2327: a stall between two ticks was invisible to the sampled lag, and
  // the metric is exported only when OTel is configured.
  test('writes a stall of at least the warning threshold to the log, then resets the window', () => {
    let tick: (() => void) | undefined;
    const reports: Array<() => void> = [];
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const histogram = {
      enable: vi.fn(),
      reset: vi.fn(),
      max: 0,
      percentile: vi.fn(() => 40 * 1e6),
    };

    startRuntimeEventLoopLagMonitoring({
      timers: [],
      logger,
      interval: 10_000,
      now: () => 0,
      scheduleInterval: (callback) => {
        tick = callback;
        return {} as NodeJS.Timeout;
      },
      recordLag: vi.fn(),
      delayHistogram: histogram,
      sampleResources: () => idleResources,
      observeGc: () => {},
      scheduleReport: (report, delayMs) => {
        expect(delayMs).toBe(EVENT_LOOP_STALL_REPORT_DELAY_MS);
        reports.push(report);
      },
    });
    expect(histogram.enable).toHaveBeenCalledTimes(1);

    histogram.max = (EVENT_LOOP_STALL_WARN_MS - 1) * 1e6;
    tick?.();
    expect(reports).toHaveLength(0);
    expect(histogram.reset).toHaveBeenCalledTimes(1);

    histogram.max = 17_842 * 1e6;
    tick?.();
    expect(histogram.reset).toHaveBeenCalledTimes(2);
    expect(reports).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
    reports[0]();
    expect(logger.warn).toHaveBeenCalledWith(
      'Event loop stalled',
      expect.objectContaining({
        maxDelayMs: 17_842,
        p99DelayMs: 40,
        windowMs: 10_000,
      }),
    );
  });

  // The 2026-10 probe-failure restarts logged 72s and 86s stalls with nothing
  // to say whether the process was computing, collecting garbage, or waiting
  // on swap. The stall line carries the window's own counters.
  test('attributes a stall window its CPU time, page faults, memory, and the GCs that started in it', () => {
    let now = 1_000;
    let tick: (() => void) | undefined;
    let onGc: ((startTime: number, durationMs: number) => void) | undefined;
    const reports: Array<() => void> = [];
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const histogram = {
      enable: vi.fn(),
      reset: vi.fn(),
      max: 0,
      percentile: vi.fn(() => 0),
    };
    let resources = {
      cpuUserMicros: 5_000_000,
      cpuSystemMicros: 1_000_000,
      majorPageFaults: 300,
      rssBytes: 200 * 1024 * 1024,
      heapUsedBytes: 90 * 1024 * 1024,
    };

    startRuntimeEventLoopLagMonitoring({
      timers: [],
      logger,
      interval: 10_000,
      now: () => now,
      scheduleInterval: (callback) => {
        tick = callback;
        return {} as NodeJS.Timeout;
      },
      recordLag: vi.fn(),
      delayHistogram: histogram,
      sampleResources: () => resources,
      observeGc: (callback) => {
        onGc = callback;
      },
      scheduleReport: (report) => reports.push(report),
    });

    // A quiet window: GC in it must not leak into the stalled one.
    onGc?.(4_000, 30);
    now = 11_000;
    tick?.();

    onGc?.(12_000, 5);
    resources = {
      cpuUserMicros: 5_000_000 + 61_400_000,
      cpuSystemMicros: 1_000_000 + 2_600_000,
      majorPageFaults: 300 + 41_250,
      rssBytes: 1_210 * 1024 * 1024,
      heapUsedBytes: 845 * 1024 * 1024,
    };
    histogram.max = 72_276 * 1e6;
    histogram.percentile.mockReturnValue(72_276 * 1e6);
    now = 93_000;
    tick?.();
    // Node delivers a GC's entry after the loop resumes, so the pause that
    // made this stall arrives after the tick that measured it.
    onGc?.(20_000, 66_000);
    // A GC in the next window belongs to that window.
    onGc?.(93_500, 7);
    expect(reports).toHaveLength(1);
    reports[0]();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Event loop stalled', {
      maxDelayMs: 72_276,
      p99DelayMs: 72_276,
      windowMs: 10_000,
      elapsedMs: 82_000,
      cpuUserMs: 61_400,
      cpuSystemMs: 2_600,
      majorPageFaults: 41_250,
      rssMb: 1_210,
      heapUsedMb: 845,
      gcCount: 2,
      gcTotalMs: 66_005,
      gcMaxMs: 66_000,
    });

    // The late next-window GC is reported with that window, not dropped.
    now = 103_000;
    histogram.max = 2_000 * 1e6;
    tick?.();
    reports[1]();
    expect(logger.warn).toHaveBeenLastCalledWith(
      'Event loop stalled',
      expect.objectContaining({ gcCount: 1, gcTotalMs: 7, cpuUserMs: 0 }),
    );
  });

  // Reaches the real process counters and the real `gc` performance entries,
  // whose delivery after the loop resumes is why the report is deferred.
  test('a real stall report counts the CPU and GC the stall spent', async () => {
    let tick: (() => void) | undefined;
    const warned = new Promise<Record<string, unknown>>((resolve) => {
      startRuntimeEventLoopLagMonitoring({
        timers: [],
        logger: {
          debug: vi.fn(),
          warn: (_message, metadata) => resolve(metadata ?? {}),
        },
        interval: 10_000,
        scheduleInterval: (callback) => {
          tick = callback;
          return {} as NodeJS.Timeout;
        },
        recordLag: vi.fn(),
        delayHistogram: {
          enable: vi.fn(),
          reset: vi.fn(),
          max: EVENT_LOOP_STALL_WARN_MS * 1e6,
          percentile: () => 0,
        },
      });
    });

    // Hold the loop with allocation so the stall both burns CPU and collects.
    // Bounded by this process's CPU time, not wall time: on a loaded runner a
    // wall-clock bound can get far less CPU than it waited.
    const cpuAtStart = process.cpuUsage();
    const cpuSpentMs = () => {
      const spent = process.cpuUsage(cpuAtStart);
      return (spent.user + spent.system) / 1e3;
    };
    let retained: Array<{ index: number }> = [];
    while (cpuSpentMs() < 150) {
      for (let index = 0; index < 50_000; index += 1) retained.push({ index });
      if (retained.length > 1_000_000) retained = [];
    }
    tick?.();

    const report = await warned;
    expect(report.gcCount).toBeGreaterThan(0);
    expect(report.gcTotalMs).toBeGreaterThanOrEqual(0);
    expect(
      (report.cpuUserMs as number) + (report.cpuSystemMs as number),
    ).toBeGreaterThanOrEqual(150);
    expect(report.rssMb).toBeGreaterThan(0);
    expect(report.heapUsedMb).toBeGreaterThan(0);
  });

  test('rejects an invalid event-loop lag monitor interval', () => {
    expect(() =>
      startRuntimeEventLoopLagMonitoring({
        timers: [],
        logger: { debug: vi.fn() },
        interval: 0,
      }),
    ).toThrow(/positive integer/i);
  });

  test('runRuntimeHealthChecks emits health snapshots for registered Agents', async () => {
    const emitHealth = vi.fn();

    await runRuntimeHealthChecks({
      activeAgents: new Map([
        [
          'default',
          {
            model: { id: 'model-1' },
          },
        ],
      ]),
      agentSpecs: new Map([
        [
          'default',
          {
            tools: {
              mcpServers: ['docs'],
            },
          },
        ],
      ]),
      memoryAdapters: new Map([['default', {}]]),
      mcpConnectionStatus: new Map([['docs', { connected: true }]]),
      integrationMetadata: new Map([
        ['docs', { type: 'mcp', transport: 'stdio', toolCount: 3 }],
      ]),
      monitoringEmitter: { emitHealth },
    });

    expect(emitHealth).toHaveBeenCalledTimes(1);
    expect(emitHealth.mock.calls[0][0]).toMatchObject({
      slug: 'default',
      healthy: true,
      checks: {
        loaded: true,
        hasModel: true,
        hasMemory: true,
        integrationsConfigured: true,
        integrationsConnected: true,
      },
    });
  });
});
