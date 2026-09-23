/**
 * @vitest-environment jsdom
 */

import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { setClientCredentialResolver } from '../client/http';
import { useAgentsQuery } from '../query-domains/agentAdmin';
import {
  useAvailableProjectLayoutsQuery,
  useProjectLayoutsQuery,
  useProjectWorkspacePanesQuery,
} from '../query-domains/workspaceProjects';
import { telemetry } from '../telemetry';

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function catalogResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function layout(id: string): LayoutCatalogItem {
  const slug = id.replace('builtin:', '');
  return {
    id,
    source: 'builtin',
    name: slug,
    slug,
    type: slug,
    sourceIdentity: { id: 'builtin', kind: 'builtin' },
    contribution: {
      id,
      version: '1.0.0',
      sourceIdentity: { id: 'builtin', kind: 'builtin' },
      provenance: { origin: 'builtin' },
    },
    lifecycle: { itemId: id, state: 'installed' },
    visible: true,
    installable: false,
    enabled: true,
    policy: {},
  };
}

describe('available project layouts query lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setClientCredentialResolver(undefined);
    vi.unstubAllGlobals();
  });

  test('uses the configured backoff and stops after four outage requests', async () => {
    vi.useFakeTimers();
    _setApiBase('https://station.example.test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const client = new QueryClient();
    renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(3_999));
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  test('cancels scheduled retries when the final catalog surface becomes inactive', async () => {
    vi.useFakeTimers();
    _setApiBase('https://station.example.test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const client = new QueryClient();
    const { rerender } = renderHook(
      ({ enabled }) => useAvailableProjectLayoutsQuery({ enabled }),
      {
        initialProps: { enabled: true },
        wrapper: wrapperFor(client),
      },
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('keeps shared retries active until the final catalog surface closes', async () => {
    vi.useFakeTimers();
    _setApiBase('https://station.example.test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    const client = new QueryClient();
    const first = renderHook(
      ({ enabled }) => useAvailableProjectLayoutsQuery({ enabled }),
      {
        initialProps: { enabled: true },
        wrapper: wrapperFor(client),
      },
    );
    const second = renderHook(
      ({ enabled }) => useAvailableProjectLayoutsQuery({ enabled }),
      {
        initialProps: { enabled: true },
        wrapper: wrapperFor(client),
      },
    );

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetch).toHaveBeenCalledTimes(1);
    first.rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    second.rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('retains last-good layouts through an authentication failure and self-heals on manual retry', async () => {
    _setApiBase('https://station.example.test');
    const first = [layout('builtin:coding')];
    const recovered = [layout('builtin:tasks')];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(catalogResponse(first))
        .mockResolvedValueOnce(catalogResponse(null, 401))
        .mockResolvedValueOnce(catalogResponse(recovered)),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.data).toEqual(first));
    let failedRefetch: Awaited<ReturnType<typeof result.current.refetch>>;
    await act(async () => {
      failedRefetch = await result.current.refetch();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(failedRefetch!.error).toMatchObject({ status: 401 });
    expect(result.current.data).toEqual(first);

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toEqual(recovered));
    expect(result.current.error).toBeNull();
  });

  test('aborts an in-flight catalog request after its last observer unmounts', async () => {
    _setApiBase('https://station.example.test');
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? undefined;
            requestSignal?.addEventListener('abort', () =>
              reject(requestSignal?.reason),
            );
          }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { unmount } = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(requestSignal).toBeDefined());
    unmount();
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
  });

  test('invalidates the shared catalog and fetches fresh layouts', async () => {
    _setApiBase('https://station.example.test');
    const first = [layout('builtin:coding')];
    const refreshed = [layout('builtin:tasks')];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(catalogResponse(first))
        .mockResolvedValueOnce(catalogResponse(refreshed)),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() => expect(result.current.data).toEqual(first));
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['projects', 'layouts', 'available'],
        exact: true,
      });
    });
    await waitFor(() => expect(result.current.data).toEqual(refreshed));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('reads the current, data-only Workspace Pane catalog for a project', async () => {
    _setApiBase('https://station.example.test');
    const snapshot = {
      version: '1.0' as const,
      descriptors: [],
      instances: [],
      availability: [
        {
          descriptorId: 'builtin-files',
          instanceId: 'project:alpha:files',
          input: {
            rollout: 'available',
            distribution: 'enabled',
            renderer: 'unknown',
            context: { project: 'present' },
          },
          availability: {
            state: 'temporarily-unavailable',
            reason: { code: 'renderer-missing', source: 'renderer' },
          },
        },
        {
          descriptorId: 'builtin-browser-preview',
          input: { rollout: 'coming-soon' },
          availability: {
            state: 'coming-soon',
            reason: { code: 'coming-soon', source: 'product-rollout' },
          },
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(catalogResponse(snapshot)),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () => useProjectWorkspacePanesQuery('alpha'),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => expect(result.current.data).toEqual(snapshot));
    expect(fetch).toHaveBeenCalledWith(
      'https://station.example.test/api/projects/alpha/panes',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('deduplicates failure telemetry and records recovery after reopening', async () => {
    _setApiBase('https://station.example.test');
    const cached = [layout('builtin:coding')];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(catalogResponse(cached))
        .mockResolvedValueOnce(catalogResponse(null, 401))
        .mockResolvedValueOnce(catalogResponse(cached)),
    );
    const track = vi.spyOn(telemetry, 'track').mockImplementation(() => {});
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const mounted = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(mounted.result.current.data).toEqual(cached));
    await act(async () => {
      await mounted.result.current.refetch();
    });
    await waitFor(() =>
      expect(
        track.mock.calls.filter(
          ([event, attributes]) =>
            event === 'ui.layout_catalog.state' &&
            attributes?.outcome === 'failure',
        ),
      ).toHaveLength(1),
    );
    mounted.unmount();

    const reopened = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });
    await waitFor(() => expect(reopened.result.current.isSuccess).toBe(true));
    expect(
      track.mock.calls.filter(
        ([event, attributes]) =>
          event === 'ui.layout_catalog.state' &&
          attributes?.outcome === 'failure',
      ),
    ).toHaveLength(1);
    expect(track).toHaveBeenCalledWith('ui.layout_catalog.state', {
      outcome: 'recovered',
      reason: 'authentication',
      cached: 1,
    });
  });
});

/**
 * #2319 — a plugin installed OUTSIDE this tab (CLI, another tab or device, an
 * agent) must reach the pane catalog. Every refresh path — a plugin lifecycle
 * server event, an in-tab install, the reconnect sync — goes through
 * `invalidateQueries`, which only refetches a query observed at that moment.
 * These run on Station's own query defaults (`refetchOnMount: false`), which
 * is what made a catalog invalidated while unmounted stay old on the next
 * mount.
 */
describe('pane catalog revalidates on mount after an unobserved invalidation (#2319)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stationDefaultsClient(): QueryClient {
    // Mirrors `createAuthorityClient` in src-ui AuthorityQueryContext.
    return new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5 * 60 * 1000,
          gcTime: 10 * 60 * 1000,
          refetchOnWindowFocus: false,
          refetchOnMount: false,
          retry: false,
        },
      },
    });
  }

  function paneCatalog(descriptorIds: string[]) {
    return {
      projectId: 'project-alpha',
      projectSlug: 'alpha',
      descriptors: descriptorIds.map((id) => ({ id })),
      instances: [],
    };
  }

  function descriptorIds(data: unknown): string[] {
    return (
      (data as { descriptors?: Array<{ id: string }> } | undefined)
        ?.descriptors ?? []
    ).map((descriptor) => descriptor.id);
  }

  test('a catalog invalidated while no view observed it refetches on the next mount', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        catalogResponse(
          paneCatalog(['builtin-files', 'plugin:connected-pulse:pane']),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    // The catalog the tab already held (restored or fetched earlier) — fresh
    // by age, so only the invalidation can make it refetch.
    client.setQueryData(
      ['projects', 'alpha', 'panes'],
      paneCatalog(['builtin-files']),
    );
    // A plugin lifecycle event / install mutation lands while unmounted.
    await client.invalidateQueries({ queryKey: ['projects'] });
    expect(fetchMock).not.toHaveBeenCalled();

    const { result } = renderHook(
      () => useProjectWorkspacePanesQuery('alpha'),
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() =>
      expect(descriptorIds(result.current.data)).toContain(
        'plugin:connected-pulse:pane',
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://station.example.test/api/projects/alpha/panes',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('an untouched cached catalog keeps the cache-first default: remounts do not refetch', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(catalogResponse(paneCatalog(['builtin-files'])));
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    // Old by age (past staleTime), as a persisted snapshot usually is. A
    // blanket `refetchOnMount: true` would refetch it — offline, that turns a
    // painted workspace into an error state.
    client.setQueryData(
      ['projects', 'alpha', 'panes'],
      paneCatalog(['builtin-files']),
      { updatedAt: Date.now() - 60 * 60 * 1000 },
    );

    for (let mount = 0; mount < 3; mount += 1) {
      const view = renderHook(() => useProjectWorkspacePanesQuery('alpha'), {
        wrapper: wrapperFor(client),
      });
      expect(descriptorIds(view.result.current.data)).toEqual([
        'builtin-files',
      ]);
      view.unmount();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('other queries keep the client default: an invalidated project layouts list does not refetch on mount', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi.fn().mockResolvedValue(catalogResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    client.setQueryData(['projects', 'alpha', 'layouts'], []);
    await client.invalidateQueries({ queryKey: ['projects'] });

    const { result } = renderHook(() => useProjectLayoutsQuery('alpha'), {
      wrapper: wrapperFor(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.data).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a failed mount refetch keeps the cached catalog and reports isRefetchError (#2345)', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    client.setQueryData(
      ['projects', 'alpha', 'panes'],
      paneCatalog(['builtin-files']),
    );
    await client.invalidateQueries({ queryKey: ['projects'] });

    const { result } = renderHook(
      () => useProjectWorkspacePanesQuery('alpha'),
      { wrapper: wrapperFor(client) },
    );

    // What `WorkspacePaneRouteView` and the pane picker branch on: the old
    // answer is still `data`, and the failure is a REFETCH error, not a load
    // error.
    await waitFor(() => expect(result.current.isRefetchError).toBe(true));
    expect(result.current.isLoadingError).toBe(false);
    expect(descriptorIds(result.current.data)).toEqual(['builtin-files']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #2345: the same policy on the two other reads whose contents change
  // outside this client. Each seeds the answer the tab already held, lands
  // the invalidation with no observer, and then mounts.
  test('the available-layouts catalog invalidated while unmounted refetches on the next mount (#2345)', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        catalogResponse([layout('builtin:chat'), layout('builtin:plugin')]),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    client.setQueryData(
      ['projects', 'layouts', 'available'],
      [layout('builtin:chat')],
    );
    await client.invalidateQueries({ queryKey: ['projects'] });
    expect(fetchMock).not.toHaveBeenCalled();

    const { result } = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() =>
      expect(result.current.data?.map((item) => item.id)).toEqual([
        'builtin:chat',
        'builtin:plugin',
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://station.example.test/api/projects/layouts/available',
    );
  });

  test('an untouched available-layouts catalog does not refetch on remount (#2345)', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi.fn().mockResolvedValue(catalogResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    client.setQueryData(
      ['projects', 'layouts', 'available'],
      [layout('builtin:chat')],
      { updatedAt: Date.now() - 60 * 60 * 1000 },
    );
    const view = renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });
    view.unmount();
    renderHook(() => useAvailableProjectLayoutsQuery(), {
      wrapper: wrapperFor(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the agents catalog invalidated while unmounted refetches on the next mount (#2345)', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi.fn().mockResolvedValue(
      catalogResponse([
        { slug: 'default', name: 'Default' },
        { slug: 'plugin-agent', name: 'Plugin agent' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    client.setQueryData(['agents'], {
      agents: [{ slug: 'default', name: 'Default' }],
    });
    await client.invalidateQueries({ queryKey: ['agents'] });
    expect(fetchMock).not.toHaveBeenCalled();

    const { result } = renderHook(() => useAgentsQuery(), {
      wrapper: wrapperFor(client),
    });

    await waitFor(() =>
      expect(result.current.data?.map((agent) => agent.slug)).toEqual([
        'default',
        'plugin-agent',
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://station.example.test/api/agents',
    );
  });

  test('an untouched agents catalog does not refetch on remount (#2345)', async () => {
    _setApiBase('https://station.example.test');
    const fetchMock = vi.fn().mockResolvedValue(catalogResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const client = stationDefaultsClient();
    client.setQueryData(
      ['agents'],
      { agents: [{ slug: 'default', name: 'Default' }] },
      { updatedAt: Date.now() - 60 * 60 * 1000 },
    );
    const view = renderHook(() => useAgentsQuery(), {
      wrapper: wrapperFor(client),
    });
    view.unmount();
    const again = renderHook(() => useAgentsQuery(), {
      wrapper: wrapperFor(client),
    });
    expect(again.result.current.data?.map((agent) => agent.slug)).toEqual([
      'default',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
