// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import {
  useCreateKnowledgeRootMutation,
  useDeleteKnowledgeRootMutation,
  useImportKnowledgeDocumentsMutation,
  useKnowledgeGraphQuery,
  useKnowledgeRecordQuery,
  useKnowledgeRootsQuery,
  useKnowledgeSourceCapabilitiesQuery,
  useResumeKnowledgeDocumentImportMutation,
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
      importDocuments: useImportKnowledgeDocumentsMutation(scopeA),
      resumeImport: useResumeKnowledgeDocumentImportMutation(scopeA),
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
    const expectedRoot = {
      id: 'root:private-a',
      scope: { kind: 'project' as const, projectSlug: 'acme' },
      adapterId: 'kit-default-store',
      storeRoot: '/test/store',
      displayName: 'Test',
      createdAt: '2026-10-22T00:00:00Z',
    };
    await expect(
      mutation.result.current.importDocuments.mutateAsync({
        requestId: '11111111-1111-4111-8111-111111111111',
        expectedRoot,
        documents: [{ filename: 'notes.md', contentBase64: 'bm90ZXM=' }],
      }),
    ).rejects.toThrow();
    await expect(
      mutation.result.current.resumeImport.mutateAsync({
        requestId: '11111111-1111-4111-8111-111111111111',
        expectedRoot,
        retryUncertain: true,
      }),
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

test.each(['graph', 'record'] as const)(
  '%s reads cannot reuse another account cache for colliding source identities',
  async (kind) => {
    let active = scopeA;
    setClientCredentialResolver(() => ({
      origin: active.apiBase,
      requestAuthority: { ...active, isCurrent: () => true },
    }));
    const dataA =
      kind === 'graph'
        ? {
            nodes: [
              {
                id: 'record',
                type: 'raw',
                title: 'Private A',
                category: 'test',
              },
            ],
            edges: [],
          }
        : {
            id: 'record',
            type: 'raw',
            title: 'Private A',
            body: 'Private A',
            category: 'test',
            provenance: { agent: 'fixture' },
            created_at: '2026-10-22T00:00:00Z',
            updated_at: '2026-10-22T00:00:00Z',
          };
    const dataB =
      kind === 'graph'
        ? {
            nodes: [
              { id: 'record', type: 'raw', title: 'B', category: 'test' },
            ],
            edges: [],
          }
        : { ...dataA, title: 'B', body: 'B' };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: dataA })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: dataB })),
      );
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const useSource =
      kind === 'graph'
        ? (scope: typeof scopeA) =>
            useKnowledgeGraphQuery('same-root', {
              requestScope: scope,
              requireRequestScope: true,
            })
        : (scope: typeof scopeA) =>
            useKnowledgeRecordQuery('same-root', 'record', {
              requestScope: scope,
              requireRequestScope: true,
            });
    const observer = renderHook(({ scope }) => useSource(scope), {
      wrapper: wrapper(client),
      initialProps: { scope: scopeA },
    });
    await waitFor(() => expect(observer.result.current.data).toEqual(dataA));
    active = scopeB;
    observer.rerender({ scope: scopeB });
    expect(observer.result.current.data).toBeUndefined();
    await waitFor(() => expect(observer.result.current.data).toEqual(dataB));
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

test('management capabilities stay inert without scope and do not cross same-host accounts', async () => {
  let active = scopeA;
  setClientCredentialResolver(() => ({
    origin: active.apiBase,
    requestAuthority: { ...active, isCurrent: () => true },
  }));
  const first = {
    canManageSources: true,
    canAttachLegacy: true,
    canCheckHostPaths: true,
  };
  const second = {
    canManageSources: false,
    canAttachLegacy: false,
    canCheckHostPaths: false,
  };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: first })),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: second })),
    );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(['knowledge', 'source-capabilities'], first);
  const initialProps: { scope: typeof scopeA | undefined } = {
    scope: undefined,
  };
  const observer = renderHook(
    ({ scope }: { scope: typeof scopeA | undefined }) =>
      useKnowledgeSourceCapabilitiesQuery(scope),
    { wrapper: wrapper(client), initialProps },
  );
  expect(observer.result.current.data).toBeUndefined();
  await act(async () => {
    const result = await observer.result.current.refetch();
    expect(result.error).toBeTruthy();
  });
  expect(fetch).not.toHaveBeenCalled();
  observer.rerender({ scope: scopeA });
  await waitFor(() => expect(observer.result.current.data).toEqual(first));
  active = scopeB;
  observer.rerender({ scope: scopeB });
  expect(observer.result.current.data).toBeUndefined();
  await waitFor(() => expect(observer.result.current.data).toEqual(second));
});
