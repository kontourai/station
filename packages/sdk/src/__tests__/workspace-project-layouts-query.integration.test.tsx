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
import {
  useAvailableProjectLayoutsQuery,
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
