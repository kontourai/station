/**
 * @vitest-environment jsdom
 */

/**
 * #2144 slice 3 — `useInvalidateQuery` returns the invalidation's promise.
 *
 * A caller that must not act until the refetch has landed awaits it (Settings
 * clears a project-override draft only after the project record has been
 * re-read, or the row flashes the pre-save value back). Returning `void`
 * would make that `await` resolve on the next microtask and look correct in
 * every test that does not control when the refetch finishes — so this one
 * controls it: the query function is a deferred promise nobody resolves until
 * the assertion has already proven the await is still pending.
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';
import { useInvalidateQuery } from '../query-core';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe('useInvalidateQuery', () => {
  test('the returned promise settles only once the refetch has', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let releaseFirst: (value: string) => void = () => {};
    let releaseSecond: (value: string) => void = () => {};
    let call = 0;
    const queryKey = ['deferred-subject'];
    client.setQueryDefaults(queryKey, {
      queryFn: () =>
        new Promise<string>((resolve) => {
          call += 1;
          if (call === 1) releaseFirst = resolve;
          else releaseSecond = resolve;
        }),
    });

    // A real mounted observer: `invalidateQueries` refetches ACTIVE queries,
    // so a cache entry with nobody watching it is only marked stale and the
    // promise has nothing to wait for. Mounting the query is what makes this
    // test able to fail at all.
    const observer = renderHook(
      () => ({
        query: useQuery({ queryKey }),
        invalidate: useInvalidateQuery(),
      }),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(call).toBe(1));
    releaseFirst('first');
    await waitFor(() =>
      expect(observer.result.current.query.data).toBe('first'),
    );

    let settled = false;
    const pending = observer.result.current.invalidate(queryKey).then(() => {
      settled = true;
    });

    // The refetch is in flight and nobody has resolved it. A `void` return
    // would have made `pending` resolve immediately, which is the whole
    // regression this pins.
    await waitFor(() => expect(call).toBe(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSecond('second');
    await pending;
    expect(settled).toBe(true);
  });
});
