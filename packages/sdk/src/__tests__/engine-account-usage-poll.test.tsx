// @vitest-environment jsdom

/**
 * `useEngineAccountUsageQuery` asks the provider live on every read. The
 * engine's own page polls it every minute; a summary of many engines passes
 * `poll: false` and must read each once per visit.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const getJson = vi.hoisted(() => vi.fn());
vi.mock('../client/http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/http')>()),
  getJson,
}));

import { useEngineAccountUsageQuery } from '../engine-accounts';

const scope = { apiBase: 'http://station.test', authorityKey: 'k' };

beforeEach(() => {
  vi.useFakeTimers();
  getJson.mockReset();
  getJson.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            status: 'unknown',
            fetchedAt: '2026-11-12T10:00:00.000Z',
            reason: 'Not reported.',
          },
        }),
        { status: 200 },
      ),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(options?: { poll?: boolean }) {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(
    () => useEngineAccountUsageQuery('claude', 'work', scope, true, options),
    { wrapper },
  );
  return { client, hook };
}

test.each([
  ['polls every minute by default', undefined, 3],
  ['reads once with poll: false', { poll: false }, 1],
])('%s', async (_name, options, reads) => {
  const { client, hook } = mount(options);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(hook.result.current.data?.status).toBe('unknown');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
  });
  expect(getJson).toHaveBeenCalledTimes(reads);
  hook.unmount();
  client.clear();
});
