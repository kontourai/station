import { describe, expect, test, vi } from 'vitest';
import { shutdownOptionalNetworkWork } from '../optional-network-shutdown.js';

describe('shutdownOptionalNetworkWork', () => {
  test('gives all optional work one total budget and aborts every participant', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const logger = { warn: vi.fn() };
    const shutdown = shutdownOptionalNetworkWork(
      ['usage', 'future-exporter'].map((name) => ({
        name,
        shutdown: (signal: AbortSignal) => {
          signals.push(signal);
          return new Promise<void>(() => {});
        },
      })),
      { budgetMs: 25, logger },
    );

    await vi.advanceTimersByTimeAsync(24);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toBeUndefined();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test('contains participant faults and does not spend the remaining budget', async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    await expect(
      shutdownOptionalNetworkWork(
        [
          {
            name: 'broken',
            shutdown: async () => Promise.reject(new Error('boom')),
          },
          { name: 'healthy', shutdown: async () => {} },
        ],
        { budgetMs: 10_000, logger },
      ),
    ).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Optional network shutdown failed: broken',
      expect.objectContaining({ message: 'boom' }),
    );
    vi.useRealTimers();
  });
});
