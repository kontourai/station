import { afterEach, describe, expect, test, vi } from 'vitest';
import { runtimeEventLoopLag } from '../../../telemetry/metrics.js';
import {
  runRuntimeHealthChecks,
  EVENT_LOOP_STALL_WARN_MS,
  startRuntimeEventLoopLagMonitoring,
  startRuntimeHealthChecks,
} from '../runtime-health.js';

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
    });
    expect(histogram.enable).toHaveBeenCalledTimes(1);

    histogram.max = (EVENT_LOOP_STALL_WARN_MS - 1) * 1e6;
    tick?.();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(histogram.reset).toHaveBeenCalledTimes(1);

    histogram.max = 17_842 * 1e6;
    tick?.();
    expect(logger.warn).toHaveBeenCalledWith('Event loop stalled', {
      maxDelayMs: 17_842,
      p99DelayMs: 40,
      windowMs: 10_000,
    });
    expect(histogram.reset).toHaveBeenCalledTimes(2);
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
