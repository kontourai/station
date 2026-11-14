/**
 * The tracker against a scripted service: it polls only while a client is
 * reading the task, on the interval after success, with doubling backoff to
 * the ceiling after vendor failures and the vendor's wait after a rate
 * limit, holds a task while the preview or policy is off, and stops for
 * everything else: a refusal only a person can fix, a store failure, and an
 * unexpected error.
 */
import type { RemoteTaskPolling } from '@kontourai/station-contracts/remote-task-engine';
import { describe, expect, test } from 'vitest';
import { createLogger } from '../../../utils/logger.js';
import { FeaturePreviewDisabledError } from '../../feature-previews/feature-preview-refusal.js';
import { RemoteTaskError } from '../remote-task-error.js';
import type { RemoteTaskSyncResult } from '../service.js';
import { RemoteTaskTracker } from '../tracker.js';

const POLLING: RemoteTaskPolling = { intervalMs: 10_000, maxBackoffMs: 60_000 };
const WINDOW = 15 * 60_000;

type Outcome = 'ok' | 'quiescent' | Error;

function setup(outcomes: Outcome[], options: { active?: boolean } = {}) {
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const syncs: string[] = [];
  const clock = { now: 1_000_000 };
  const tracker = new RemoteTaskTracker({
    service: {
      async syncTask(connectionId, taskId) {
        syncs.push(`${connectionId}/${taskId}`);
        const outcome = outcomes.shift() ?? 'ok';
        if (outcome instanceof Error) throw outcome;
        return { quiescent: outcome === 'quiescent' } as RemoteTaskSyncResult;
      },
      isActive: () => options.active ?? true,
      pollingFor: () => POLLING,
    },
    logger: createLogger({ name: 'remote-task-tracker-test' }),
    now: () => clock.now,
    interestWindowMs: WINDOW,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  /** Fire the newest pending timer, advancing the clock by its delay. */
  const fire = async () => {
    const timer = timers.filter((t) => !t.cleared).at(-1);
    if (!timer) throw new Error('nothing scheduled');
    timer.cleared = true;
    clock.now += timer.ms;
    timer.run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const pending = () => timers.filter((t) => !t.cleared).map((t) => t.ms);
  return { tracker, timers, syncs, fire, pending, clock };
}

const rateLimited = (retryAfterMs?: number) =>
  new RemoteTaskError('remote-task-rate-limited', 'slow down', 429, {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
const unavailable = () =>
  new RemoteTaskError('remote-task-vendor-unavailable', 'down', 503);

describe('RemoteTaskTracker', () => {
  test('nothing polls a task nobody has read', () => {
    const t = setup([]);
    expect(t.pending()).toEqual([]);
    expect(t.tracker.isTracking('c', 'task')).toBe(false);
  });

  test('a read starts polling, which stops once the task is quiescent', async () => {
    const t = setup(['ok', 'ok', 'quiescent']);
    t.tracker.noteInterest('c', 'task');
    expect(t.pending()).toEqual([0]);
    await t.fire();
    expect(t.pending()).toEqual([10_000]);
    await t.fire();
    expect(t.pending()).toEqual([10_000]);
    await t.fire();
    expect(t.pending()).toEqual([]);
    expect(t.syncs).toHaveLength(3);
  });

  test('a quiescent task is not polled on a read', () => {
    const t = setup([], { active: false });
    t.tracker.noteInterest('c', 'task');
    expect(t.pending()).toEqual([]);
  });

  test('polling stops when nobody has read the task within the window, and a read restarts it', async () => {
    const t = setup([]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    t.clock.now += WINDOW;
    await t.fire();
    expect(t.pending()).toEqual([]);
    expect(t.syncs).toHaveLength(1);
    t.tracker.noteInterest('c', 'task');
    expect(t.pending()).toEqual([0]);
  });

  test('repeated reads never shorten the cadence', async () => {
    const t = setup([]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    t.tracker.noteInterest('c', 'task');
    t.tracker.noteInterest('c', 'task');
    expect(t.pending()).toEqual([10_000]);
  });

  test('vendor failures double the delay up to the ceiling, and success resets it', async () => {
    const t = setup([
      unavailable(),
      unavailable(),
      unavailable(),
      unavailable(),
      'ok',
    ]);
    t.tracker.noteInterest('c', 'task');
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await t.fire();
      delays.push(t.pending()[0] as number);
    }
    expect(delays).toEqual([20_000, 40_000, 60_000, 60_000, 10_000]);
  });

  test("a rate limit waits at least the vendor's Retry-After", async () => {
    const t = setup([rateLimited(90_000), rateLimited()]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([90_000]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
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
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([60_000]);
    await t.fire();
    expect(t.pending()).toEqual([60_000]);
    await t.fire();
    expect(t.pending()).toEqual([10_000]);
  });

  test.each([
    ['remote-task-acknowledgement-required', 403],
    ['remote-task-credential-missing', 409],
    ['remote-task-not-found', 404],
    ['remote-task-store-failed', 500],
    ['remote-task-vendor-malformed', 502],
  ] as const)('%s stops tracking', async (code, status) => {
    const t = setup([new RemoteTaskError(code, 'stop', status)]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([]);
    expect(t.tracker.isTracking('c', 'task')).toBe(false);
  });

  test('after a failure only a person can fix, reads do not re-poll; a write or sync does', async () => {
    const t = setup([
      new RemoteTaskError('remote-task-vendor-refused', 'no', 502),
      'ok',
    ]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([]);
    for (let i = 0; i < 5; i += 1) t.tracker.noteInterest('c', 'task');
    expect(t.pending()).toEqual([]);
    expect(t.syncs).toHaveLength(1);
    t.tracker.noteInterest('c', 'task', { explicit: true });
    expect(t.pending()).toEqual([0]);
  });

  test('an unexpected error stops tracking instead of retrying forever', async () => {
    const t = setup([new Error('remote task exceeds the byte limit')]);
    t.tracker.noteInterest('c', 'task');
    await t.fire();
    expect(t.pending()).toEqual([]);
  });

  test('stop clears every pending poll', () => {
    const t = setup([]);
    t.tracker.noteInterest('c', 'a');
    t.tracker.noteInterest('c', 'b');
    t.tracker.stop();
    expect(t.pending()).toEqual([]);
    t.tracker.noteInterest('c', 'a');
    expect(t.pending()).toEqual([]);
  });
});
