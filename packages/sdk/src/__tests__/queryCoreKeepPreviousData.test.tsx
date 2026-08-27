/**
 * @vitest-environment jsdom
 */

/**
 * station#3092 — no query in the app held its previous data across a key
 * change, so every keyed panel blanked to a loading state on selection
 * change. `useApiQuery`'s opt-in `keepPreviousData` is the mechanism fix;
 * this file proves the mechanism itself against a REAL QueryClient (not a
 * mocked `useQuery`), because the honesty contract lives entirely in
 * `isPlaceholderData` timing that a mock can't reproduce faithfully.
 *
 * Two things must both be true and are asserted independently:
 *  (a) with `keepPreviousData: true`, a key change holds the previous
 *      result — `data` stays populated, `isLoading` stays false — while
 *      `isPlaceholderData` flips true for exactly that held render, then
 *      false once the new key's real data lands.
 *  (b) with `keepPreviousData` unset (the untouched default for the other
 *      ~400 call sites), a key change still blanks to the loading state,
 *      proving the opt-in is not a silent global default.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
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

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

async function fetchForKey(key: string): Promise<string> {
  return `data-for-${key}`;
}

describe('useApiQuery keepPreviousData (station#3092)', () => {
  test("holds the previous key's data across a key change and marks it via isPlaceholderData", async () => {
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string }) =>
        useApiQuery<string>(['subject', subject], () => fetchForKey(subject), {
          keepPreviousData: true,
        }),
      { wrapper: wrapperFor(client), initialProps: { subject: 'proj-a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('data-for-proj-a'));
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.isLoading).toBe(false);

    // Switch the key — the honesty-critical instant. Old data must still be
    // on screen (not undefined) and NOT presented as fresh: isLoading false
    // (would read as a normal, un-marked loading state), isPlaceholderData
    // true (the marker every consumer keys its "refreshing" UI off of).
    rerender({ subject: 'proj-b' });
    expect(result.current.data).toBe('data-for-proj-a');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPlaceholderData).toBe(true);

    // Once proj-b's real data lands, the hold releases and the marker
    // clears — this is not a permanently-stale render.
    await waitFor(() => expect(result.current.data).toBe('data-for-proj-b'));
    expect(result.current.isPlaceholderData).toBe(false);
  });

  test('a SAME-key background refetch is not marked as held — the "showing the previous project" copy must never be a lie', async () => {
    // Load-bearing, and previously an untested assumption about a third-party
    // library. Consumers render copy that literally says the user is looking
    // at the PREVIOUS subject's data. If `isPlaceholderData` were also true
    // during an ordinary same-key refresh, that sentence would be false —
    // the honesty defect this feature exists to prevent, inverted.
    const client = newClient();
    const { result } = renderHook(
      () =>
        useApiQuery<string>(
          ['subject', 'proj-a'],
          () => fetchForKey('proj-a'),
          {
            keepPreviousData: true,
          },
        ),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.data).toBe('data-for-proj-a'));
    expect(result.current.isPlaceholderData).toBe(false);

    // Refetch the SAME key. Data stays, a fetch is genuinely in flight, but
    // nothing is being held from another subject, so the marker stays off.
    await act(async () => {
      await client.refetchQueries({ queryKey: ['subject', 'proj-a'] });
    });

    expect(result.current.data).toBe('data-for-proj-a');
    expect(result.current.isPlaceholderData).toBe(false);
  });

  test('a first load (no previous data) still reports isLoading, not a held placeholder', async () => {
    const client = newClient();
    const { result } = renderHook(
      () =>
        useApiQuery<string>(
          ['subject', 'proj-a'],
          () => fetchForKey('proj-a'),
          {
            keepPreviousData: true,
          },
        ),
      { wrapper: wrapperFor(client) },
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();

    await waitFor(() => expect(result.current.data).toBe('data-for-proj-a'));
  });

  test('without keepPreviousData (the untouched default), a key change blanks to loading — proving this is opt-in, not global', async () => {
    const client = newClient();
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string }) =>
        useApiQuery<string>(['subject-no-hold', subject], () =>
          fetchForKey(subject),
        ),
      { wrapper: wrapperFor(client), initialProps: { subject: 'proj-a' } },
    );

    await waitFor(() => expect(result.current.data).toBe('data-for-proj-a'));

    rerender({ subject: 'proj-b' });
    // No opt-in => no hold: this is exactly the pre-fix, blanking behavior
    // that must remain the default for every other query in the app.
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isPlaceholderData).toBe(false);

    await waitFor(() => expect(result.current.data).toBe('data-for-proj-b'));
  });
});
