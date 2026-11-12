// @vitest-environment jsdom
/**
 * Leaving the Tools section while Check all runs must not drop its answer:
 * the batch ran on the server and may have changed what servers offer, so the
 * tool server list still refreshes. Only the unmounted view's state stops
 * updating. Runs the real SDK mutation against a stubbed fetch.
 */
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { useCheckAllToolServers } from '../useCheckAllToolServers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('leaving while Check all runs still refreshes the tool server list when it answers', async () => {
  _setApiBase('http://localhost');
  let answer!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const fetchMock = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        signal = init?.signal;
        answer = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useCheckAllToolServers([]), { wrapper });
  let finished!: Promise<void>;
  act(() => {
    finished = view.result.current.run();
  });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
    '/integrations/check-all',
  );
  view.unmount();
  expect(signal?.aborted ?? false).toBe(false);
  answer(
    new Response(
      JSON.stringify({ success: true, data: { results: [], reloaded: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  await finished;
  await vi.waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['integrations'] }),
  );
});
