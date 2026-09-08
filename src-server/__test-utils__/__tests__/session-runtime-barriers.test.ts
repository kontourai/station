import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  awaitSessionAttachmentSettled,
  awaitSessionRecoveryCompleted,
  RUNTIME_BARRIER_TIMEOUT_MS,
} from '../session-runtime-barriers.js';

/**
 * The helper's whole job is the message on the failing arm, so that arm is
 * what the assertions read — an `await expect(...).rejects.toThrow()` with a
 * wildcard would pass for the generic runner timeout it exists to replace.
 */
describe('session runtime barrier waits (station#1707)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('resolves when the runtime settles, and arms no surviving timer', async () => {
    vi.useFakeTimers();
    const runtime = {
      whenSessionAttachmentSettled: () => Promise.resolve(),
    };

    await expect(
      awaitSessionAttachmentSettled(runtime),
    ).resolves.toBeUndefined();
    // The rejecting arm's timer must be cleared on the resolving path too:
    // a surviving one would hold the loop open and, worse, reject after the
    // test that armed it has finished.
    expect(vi.getTimerCount()).toBe(0);
  });

  test('rejects at the deadline, naming attachment', async () => {
    vi.useFakeTimers();
    const runtime = {
      // Never settles — the case the generic runner timeout reports as
      // `Test timed out in 30000ms` against the test's first line.
      whenSessionAttachmentSettled: () => new Promise<void>(() => {}),
    };

    const waiting = awaitSessionAttachmentSettled(runtime);
    const assertion = expect(waiting).rejects.toThrow(
      /^session attachment never settled for this runtime: initialize\(\) was not called, or its recovery chain never reached the finally that settles attachment within 10000ms\.$/,
    );

    // One tick short of the bound it must still be waiting; the deadline is
    // the assertion, not "some timer fired".
    await vi.advanceTimersByTimeAsync(RUNTIME_BARRIER_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  test('rejects at the deadline, naming recovery', async () => {
    vi.useFakeTimers();
    const runtime = {
      whenSessionRecoveryCompleted: () => new Promise<void>(() => {}),
    };

    const assertion = expect(
      awaitSessionRecoveryCompleted(runtime, { timeoutMs: 250 }),
    ).rejects.toThrow(
      'session recovery never completed for this runtime: initialize() was not called, or the recovery pass rejected before it returned within 250ms.',
    );
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});
