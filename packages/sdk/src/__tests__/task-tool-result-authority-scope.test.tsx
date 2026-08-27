// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { useSessionToolResultQuery } from '../task-tool-results';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://mutable-global.test'),
}));
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const scopeA = {
  apiBase: 'http://station-a.test',
  authorityKey: 'connection-a:generation-1',
};
const scopeB = {
  apiBase: 'http://station-b.test',
  authorityKey: 'connection-b:generation-2',
};
let activeScope = scopeA;
function installScopeCredential() {
  setClientCredentialResolver(() => {
    const captured = activeScope;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => activeScope === captured,
      },
    };
  });
}
function response(text: string, status = 200) {
  return new Response(
    JSON.stringify(
      status === 200
        ? {
            success: true,
            data: {
              sessionId: 'same-session',
              eventId: 'same-event',
              result: {
                resultId: 'same-event',
                name: 'fixture-tool',
                terminalStatus: 'success',
                content: [{ type: 'text', text }],
                truncated: false,
                omittedParts: 0,
                omittedTextBytes: 0,
                omittedMetadataBytes: 0,
              },
            },
          }
        : { success: false, error: 'PRIVATE_OWNER_CANARY' },
    ),
    { status },
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

test('a new direct result query requires an explicit captured request scope', async () => {
  const { client, wrapper } = harness();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(response('SHOULD_NOT_FETCH'));
  vi.stubGlobal('fetch', fetch);
  const observer = renderHook(
    () => useSessionToolResultQuery('same-session', 'same-event'),
    { wrapper },
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(observer.result.current.data).toBeUndefined();
  observer.unmount();
  client.clear();
});

test('identical result IDs in different caller scopes cannot share or resurrect a pending response', async () => {
  const { client, wrapper } = harness();
  activeScope = scopeA;
  installScopeCredential();
  let releaseA!: (value: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    )
    .mockResolvedValueOnce(response('visible-b'));
  vi.stubGlobal('fetch', fetch);
  const observer = renderHook(
    ({ requestScope }) =>
      useSessionToolResultQuery('same-session', 'same-event', { requestScope }),
    {
      wrapper,
      initialProps: { requestScope: scopeA },
    },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'http://station-a.test/api/orchestration/sessions/same-session/tool-results/same-event',
  );
  const oldSignal = fetch.mock.calls[0]?.[1]?.signal;
  activeScope = scopeB;
  observer.rerender({ requestScope: scopeB });
  await waitFor(() =>
    expect(observer.result.current.data?.content).toEqual([
      { type: 'text', text: 'visible-b' },
    ]),
  );
  expect(oldSignal?.aborted).toBe(true);
  expect(fetch.mock.calls[1]?.[0]).toBe(
    'http://station-b.test/api/orchestration/sessions/same-session/tool-results/same-event',
  );
  await act(async () => {
    releaseA(response('PRIVATE_OLD_AUTHORITY_CANARY'));
  });
  expect(observer.result.current.data?.content).toEqual([
    { type: 'text', text: 'visible-b' },
  ]);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain('PRIVATE_OLD_AUTHORITY_CANARY');
  observer.unmount();
  client.clear();
});

test('two mounted direct-result observers both clear protected data and settle after an outage', async () => {
  const { client, wrapper } = harness();
  activeScope = scopeA;
  installScopeCredential();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response('protected-before'))
    .mockResolvedValue(response('', 503));
  vi.stubGlobal('fetch', fetch);
  const observer = renderHook(
    () => ({
      first: useSessionToolResultQuery('same-session', 'same-event', {
        requestScope: scopeA,
      }),
      second: useSessionToolResultQuery('same-session', 'same-event', {
        requestScope: scopeA,
      }),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(observer.result.current.second.data?.content).toEqual([
      { type: 'text', text: 'protected-before' },
    ]),
  );
  await act(async () => {
    await observer.result.current.first.refetch();
  });
  await waitFor(() => {
    expect(observer.result.current.first.data).toBeUndefined();
    expect(observer.result.current.second.data).toBeUndefined();
    expect(observer.result.current.first.error?.message).toBe(
      'Tool result unavailable',
    );
    expect(observer.result.current.second.error?.message).toBe(
      'Tool result unavailable',
    );
    expect(observer.result.current.first.isFetching).toBe(false);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  observer.unmount();
  client.clear();
});
