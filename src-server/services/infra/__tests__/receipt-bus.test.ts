import { afterEach, describe, expect, test, vi } from 'vitest';
import { receiptBus, waitForReceipt } from '../receipt-bus.js';

describe('ReceiptBus', () => {
  afterEach(() => {
    receiptBus.resetForTest();
  });

  test('publish() is a no-op with no subscribers (never throws)', () => {
    expect(() =>
      receiptBus.publish({
        kind: 'turn.event.projected',
        threadId: 'thread-1',
        reason: 'completed',
      }),
    ).not.toThrow();
  });

  test('subscribeForTest() receives every published receipt', () => {
    const received: unknown[] = [];
    const unsubscribe = receiptBus.subscribeForTest((receipt) => {
      received.push(receipt);
    });

    receiptBus.publish({
      kind: 'turn.event.projected',
      threadId: 'thread-1',
      turnId: 'turn-1',
      reason: 'completed',
    });
    receiptBus.publish({
      kind: 'session.recovery.completed',
      attemptedCount: 0,
      threadIds: [],
    });

    expect(received).toEqual([
      {
        kind: 'turn.event.projected',
        threadId: 'thread-1',
        turnId: 'turn-1',
        reason: 'completed',
      },
      { kind: 'session.recovery.completed', attemptedCount: 0, threadIds: [] },
    ]);
    unsubscribe();
  });

  test('unsubscribe stops further delivery', () => {
    const received: unknown[] = [];
    const unsubscribe = receiptBus.subscribeForTest((receipt) => {
      received.push(receipt);
    });
    unsubscribe();

    receiptBus.publish({
      kind: 'turn.event.projected',
      threadId: 'thread-1',
      reason: 'aborted',
    });

    expect(received).toEqual([]);
  });

  test('a listener that throws does not stop delivery to other listeners or propagate to publish()', () => {
    const received: unknown[] = [];
    receiptBus.subscribeForTest(() => {
      throw new Error('boom');
    });
    receiptBus.subscribeForTest((receipt) => {
      received.push(receipt);
    });

    expect(() =>
      receiptBus.publish({
        kind: 'coalescing.drained',
        worker: 'test-worker',
      }),
    ).not.toThrow();
    expect(received).toEqual([
      { kind: 'coalescing.drained', worker: 'test-worker' },
    ]);
  });

  test('resetForTest() drops every subscriber', () => {
    const received: unknown[] = [];
    receiptBus.subscribeForTest((receipt) => {
      received.push(receipt);
    });
    expect(receiptBus.subscriberCountForTest).toBe(1);

    receiptBus.resetForTest();
    expect(receiptBus.subscriberCountForTest).toBe(0);

    receiptBus.publish({
      kind: 'turn.event.projected',
      threadId: 'thread-1',
      reason: 'completed',
    });
    expect(received).toEqual([]);
  });

  describe('waitForReceipt', () => {
    test('resolves with the first matching receipt published after the call', async () => {
      const promise = waitForReceipt<
        Extract<
          import('../receipt-bus.js').OrchestrationTestReceipt,
          { kind: 'turn.event.projected' }
        >
      >(
        (receipt) =>
          receipt.kind === 'turn.event.projected' &&
          receipt.threadId === 'thread-2',
      );

      receiptBus.publish({
        kind: 'turn.event.projected',
        threadId: 'thread-1',
        reason: 'completed',
      });
      receiptBus.publish({
        kind: 'turn.event.projected',
        threadId: 'thread-2',
        turnId: 'turn-9',
        reason: 'aborted',
      });

      await expect(promise).resolves.toEqual({
        kind: 'turn.event.projected',
        threadId: 'thread-2',
        turnId: 'turn-9',
        reason: 'aborted',
      });
    });

    test('rejects after the timeout when no matching receipt arrives', async () => {
      vi.useFakeTimers();
      try {
        const promise = waitForReceipt(
          (receipt) => receipt.kind === 'coalescing.drained',
          25,
        );
        const assertion = expect(promise).rejects.toThrow(/timed out/i);
        await vi.advanceTimersByTimeAsync(25);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    test('unsubscribes once resolved so it never leaks a listener', async () => {
      const promise = waitForReceipt(
        (receipt) => receipt.kind === 'session.recovery.completed',
      );
      receiptBus.publish({
        kind: 'session.recovery.completed',
        attemptedCount: 1,
        threadIds: ['thread-1'],
      });
      await promise;
      expect(receiptBus.subscriberCountForTest).toBe(0);
    });
  });

  describe('production-facing guard', () => {
    test('subscribeForTest() throws outside a test environment', () => {
      const originalVitest = process.env.VITEST;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => receiptBus.subscribeForTest(() => {})).toThrow(
          /test-only/i,
        );
      } finally {
        if (originalVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = originalVitest;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    });

    test('waitForReceipt() throws outside a test environment', () => {
      const originalVitest = process.env.VITEST;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => waitForReceipt(() => true)).toThrow(/test-only/i);
      } finally {
        if (originalVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = originalVitest;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    });

    test('resetForTest() throws outside a test environment', () => {
      const originalVitest = process.env.VITEST;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      try {
        expect(() => receiptBus.resetForTest()).toThrow(/test-only/i);
      } finally {
        if (originalVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = originalVitest;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    });

    test('publish() never throws outside a test environment either', () => {
      const originalVitest = process.env.VITEST;
      const originalNodeEnv = process.env.NODE_ENV;
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      try {
        expect(() =>
          receiptBus.publish({
            kind: 'turn.event.projected',
            threadId: 'thread-1',
            reason: 'completed',
          }),
        ).not.toThrow();
      } finally {
        if (originalVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = originalVitest;
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });
});
