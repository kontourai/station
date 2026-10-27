/**
 * @vitest-environment jsdom
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';
import { useRetainedReadFailure } from '../useRetainedReadFailure';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A real client, not a mocked result: the defect lives in TanStack's own
// reset of a no-data query to `pending` when a refetch starts.
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const calls: Array<ReturnType<typeof deferred<string>>> = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    () => {
      const query = useQuery({
        queryKey: ['layout'],
        queryFn: () => {
          const call = deferred<string>();
          calls.push(call);
          return call.promise;
        },
      });
      return { query, failure: useRetainedReadFailure(query) };
    },
    { wrapper },
  );
  return { client, calls, view };
}

describe('useRetainedReadFailure', () => {
  test('a refetch after a failure keeps the failure, marked retrying', async () => {
    const { calls, view } = setup();
    const outage = new TypeError('Failed to fetch');
    await act(async () => calls[0]!.reject(outage));
    await waitFor(() => expect(view.result.current.query.isError).toBe(true));
    expect(view.result.current.failure).toEqual({
      error: outage,
      retrying: false,
    });

    act(() => void view.result.current.query.refetch());
    await waitFor(() => expect(calls).toHaveLength(2));

    // TanStack itself has dropped the error and gone back to loading — the
    // state that used to replace the error card with a skeleton.
    expect(view.result.current.query.isLoading).toBe(true);
    expect(view.result.current.query.error).toBeNull();
    expect(view.result.current.failure).toEqual({
      error: outage,
      retrying: true,
    });

    const second = new TypeError('Load failed');
    await act(async () => calls[1]!.reject(second));
    await waitFor(() =>
      expect(view.result.current.failure).toEqual({
        error: second,
        retrying: false,
      }),
    );
  });

  test('a successful retry clears the failure', async () => {
    const { calls, view } = setup();
    await act(async () => calls[0]!.reject(new Error('boom')));
    await waitFor(() => expect(view.result.current.failure).not.toBeNull());

    act(() => void view.result.current.query.refetch());
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => calls[1]!.resolve('layout'));

    await waitFor(() => expect(view.result.current.query.data).toBe('layout'));
    expect(view.result.current.failure).toBeNull();
  });

  test('held data wins over a failed refresh', async () => {
    const { calls, view } = setup();
    await act(async () => calls[0]!.resolve('layout'));
    await waitFor(() => expect(view.result.current.query.data).toBe('layout'));

    act(() => void view.result.current.query.refetch());
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => calls[1]!.reject(new Error('boom')));

    await waitFor(() => expect(view.result.current.query.isError).toBe(true));
    expect(view.result.current.failure).toBeNull();
  });

  test('a first load that never failed is not a failure', () => {
    const { view } = setup();
    expect(view.result.current.query.isLoading).toBe(true);
    expect(view.result.current.failure).toBeNull();
  });
});
