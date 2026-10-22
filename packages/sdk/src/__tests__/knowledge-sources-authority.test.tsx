// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  useCreateKnowledgeRootMutation,
  useDeleteKnowledgeRootMutation,
  useKnowledgeRootsQuery,
} from '../query-domains/knowledgeStores';

const scopeA = { apiBase: 'http://station.test', authorityKey: 'account-a' };
const scopeB = { ...scopeA, authorityKey: 'account-b' };
function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('root queries isolate same-host accounts and discard a late old-authority response', async () => {
  let active = scopeA;
  setClientCredentialResolver(() => {
    const captured = active;
    return {
      origin: captured.apiBase,
      requestAuthority: { ...captured, isCurrent: () => active === captured },
    };
  });
  let releaseA!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseA = resolve;
        }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, data: [{ id: 'source-b' }] }),
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const observer = renderHook(
    ({ requestScope }) =>
      useKnowledgeRootsQuery({ requestScope, requireRequestScope: true }),
    { wrapper: wrapper(client), initialProps: { requestScope: scopeA } },
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  active = scopeB;
  observer.rerender({ requestScope: scopeB });
  expect(observer.result.current.data).toBeUndefined();
  await waitFor(() =>
    expect(observer.result.current.data).toEqual([{ id: 'source-b' }]),
  );
  await act(async () =>
    releaseA(
      new Response(
        JSON.stringify({ success: true, data: [{ id: 'private-a' }] }),
      ),
    ),
  );
  expect(observer.result.current.data).toEqual([{ id: 'source-b' }]);
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain('private-a');
});

test('captured source mutations cannot dispatch under a replacement account', async () => {
  let active = scopeA;
  setClientCredentialResolver(() => ({
    origin: active.apiBase,
    requestAuthority: { ...active, isCurrent: () => true },
  }));
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  const mutation = renderHook(
    () => ({
      create: useCreateKnowledgeRootMutation(scopeA),
      disconnect: useDeleteKnowledgeRootMutation(scopeA),
    }),
    { wrapper: wrapper(client) },
  );
  active = scopeB;
  await act(async () => {
    await expect(
      mutation.result.current.create.mutateAsync({
        scope: { kind: 'project', projectSlug: 'acme' },
        adapterId: 'kit-default-store',
      }),
    ).rejects.toThrow();
    await expect(
      mutation.result.current.disconnect.mutateAsync('root:private-a'),
    ).rejects.toThrow();
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('missing required scope cannot reveal primed legacy roots or dispatch on manual refetch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(['knowledge', 'roots'], [{ id: 'legacy-private' }]);
  const observer = renderHook(
    () => useKnowledgeRootsQuery({ requireRequestScope: true, retry: false }),
    { wrapper: wrapper(client) },
  );
  expect(observer.result.current.data).toBeUndefined();
  await act(async () => {
    const result = await observer.result.current.refetch();
    expect(result.error).toBeTruthy();
    expect(result.data).toBeUndefined();
  });
  expect(fetch).not.toHaveBeenCalled();
});
