import { describe, expect, test } from 'vitest';
import { CompletionTracker } from '../completion-tracker.js';

describe('CompletionTracker', () => {
  test('waitForCurrent resolves immediately when idle', async () => {
    const tracker = new CompletionTracker();
    await expect(tracker.waitForCurrent()).resolves.toBeUndefined();
  });

  test('waitForCurrent resolves only after every snapshotted id completes', async () => {
    const tracker = new CompletionTracker();
    const a = tracker.begin();
    const b = tracker.begin();

    let resolved = false;
    const waiting = tracker.waitForCurrent().then(() => {
      resolved = true;
    });

    tracker.complete(a);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(tracker.isIdle).toBe(false);

    tracker.complete(b);
    await waiting;
    expect(resolved).toBe(true);
    expect(tracker.isIdle).toBe(true);
  });

  test('completion order does not matter — out-of-order completes still resolve the snapshot', async () => {
    const tracker = new CompletionTracker();
    const a = tracker.begin();
    const b = tracker.begin();
    const c = tracker.begin();

    const waiting = tracker.waitForCurrent();
    // Complete out of creation order.
    tracker.complete(c);
    tracker.complete(a);
    tracker.complete(b);
    await expect(waiting).resolves.toBeUndefined();
  });

  test('dispatches begun after the snapshot never block the waiter', async () => {
    const tracker = new CompletionTracker();
    const a = tracker.begin();

    const waiting = tracker.waitForCurrent();
    const b = tracker.begin(); // begun after the snapshot

    tracker.complete(a);
    await expect(waiting).resolves.toBeUndefined();
    expect(tracker.outstandingCount).toBe(1); // b is still outstanding

    tracker.complete(b);
    expect(tracker.isIdle).toBe(true);
  });
});
