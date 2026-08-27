/**
 * Resolution-matrix coverage for ApiBaseContext's DEFAULT_API_BASE — the
 * priority chain (`window.__API_BASE__` injected override → `VITE_API_BASE`
 * dev override → same-origin `window.location.origin` default) is computed
 * once at module-import time, so each case resets modules and re-imports
 * fresh with a differently mocked `window.location`/env.
 *
 * See #198: with no explicit override, the resolved API base MUST be the
 * page's own origin — for localhost, a LAN/tailnet host, and an https://
 * single-origin reverse-proxy host alike.
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const COLD_MODULE_IMPORT_TEST_TIMEOUT_MS = 15_000;

function setLocation(origin: string) {
  const url = new URL(origin);
  Object.defineProperty(window, 'location', {
    value: {
      ...window.location,
      origin: url.origin,
      href: url.href,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
    },
    writable: true,
    configurable: true,
  });
}

async function importFresh() {
  vi.resetModules();
  return import('../ApiBaseContext');
}

describe('ApiBaseContext — same-origin resolution matrix (#198)', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as any).__API_BASE__;
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    delete (window as any).__API_BASE__;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it(
    'resolves to window.location.origin for localhost when no override is configured',
    async () => {
      setLocation('http://localhost:5274');
      const { ApiBaseProvider, useApiBase } = await importFresh();
      const { result } = renderHook(() => useApiBase(), {
        wrapper: ({ children }) => (
          <ApiBaseProvider>{children as any}</ApiBaseProvider>
        ),
      });
      expect(result.current.apiBase).toBe('http://localhost:5274');
    },
    COLD_MODULE_IMPORT_TEST_TIMEOUT_MS,
  );

  it('resolves to window.location.origin for a LAN/tailnet IP:port when no override is configured', async () => {
    setLocation('http://192.168.1.42:3010');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { result } = renderHook(() => useApiBase(), {
      wrapper: ({ children }) => (
        <ApiBaseProvider>{children as any}</ApiBaseProvider>
      ),
    });
    expect(result.current.apiBase).toBe('http://192.168.1.42:3010');
  });

  it('resolves to window.location.origin for an https:// single-origin reverse-proxy host when no override is configured', async () => {
    setLocation('https://my-tailnet-host.ts.net');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { result } = renderHook(() => useApiBase(), {
      wrapper: ({ children }) => (
        <ApiBaseProvider>{children as any}</ApiBaseProvider>
      ),
    });
    expect(result.current.apiBase).toBe('https://my-tailnet-host.ts.net');
  });

  it('an injected window.__API_BASE__ override always wins over the same-origin default', async () => {
    setLocation('http://192.168.1.42:3010');
    (window as any).__API_BASE__ = 'http://example-override:9999';
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { result } = renderHook(() => useApiBase(), {
      wrapper: ({ children }) => (
        <ApiBaseProvider>{children as any}</ApiBaseProvider>
      ),
    });
    expect(result.current.apiBase).toBe('http://example-override:9999');
    // The injected override becomes this module's own `defaultUrl` (it is
    // the configured default endpoint for this page load, not a
    // Settings-entered "custom" URL layered on top of it), so isCustom is
    // correctly false here — see the persisted-custom-connection case below
    // for the case that does flag isCustom.
    expect(result.current.isCustom).toBe(false);
  });

  it('a persisted custom connection wins over the same-origin default', async () => {
    setLocation('http://192.168.1.42:3010');
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        { id: 'custom-1', name: 'Custom', url: 'http://custom-host:4000' },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', 'custom-1');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { result } = renderHook(() => useApiBase(), {
      wrapper: ({ children }) => (
        <ApiBaseProvider>{children as any}</ApiBaseProvider>
      ),
    });
    expect(result.current.apiBase).toBe('http://custom-host:4000');
    expect(result.current.isCustom).toBe(true);
  });

  it('resetToDefault() returns to the same-origin default after a custom override', async () => {
    setLocation('http://192.168.1.42:3010');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { result } = renderHook(() => useApiBase(), {
      wrapper: ({ children }) => (
        <ApiBaseProvider>{children as any}</ApiBaseProvider>
      ),
    });

    act(() => result.current.setApiBase('http://custom-host:4000'));
    expect(result.current.isCustom).toBe(true);

    act(() => result.current.resetToDefault());
    expect(result.current.apiBase).toBe('http://192.168.1.42:3010');
    expect(result.current.isCustom).toBe(false);
  });

  it('rebinds global SDK requests when the active connection changes', async () => {
    setLocation('http://localhost:5274');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { fetchKnowledgeStatus } = await import('@kontourai/station-sdk');
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: {} }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useApiBase(), {
      wrapper: ({ children }) => (
        <ApiBaseProvider>{children as any}</ApiBaseProvider>
      ),
    });

    act(() => result.current.setApiBase('https://remote-station.test'));
    await fetchKnowledgeStatus('demo');

    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://remote-station.test/api/projects/demo/knowledge/status',
      expect.any(Object),
    );
  });

  it('installs remote credentials before onboarding-gated children render', async () => {
    setLocation('https://my-tailnet-host.ts.net');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { useConnections } = await import('@kontourai/station-connect');
    const { authenticatedFetch } = await import('@kontourai/station-sdk');
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(
      () => ({ api: useApiBase(), connections: useConnections() }),
      {
        wrapper: ({ children }) => (
          <ApiBaseProvider>{children as any}</ApiBaseProvider>
        ),
      },
    );

    act(() => {
      result.current.connections.setCredential(
        result.current.connections.activeConnection!.id,
        'remote-onboarding-credential',
      );
    });
    await waitFor(() =>
      expect(result.current.connections.activeConnection?.credentialState).toBe(
        'saved',
      ),
    );
    await authenticatedFetch(
      'https://my-tailnet-host.ts.net/api/system/status',
    );

    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer remote-onboarding-credential',
    );
  });

  it('station#1094: a saved-credential change resumes a fetchSSE stream that terminal-stopped on 401', async () => {
    setLocation('https://my-tailnet-host.ts.net');
    const { ApiBaseProvider, useApiBase } = await importFresh();
    const { useConnections } = await import('@kontourai/station-connect');
    const { fetchSSE } = await import('@kontourai/station-sdk');
    vi.useFakeTimers();
    let credential = 'stale-credential';
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).get('Accept') === 'text/event-stream') {
          return credential === 'stale-credential'
            ? new Response('', { status: 401 })
            : new Response(': heartbeat\r\n\r\n', {
                headers: { 'Content-Type': 'text/event-stream' },
              });
        }
        return new Response('{}', {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(
      () => ({ api: useApiBase(), connections: useConnections() }),
      {
        wrapper: ({ children }) => (
          <ApiBaseProvider>{children as any}</ApiBaseProvider>
        ),
      },
    );

    act(() => {
      result.current.connections.setCredential(
        result.current.connections.activeConnection!.id,
        credential,
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          result.current.connections.activeConnection?.credentialState,
        ).toBe('saved'),
      );
    });

    const stream = fetchSSE(`${result.current.api.apiBase}/events`, {
      authentication: 'required',
      retryDelayMs: 10,
      onMessage: () => undefined,
    });
    const eventStreamAttempts = () =>
      fetchMock.mock.calls.filter(
        ([, init]) =>
          new Headers((init as RequestInit | undefined)?.headers).get(
            'Accept',
          ) === 'text/event-stream',
      );

    await act(async () => {
      await vi.waitFor(() => expect(eventStreamAttempts().length).toBe(1));
    });
    // Terminal-stopped on the stale credential's 401 — stays flat, not a
    // perpetual reconnect loop against an endpoint that will reject every
    // attempt identically (station#1094).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(eventStreamAttempts().length).toBe(1);

    // Fixing the saved credential — the same `setCredential` call a real
    // re-pairing flow makes — must resume the stream with no page reload,
    // through the same `reportUnauthorized`/`ApiBaseContext` wiring this
    // hook already uses for the one-shot 401 flag.
    credential = 'fresh-credential';
    act(() => {
      result.current.connections.setCredential(
        result.current.connections.activeConnection!.id,
        credential,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(eventStreamAttempts().length).toBe(2));
    });

    stream.close();
  });
});
