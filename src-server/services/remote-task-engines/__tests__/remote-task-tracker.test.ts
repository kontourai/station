/**
 * The tracker's cadence against a scripted service: interval after success,
 * doubling backoff to the ceiling after failures, the vendor's wait after a
 * rate limit, a held (not dropped) task while the preview or policy is off,
 * a stop for refusals only a person can fix, and resume after restart.
 */
import type { RemoteTaskPolling } from '@kontourai/station-contracts/remote-task-engine';
import { describe, expect, test } from 'vitest';
import { createLogger } from '../../../utils/logger.js';
import { FeaturePreviewDisabledError } from '../../feature-previews/feature-preview-refusal.js';
import { RemoteTaskError } from '../remote-task-error.js';
import type { RemoteTaskSyncResult } from '../service.js';
import { RemoteTaskTracker } from '../tracker.js';

const POLLING: RemoteTaskPolling = { intervalMs: 10_000, maxBackoffMs: 60_000 };

type Outcome = 'ok' | 'quiescent' | Error;

function setup(outcomes: Outcome[], active: Array<[string, string]> = []) {
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const syncs: string[] = [];
  const tracker = new RemoteTaskTracker({
    service: {
      async syncTask(connectionId, taskId) {
        syncs.push(`${connectionId}/${taskId}`);
        const outcome = outcomes.shift() ?? 'ok';
        if (outcome instanceof Error) throw outcome;
        return { quiescent: outcome === 'quiescent' } as RemoteTaskSyncResult;
      },
      activeTasks: () =>
        active.map(([connectionId, taskId]) => ({ connectionId, taskId })),
      pollingFor: () => POLLING,
    },
    logger: createLogger({ name: 'remote-task-tracker-test' }),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  /** Fire the newest pending timer and wait for its poll to settle. */
  const fire = async () => {
    const timer = timers.filter((t) => !t.cleared).at(-1);
    if (!timer) throw new Error('nothing scheduled');
    timer.cleared = true;
    timer.run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const pending = () => timers.filter((t) => !t.cleared).map((t) => t.ms);
  return { tracker, timers, syncs, fire, pending };
}

const rateLimited = (retryAfterMs?: number) =>
  new RemoteTaskError('remote-task-rate-limited', 'slow down', 429, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
const unavailable = () =>
  new RemoteTaskError('remote-task-vendor-unavailable', 'down', 503);

describe('RemoteTaskTracker', () => {
  test('polls on the interval until the task is quiescent', async () => {
    const t = setup(['ok', 'ok', 'quiescent']);
    t.tracker.track('c', 'task');
    expect(t.pending()).toEqual([0]);
    await t.fire();
    expect(t.pending()).toEqual([10_000]);
    await t.fire();
    expect(t.pending()).toEqual([10_000]);
    await t.fire();
    expect(t.pending()).toEqual([]);
    expect(t.tracker.isTracking('c', 'task')).toBe(false);
    expect(t.syncs).toHaveLength(3);
  });

  test('failures double the delay up to the ceiling, and success resets it', async () => {
    const t = setup([
      unavailable(),
      unavailable(),
      unavailable(),
      unavailable(),
      'ok',
    ]);
    t.tracker.track('c', 'task');
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await t.fire();
      delays.push(t.pending()[0] as number);
    }
    expect(delays).toEqual([20_000, 40_000, 60_000, 60_000, 10_000]);
  });

  test("a rate limit waits at least the vendor's Retry-After", async () => {
    const t = setup([rateLimited(90_000), rateLimited()]);
    t.tracker.track('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([90_000]);
    await t.fire();
    // Without a wait: the doubled backoff, capped at the ceiling.
    expect(t.pending()).toEqual([60_000]);
  });

  test('a preview or policy refusal holds the task and retries; turning it on resumes', async () => {
    const t = setup([
      new FeaturePreviewDisabledError(
        'remote-task-engines',
        'Remote task engines',
      ),
      new RemoteTaskError('remote-task-policy-refused', 'managed', 403),
      'ok',
    ]);
    t.tracker.track('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([60_000]);
    await t.fire();
    expect(t.pending()).toEqual([60_000]);
    await t.fire();
    expect(t.pending()).toEqual([10_000]);
  });

  test('a refusal only a person can fix stops tracking', async () => {
    for (const code of [
      'remote-task-acknowledgement-required',
      'remote-task-credential-missing',
      'remote-task-not-found',
    ] as const) {
      const t = setup([new RemoteTaskError(code, 'fix it', 403)]);
      t.tracker.track('c', 'task');
      await t.fire();
      expect(t.pending(), code).toEqual([]);
      expect(t.tracker.isTracking('c', 'task')).toBe(false);
    }
  });

  test('resume schedules every stored active task at once', () => {
    const t = setup(
      [],
      [
        ['c1', 'a'],
        ['c2', 'b'],
      ],
    );
    t.tracker.resume();
    expect(t.pending()).toEqual([0, 0]);
    expect(t.tracker.isTracking('c1', 'a')).toBe(true);
    expect(t.tracker.isTracking('c2', 'b')).toBe(true);
  });

  test('stop clears every pending poll', () => {
    const t = setup([]);
    t.tracker.track('c', 'a');
    t.tracker.track('c', 'b');
    t.tracker.stop();
    expect(t.pending()).toEqual([]);
    t.tracker.track('c', 'a');
    expect(t.pending()).toEqual([]);
  });
});
