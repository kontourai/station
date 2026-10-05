// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StationHttpError } from '../client/api-error-message';

/**
 * The conversation usage tree is polled while the stats dialog is open, but a
 * 404 (no orchestration record) or a 422 (tree past its bound) cannot change
 * by asking again, so those stop the poll. These drive the real hook through
 * a real QueryClient and count the reads the client module receives.
 */

const getConversationUsageTree = vi.hoisted(() => vi.fn());

vi.mock('../client/orchestration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/orchestration')>()),
  getConversationUsageTree,
}));

import { useConversationUsageTreeQuery } from '../query-domains/chatRuntimeOrchestration';

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, refetchOnWindowFocus: false },
          },
        })
      }
    >
      {children}
    </QueryClientProvider>
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('conversation usage tree polling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    getConversationUsageTree.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling a found tree at the asked interval', async () => {
    getConversationUsageTree.mockResolvedValue({ conversationId: 'c' });
    renderHook(
      () =>
        useConversationUsageTreeQuery('c', 'http://station.test', {
          refetchInterval: 1_000,
        }),
      { wrapper },
    );
    await advance(50);
    await advance(3_100);
    expect(getConversationUsageTree.mock.calls.length).toBeGreaterThanOrEqual(
      4,
    );
  });

  for (const status of [404, 422])
    it(`stops after a ${status}`, async () => {
      getConversationUsageTree.mockRejectedValue(
        new StationHttpError(status, 'refused'),
      );
      renderHook(
        () =>
          useConversationUsageTreeQuery('c', 'http://station.test', {
            refetchInterval: 1_000,
          }),
        { wrapper },
      );
      await advance(50);
      await advance(5_000);
      expect(getConversationUsageTree).toHaveBeenCalledTimes(1);
    });

  it('keeps polling through a transient failure', async () => {
    getConversationUsageTree.mockRejectedValue(
      new StationHttpError(503, 'unavailable'),
    );
    renderHook(
      () =>
        useConversationUsageTreeQuery('c', 'http://station.test', {
          refetchInterval: 1_000,
        }),
      { wrapper },
    );
    await advance(50);
    await advance(3_100);
    expect(getConversationUsageTree.mock.calls.length).toBeGreaterThan(1);
  });
});
