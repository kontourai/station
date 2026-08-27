// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { useTasksQuery } from '../query-domains/taskGraph';

const scopeA = {
  apiBase: 'http://same-station.test',
  authorityKey: 'connection-a:1',
};
const scopeB = {
  apiBase: 'http://same-station.test',
  authorityKey: 'connection-b:2',
};

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function response(data: unknown, status = 200) {
  return new Response(
    JSON.stringify(status === 200 ? { success: true, data } : data),
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

test('scoped task destinations withhold an old same-origin authority response and never use it as a placeholder', async () => {
  let active = scopeA;
  setClientCredentialResolver(() => {
    const captured = active;
    return {
      origin: captured.apiBase,
      requestAuthority: {
        ...captured,
        isCurrent: () => active === captured,
      },
    };
  });
  let releaseA!: (value: Response) => void;
  let releaseB!: (value: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseB = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  const { client, wrapper } = harness();
  const observer = renderHook(
    ({ requestScope }) => useTasksQuery('project-a', { requestScope }),
    { wrapper, initialProps: { requestScope: scopeA } },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  active = scopeB;
  observer.rerender({ requestScope: scopeB });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(observer.result.current.data).toBeUndefined();
  await act(async () => releaseB(response([{ id: 'task-b' }])));
  await waitFor(() =>
    expect(observer.result.current.data).toEqual([{ id: 'task-b' }]),
  );
  await act(async () => releaseA(response([{ id: 'PRIVATE_TASK_A' }])));
  expect(observer.result.current.data).toEqual([{ id: 'task-b' }]);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain('PRIVATE_TASK_A');
  observer.unmount();
  client.clear();
});

test('scoped task destination failures stay generic and withhold cache', async () => {
  setClientCredentialResolver(() => ({
    origin: scopeA.apiBase,
    requestAuthority: { ...scopeA, isCurrent: () => true },
  }));
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response({ error: 'PRIVATE_TASK_URL' }, 503)),
  );
  const { client, wrapper } = harness();
  const observer = renderHook(
    () => useTasksQuery('project-a', { requestScope: scopeA }),
    { wrapper },
  );
  await waitFor(() => {
    expect(observer.result.current.data).toBeUndefined();
    expect(observer.result.current.error?.message).toBe(
      'Task destinations unavailable',
    );
  });
  observer.unmount();
  client.clear();
});
