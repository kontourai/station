import { describe, expect, test, vi } from 'vitest';
import { commitForkOpenBoundary } from '../components/chat-dock/forkOpenBoundary';

describe('fork scoped open boundary', () => {
  test('alternate-workspace cancel during hydration leaves routing untouched', () => {
    const controller = new AbortController();
    const route = vi.fn();
    controller.abort();
    expect(
      commitForkOpenBoundary({
        signal: controller.signal,
        generation: 1,
        currentGeneration: () => 1,
        route,
      }),
    ).toBe(false);
    expect(route).not.toHaveBeenCalled();
  });

  test('successful hydration commits the alternate route exactly once', () => {
    const route = vi.fn();
    expect(
      commitForkOpenBoundary({
        signal: new AbortController().signal,
        generation: 2,
        currentGeneration: () => 2,
        route,
      }),
    ).toBe(true);
    expect(route).toHaveBeenCalledTimes(1);
  });
});
