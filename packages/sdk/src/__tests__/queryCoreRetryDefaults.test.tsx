/**
 * @vitest-environment jsdom
 */

/**
 * station#2327 — `useApiQuery` used to pass `retry: config?.retry` even when
 * the caller configured none. query-core merges `{ ...defaults, ...options }`,
 * so that explicit `undefined` erased the QueryClient's own `retry` default and
 * the retryer fell back to its built-in three. These tests use a REAL
 * QueryClient because the defect lives entirely in that merge.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';
import { useApiQuery } from '../query-core';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe('useApiQuery retry defaults (station#2327)', () => {
  test('an unconfigured query honours the QueryClient default retry', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    let attempts = 0;
    const { result } = renderHook(
      () =>
        useApiQuery<string>(['retry-default'], async () => {
          attempts += 1;
          throw new Error('Station did not answer');
        }),
      { wrapper: wrapperFor(client) },
    );

    // Generous: with the defect, the client's `retryDelay: 0` is ALSO erased
    // and query-core's own backoff (1s, 2s, 4s) runs before the error lands,
    // so a reverted fix reads as `attempts === 4` rather than as a timeout.
    await waitFor(() => expect(result.current.isError).toBe(true), {
      timeout: 15_000,
    });
    // One attempt plus the client's single retry. The pre-fix code reached
    // four (query-core's own fallback of three retries).
    expect(attempts).toBe(2);
  });

  test("a caller's explicit retry still overrides the client default", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
    });
    let attempts = 0;
    const { result } = renderHook(
      () =>
        useApiQuery<string>(
          ['retry-explicit'],
          async () => {
            attempts += 1;
            throw new Error('Station did not answer');
          },
          { retry: false },
        ),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(attempts).toBe(1);
  });
});
