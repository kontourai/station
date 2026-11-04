/** @vitest-environment jsdom */
import type { ToolLibraryView } from '@kontourai/station-contracts/tool-library';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { useToolLibrary } from '../tool-library';

const scope = {
  apiBase: 'http://station.test',
  authorityKey: 'same-station-credential',
};
const clients: QueryClient[] = [];

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

function catalog(name: string): ToolLibraryView {
  return {
    sources: [
      {
        id: name,
        kind: 'integration',
        name,
        from: 'Connected account',
        installed: true,
        enabled: true,
        permitted: true,
        operatorOnly: false,
        tools: [],
      },
    ],
    operator: false,
    canManageAgents: true,
    canManagePolicy: false,
    project: { id: 'project-a', slug: 'alpha', name: 'Alpha' },
    policy: { mode: 'all', sources: [], revision: 1 },
  };
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error('Response not initialized');
  };
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

let activeClient: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={activeClient}>{children}</QueryClientProvider>
  );
}

test.each(['cached', 'pending'] as const)(
  'a principal change on the same Station withholds the previous %s catalog',
  async (previousState) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    clients.push(client);
    activeClient = client;
    setClientCredentialResolver(() => ({
      origin: scope.apiBase,
      requestAuthority: { ...scope, isCurrent: () => true },
    }));
    const previous = deferredResponse();
    const next = deferredResponse();
    const alice = catalog('Alice account tools');
    const bob = catalog('Bob account tools');
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== `${scope.apiBase}/api/tool-library/catalog?project=alpha`)
        throw new Error(`Unexpected catalog read: ${url}`);
      return fetch.mock.calls.length === 1 ? previous.promise : next.promise;
    });
    vi.stubGlobal('fetch', fetch);
    const hook = renderHook(
      ({ principalId }: { principalId: string }) =>
        useToolLibrary(
          {
            apiBase: scope.apiBase,
            principalId,
            options: { requestScope: scope },
          },
          'alpha',
        ),
      {
        wrapper: Wrapper,
        initialProps: { principalId: 'person-a' },
      },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    if (previousState === 'cached') {
      await act(async () => {
        previous.resolve(
          Response.json({
            success: true,
            principalId: 'person-a',
            data: alice,
          }),
        );
      });
      await waitFor(() => expect(hook.result.current.data).toEqual(alice));
    }

    hook.rerender({ principalId: 'person-b' });
    expect(hook.result.current.data).toBeUndefined();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    if (previousState === 'pending') {
      await act(async () => {
        previous.resolve(
          Response.json({
            success: true,
            principalId: 'person-a',
            data: alice,
          }),
        );
      });
    }
    expect(hook.result.current.isPending).toBe(true);
    expect(hook.result.current.data).toBeUndefined();
    expect(
      client
        .getQueryCache()
        .findAll()
        .filter((query) => query.isActive())
        .map((query) => query.state.data),
    ).toEqual([undefined]);

    await act(async () => {
      next.resolve(
        Response.json({ success: true, principalId: 'person-b', data: bob }),
      );
    });
    await waitFor(() => expect(hook.result.current.data).toEqual(bob));
    expect(hook.result.current.isSuccess).toBe(true);
    expect(
      client
        .getQueryCache()
        .findAll()
        .filter((query) => query.isActive())
        .map((query) => query.state.data),
    ).toEqual([bob]);
  },
);
