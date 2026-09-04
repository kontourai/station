// @vitest-environment jsdom
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  resolveSearchOpen,
  searchStation,
  unifiedSearchQueries,
  useUnifiedSearchQuery,
} from '../unified-search';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://ambient.test'),
}));
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const scopeA = { apiBase: 'https://station.test', authorityKey: 'epoch-a' };
const scopeB = { ...scopeA, authorityKey: 'epoch-b' };
const options = { requestScope: scopeA };
beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => true },
  }));
});
const request = { version: UNIFIED_SEARCH_V1, query: 'cobalt' };
function response(title = 'cobalt') {
  return new Response(
    JSON.stringify({
      success: true,
      data: {
        version: UNIFIED_SEARCH_V1,
        state: 'complete',
        results: [
          {
            version: UNIFIED_SEARCH_V1,
            key: title,
            providerId: 'station.tasks',
            owner: { kind: 'station', stationId: 'environment-a' },
            id: 'task',
            kind: 'task',
            scope: { projectId: 'project', taskId: 'task' },
            title,
            matchedFields: ['title'],
            currentness: {
              state: 'current',
              observedAt: '2026-09-04T00:00:00Z',
            },
            relevance: 1,
            openIntent: { kind: 'task', taskId: 'task', projectId: 'project' },
          },
        ],
        sources: [
          {
            providerId: 'station.tasks',
            owner: { kind: 'station', stationId: 'environment-a' },
            state: 'available',
          },
        ],
      },
    }),
  );
}
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}
test('missing host scope disables search instead of choosing ambient cache or destination', async () => {
  const { client, wrapper } = harness();
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  const hook = renderHook(() => useUnifiedSearchQuery(request), { wrapper });
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(hook.result.current.data).toBeUndefined();
  hook.unmount();
  client.clear();
});
test('same-origin authority replacement cannot publish an old delayed response or cached snippet', async () => {
  let active = scopeA;
  setClientCredentialResolver(() => {
    const captured = active;
    return {
      origin: captured.apiBase,
      requestAuthority: { ...captured, isCurrent: () => active === captured },
    };
  });
  let release!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce(response('new authority'));
  vi.stubGlobal('fetch', fetch);
  const { client, wrapper } = harness();
  const hook = renderHook(
    ({ scope }) =>
      useUnifiedSearchQuery(request, {
        requestScope: scope,
        keepPreviousData: true,
      }),
    { wrapper, initialProps: { scope: scopeA } },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  active = scopeB;
  hook.rerender({ scope: scopeB });
  await waitFor(() =>
    expect(hook.result.current.data?.results[0].title).toBe('new authority'),
  );
  await act(async () => {
    release(response('old protected snippet'));
  });
  expect(hook.result.current.data?.results[0].title).toBe('new authority');
  expect(
    client.getQueryData(unifiedSearchQueries.search(request, scopeA).queryKey),
  ).toBeUndefined();
  expect(unifiedSearchQueries.search(request, scopeA).queryKey).not.toEqual(
    unifiedSearchQueries.search(request, {
      ...scopeA,
      apiBase: 'https://other.test',
    }).queryKey,
  );
  hook.unmount();
  client.clear();
});
test('old servers are explicitly unsupported and do not become an empty result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response('not found', { status: 404 })),
  );
  await expect(
    searchStation(scopeA.apiBase, request, options),
  ).rejects.toMatchObject({
    kind: 'unsupported',
    status: 404,
  });
});
test('a denied refetch hides previously cached protected snippets', async () => {
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => true },
  }));
  let deny!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response('protected'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deny = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  const { client, wrapper } = harness();
  const hook = renderHook(
    () => useUnifiedSearchQuery(request, { requestScope: scopeA }),
    { wrapper },
  );
  await waitFor(() =>
    expect(hook.result.current.data?.results[0].title).toBe('protected'),
  );
  act(() => {
    void hook.result.current.refetch();
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(hook.result.current.data).toBeUndefined());
  await act(async () => {
    deny(new Response('{}', { status: 403 }));
  });
  await waitFor(() =>
    expect(hook.result.current.error).toMatchObject({ status: 403 }),
  );
  expect(hook.result.current.data).toBeUndefined();
  expect(
    client.getQueryData(unifiedSearchQueries.search(request, scopeA).queryKey),
  ).toBeUndefined();
  expect(hook.result.current.error).toMatchObject({ status: 403 });
  hook.unmount();
  client.clear();
});
test('malformed typed search hits cannot enter the SDK query cache', async () => {
  const malformed = (await response().json()) as any;
  malformed.data.results[0].openIntent = {
    kind: 'session-message',
    sessionId: 'session',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(malformed))),
  );
  await expect(
    searchStation(scopeA.apiBase, request, options),
  ).rejects.toMatchObject({
    kind: 'unavailable',
  });
});
test('read-only SDK sends exact resolve locator and refuses malformed success', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            state: 'resolved',
            target: {
              kind: 'session-message',
              sessionId: 's',
              matchedEventId: 'e',
              navigationMessageId: 'anchor',
            },
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { state: 'resolved', target: null },
        }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  expect(
    await resolveSearchOpen(
      scopeA.apiBase,
      {
        kind: 'session-message',
        sessionId: 's',
        matchedEventId: 'e',
      },
      options,
    ),
  ).toMatchObject({ target: { matchedEventId: 'e' } });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    kind: 'session-message',
    sessionId: 's',
    matchedEventId: 'e',
  });
  await expect(
    resolveSearchOpen(
      scopeA.apiBase,
      { kind: 'session', sessionId: 's' },
      options,
    ),
  ).rejects.toMatchObject({ kind: 'unavailable' });
});
test('direct clients reject absent, invalid or wrong-base scopes before transport', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const invalid of [
    undefined,
    {},
    { requestScope: { apiBase: scopeA.apiBase, authorityKey: '' } },
    { requestScope: { ...scopeA, apiBase: 'https://other.test' } },
  ]) {
    await expect(
      searchStation(scopeA.apiBase, request, invalid as any),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      resolveSearchOpen(
        scopeA.apiBase,
        { kind: 'session', sessionId: 's' },
        invalid as any,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  }
  expect(fetch).not.toHaveBeenCalled();
});
