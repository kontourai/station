/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: async () => 'http://localhost:9999',
}));

const authenticatedFetch = vi.fn();
vi.mock('../client/http', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { fetchInsights, useInsightsQuery } = await import(
  '../query-domains/analytics'
);

describe('insights filters reach the server (station#3075)', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    });
  });

  function requestedUrl(): URL {
    return new URL(String(authenticatedFetch.mock.calls[0]?.[0]));
  }

  test('every filter is sent, not silently dropped', async () => {
    // The dimensions were always on the data; the endpoint refusing to use
    // them is what made answering "what did THIS agent run" a manual NDJSON
    // read. A filter the UI offers and the request omits is worse than no
    // filter: it returns everything under a narrowed label.
    await fetchInsights(7, { agent: 'alpha', tool: 'Bash', engine: 'codex' });

    const params = requestedUrl().searchParams;
    expect(params.get('days')).toBe('7');
    expect(params.get('agent')).toBe('alpha');
    expect(params.get('tool')).toBe('Bash');
    expect(params.get('engine')).toBe('codex');
  });

  test('an absent filter is absent, not an empty value', async () => {
    // `agent=` is not the same request as no agent at all — the route reads
    // a present-but-empty param as a filter for the empty string.
    await fetchInsights(14, { agent: 'alpha' });

    const params = requestedUrl().searchParams;
    expect(params.get('agent')).toBe('alpha');
    expect(params.has('tool')).toBe(false);
    expect(params.has('engine')).toBe(false);
    expect(params.has('limit')).toBe(false);
  });

  test('different filters produce different requests', async () => {
    // This is what keys the query cache. If two filter sets serialised the
    // same, switching agent would render the previous agent's numbers under
    // the new label — the rollup and its heading disagreeing about who they
    // describe.
    await fetchInsights(14, { agent: 'alpha' });
    await fetchInsights(14, { agent: 'beta' });

    const first = String(authenticatedFetch.mock.calls[0]?.[0]);
    const second = String(authenticatedFetch.mock.calls[1]?.[0]);
    expect(first).not.toBe(second);
  });
});

describe('filters key the query cache, not just the URL', () => {
  test('two filter sets occupy two cache entries', async () => {
    // THE claim this change rests on. Asserting the URL differs does not
    // establish it: the cache key is a separate argument, and dropping
    // `insightsQuery(...)` from it keeps every URL assertion green while
    // switching agent renders the previous agent's numbers under the new
    // label — the rollup and its heading describing different populations.
    const { QueryClient, QueryClientProvider } = await import(
      '@tanstack/react-query'
    );
    const { renderHook, waitFor } = await import('@testing-library/react');
    const React = await import('react');

    authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        children,
      );

    const alpha = renderHook(() => useInsightsQuery(14, { agent: 'alpha' }), {
      wrapper,
    });
    await waitFor(() => expect(alpha.result.current.isSuccess).toBe(true));
    const beta = renderHook(() => useInsightsQuery(14, { agent: 'beta' }), {
      wrapper,
    });
    await waitFor(() => expect(beta.result.current.isSuccess).toBe(true));

    const hashes = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryHash);
    expect(new Set(hashes).size).toBe(2);
  });
});
