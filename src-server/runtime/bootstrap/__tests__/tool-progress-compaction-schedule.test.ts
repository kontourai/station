import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { MS_PER_DAY, MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { FeaturePreviewSelector } from '../../../services/feature-previews/feature-preview-registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import * as metrics from '../../../telemetry/metrics.js';
import { startToolProgressCompaction } from '../tool-progress-compaction-schedule.js';

/**
 * #5078: the scheduled pass runs only while the Feature Preview is on and the
 * environment kill switch is not set, reads both at every pass, and records
 * what each pass deleted. Driven against a real EventStore.
 */

const THREAD = 'thread-schedule';
const OLD = '2026-01-01T00:00:00.000Z';
/** Forty days ahead: with the 30-day default, every row here is old. */
const now = () => Date.now() + 40 * MS_PER_DAY;

describe('tool.progress compaction schedule (#5078)', () => {
  const makeTempDir = trackTempDirs();
  let store: EventStore;
  let previewEnabled: boolean;
  const preview: FeaturePreviewSelector = {
    select: (branches) =>
      previewEnabled ? branches.enabled() : branches.disabled(),
  };
  const logger = { info: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    store = new EventStore(
      join(makeTempDir('tool-progress-schedule-'), 'orchestration.sqlite'),
    );
    previewEnabled = true;
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
  });

  function append(event: Record<string, unknown>): void {
    store.appendEvent({
      provider: 'claude',
      threadId: THREAD,
      turnId: 'turn-1',
      createdAt: OLD,
      ...event,
    } as unknown as CanonicalRuntimeEvent);
  }

  /** One settled turn whose call reported three progress updates. */
  function seed(): void {
    store.upsertSession({
      provider: 'claude',
      threadId: THREAD,
      status: 'ready',
      createdAt: OLD,
      updatedAt: OLD,
    });
    append({ eventId: 'start', method: 'turn.started', prompt: 'go' });
    append({
      eventId: 'tool',
      method: 'tool.started',
      itemId: 'call',
      toolCallId: 'call',
      toolName: 'shell',
    });
    for (const id of ['p1', 'p2', 'p3'])
      append({
        eventId: id,
        method: 'tool.progress',
        itemId: 'call',
        toolCallId: 'call',
        message: id,
      });
    append({
      eventId: 'done',
      method: 'tool.completed',
      itemId: 'call',
      toolCallId: 'call',
      toolName: 'shell',
      status: 'success',
    });
    append({ eventId: 'end', method: 'turn.completed', finishReason: 'stop' });
  }

  const progressIds = () =>
    store
      .listEventPayloads(THREAD, ['tool.progress'])
      .map((event) => event.eventId);

  function start(env: NodeJS.ProcessEnv = {}) {
    return startToolProgressCompaction({
      timers: [],
      eventStore: store,
      preview,
      logger,
      env,
      now,
      scheduleTimeout: (() => 0) as unknown as typeof setTimeout,
    });
  }

  test('does nothing while the Feature Preview is off', async () => {
    previewEnabled = false;
    const passes = vi.spyOn(metrics.toolProgressCompactionPasses, 'add');
    expect(await start().runPass()).toBe('disabled');
    expect(progressIds()).toEqual(['p1', 'p2', 'p3']);
    expect(passes).toHaveBeenCalledWith(1, { outcome: 'disabled' });
  });

  test.each(['off', 'OFF', '0'])(
    'the kill switch %s wins over an enabled preview',
    async (value) => {
      const passes = vi.spyOn(metrics.toolProgressCompactionPasses, 'add');
      expect(
        await start({ STATION_TOOL_PROGRESS_COMPACTION: value }).runPass(),
      ).toBe('killed');
      expect(progressIds()).toEqual(['p1', 'p2', 'p3']);
      expect(passes).toHaveBeenCalledWith(1, { outcome: 'killed' });
    },
  );

  test('reads the switches at every pass', async () => {
    const schedule = start();
    previewEnabled = false;
    expect(await schedule.runPass()).toBe('disabled');
    previewEnabled = true;
    expect(await schedule.runPass()).toBe('completed');
    expect(progressIds()).toEqual(['p3']);
  });

  test('records rows and bytes deleted by a pass', async () => {
    const passes = vi.spyOn(metrics.toolProgressCompactionPasses, 'add');
    const rows = vi.spyOn(metrics.toolProgressCompactionRows, 'add');
    const bytes = vi.spyOn(metrics.toolProgressCompactionBytes, 'add');
    const duration = vi.spyOn(metrics.toolProgressCompactionDuration, 'record');
    expect(await start().runPass()).toBe('completed');
    expect(progressIds()).toEqual(['p3']);
    expect(passes).toHaveBeenCalledWith(1, { outcome: 'completed' });
    expect(rows).toHaveBeenCalledWith(2, { table: 'events' });
    expect(rows).toHaveBeenCalledWith(0, { table: 'content' });
    const eventBytes = bytes.mock.calls.find(
      ([, attributes]) => attributes?.table === 'events',
    );
    expect(eventBytes?.[0]).toBeGreaterThan(0);
    expect(duration).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      'Compacted superseded tool progress rows',
      expect.objectContaining({ rows: 2, threads: 1 }),
    );
  });

  test('the minimum age comes from the environment', async () => {
    expect(
      await start({
        STATION_TOOL_PROGRESS_COMPACTION_MIN_AGE_DAYS: '3650',
      }).runPass(),
    ).toBe('completed');
    expect(progressIds()).toEqual(['p1', 'p2', 'p3']);
  });

  test('a stopped schedule deletes nothing', async () => {
    const schedule = start();
    schedule.stop();
    await schedule.runPass();
    expect(progressIds()).toEqual(['p1', 'p2', 'p3']);
  });

  test('first runs ten minutes after start, then every thirty minutes', () => {
    const timers: NodeJS.Timeout[] = [];
    const timeouts: Array<[() => void, number]> = [];
    const intervals: number[] = [];
    previewEnabled = false;
    startToolProgressCompaction({
      timers,
      eventStore: store,
      preview,
      logger,
      env: {},
      scheduleTimeout: ((callback: () => void, delay: number) => {
        timeouts.push([callback, delay]);
        return 1;
      }) as unknown as typeof setTimeout,
      scheduleInterval: ((_callback: () => void, delay: number) => {
        intervals.push(delay);
        return 2;
      }) as unknown as typeof setInterval,
    });
    expect(timeouts.map(([, delay]) => delay)).toEqual([10 * MS_PER_MINUTE]);
    expect(intervals).toEqual([]);
    timeouts[0]![0]();
    expect(intervals).toEqual([30 * MS_PER_MINUTE]);
    expect(timers).toHaveLength(2);
  });
});
