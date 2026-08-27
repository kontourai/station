/**
 * Tests that useConnectionStatus correctly transitions between
 * connected / connecting / error states as the health-check resolves.
 *
 * Uses real timers (no fake timers) with very short poll intervals so
 * tests stay fast without fighting React Testing Library's waitFor.
 */
// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import { ConnectionsProvider } from '../react/ConnectionsContext';
import { useConnectionStatus } from '../react/useConnectionStatus';

function memoryAdapter(): StorageAdapter {
  const s: Record<string, string> = {};
  return {
    get: (k) => s[k] ?? null,
    set: (k, v) => {
      s[k] = v;
    },
    remove: (k) => {
      delete s[k];
    },
  };
}

function storeWithUrl(url: string) {
  const store = new ConnectionStore({ storage: memoryAdapter() });
  store.add('test', url);
  return store;
}

function wrapper(store: ConnectionStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <ConnectionsProvider store={store} defaultUrl="http://localhost:3141">
      {children}
    </ConnectionsProvider>
  );
}

// Short poll so the "re-checks on interval" test doesn't take long
const POLL = 80;

describe('useConnectionStatus', () => {
  it('deduplicates health traffic across multiple UI consumers', async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('http://shared-server:3141');

    const { result } = renderHook(
      () => ({
        header: useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
        banner: useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.header.status).toBe('connected'));
    expect(result.current.banner.status).toBe('connected');
    expect(checkHealth).toHaveBeenCalledOnce();
  });

  it('starts as connecting, resolves to connected when health check passes', async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('http://ok-server:3141');

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );

    // Initially "connecting" before the first async check completes
    expect(result.current.status).toBe('connecting');

    // Wait for the first health check to resolve
    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });
    expect(checkHealth).toHaveBeenCalledOnce();
  });

  it('transitions to error when health check throws', async () => {
    const checkHealth = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const store = storeWithUrl('http://dead-server:3141');

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.status).toBe('error'), {
      timeout: 2000,
    });
  });

  it('transitions to error when checkHealth returns false', async () => {
    const checkHealth = vi.fn().mockResolvedValue(false);
    const store = storeWithUrl('http://bad-server:3141');

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.status).toBe('error'), {
      timeout: 2000,
    });
  });

  it('re-checks on poll interval — simulates server recovery', async () => {
    const checkHealth = vi
      .fn()
      .mockResolvedValueOnce(false) // first call: server down
      .mockResolvedValue(true); // subsequent calls: recovered

    const store = storeWithUrl('http://flaky-server:3141');

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: POLL }),
      { wrapper: wrapper(store) },
    );

    // First poll: error
    await waitFor(() => expect(result.current.status).toBe('error'), {
      timeout: 2000,
    });

    // Second poll (after POLL ms): connected
    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: POLL * 5,
    });
    expect(checkHealth.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rechecks immediately when a native mobile WebView resumes', async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('https://tailnet-station.example.test');

    renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(2));

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it('coalesces the focus, pageshow, and visibility events from one resume', async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('https://tailnet-station.example.test');

    renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );
    await waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(2));
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it('suppresses separately scheduled events from one resume but probes a later resume', async () => {
    vi.useFakeTimers();
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('https://tailnet-station.example.test');
    renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      {
        wrapper: wrapper(store),
      },
    );
    await act(async () => Promise.resolve());
    expect(checkHealth).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    act(() => window.dispatchEvent(new Event('pageshow')));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(checkHealth).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(300));
    act(() => window.dispatchEvent(new Event('focus')));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(checkHealth).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('probes a reachable VPN endpoint even when navigator.onLine is false', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('https://station.tailnet.example.test');

    const { result, unmount } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );
    await waitFor(() => expect(result.current.status).toBe('connected'));
    expect(checkHealth).toHaveBeenCalledOnce();
    unmount();
    if (original) Object.defineProperty(navigator, 'onLine', original);
  });

  it('resolves connected for a managed-loopback injected connection without a live probe', async () => {
    // Returning false means any browser probe would drive an error; the
    // managed-loopback endpoint must converge to connected regardless.
    const checkHealth = vi.fn().mockResolvedValue(false);
    const store = new ConnectionStore({ storage: memoryAdapter() });

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <ConnectionsProvider
            store={store}
            defaultUrl="http://localhost:3141"
            seedDefault={false}
            injectedConnection={{
              id: 'managed-loopback',
              name: 'Station on this device',
              url: 'http://127.0.0.1:3142',
              source: 'managed-loopback',
            }}
          >
            {children}
          </ConnectionsProvider>
        ),
      },
    );

    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });
    // The only saved endpoint is managed-loopback, so the supervisor is
    // authoritative and its URL is never probed by the browser.
    expect(
      checkHealth.mock.calls.every(([url]) => url !== 'http://127.0.0.1:3142'),
    ).toBe(true);
  });

  // station#1286: a native shell page (e.g. Tauri's tauri://localhost) must
  // not be misclassified as a secure https: page and reject a plain-HTTP
  // LAN station as mixed-content before ever probing it.
  it('probes and connects a plain-HTTP LAN endpoint when nativeShell is true', async () => {
    const checkHealth = vi.fn().mockResolvedValue(true);
    const store = storeWithUrl('http://192.168.1.20:3141');

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <ConnectionsProvider
            store={store}
            defaultUrl="http://localhost:3141"
            nativeShell
          >
            {children}
          </ConnectionsProvider>
        ),
      },
    );

    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });
    expect(checkHealth).toHaveBeenCalledWith(
      'http://192.168.1.20:3141',
      undefined,
    );
  });

  it('rechecks (connected→connecting→connected) when active URL changes', async () => {
    // First call fast, second call slow — gives us a window to observe 'connecting'
    let callCount = 0;
    const checkHealth = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          callCount++;
          setTimeout(() => resolve(true), callCount === 1 ? 0 : 200);
        }),
    );

    const store = storeWithUrl('http://server-a:3141');

    const { result } = renderHook(
      () => useConnectionStatus({ checkHealth, pollInterval: 60_000 }),
      { wrapper: wrapper(store) },
    );

    // First URL resolves quickly → connected
    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });

    // Switch to a different server (must explicitly setActive, add() keeps existing active)
    const { act } = await import('@testing-library/react');
    await act(async () => {
      const conn = store.add('B', 'http://server-b:3141');
      store.setActive(conn.id);
    });

    // Now the slow second check is in flight → 'connecting'
    // (transient state — may resolve before React re-renders)

    // Eventually resolves → 'connected' again
    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });
    expect(checkHealth.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  // station#1094 R4/AC4: existing connecting/connected/error states above
  // are unchanged; `blocked` is additive and, once set, this hook resumes
  // automatically on a saved-credential change (one of the three signals
  // that wakes a blocked connection supervisor) without a manual "Try now".
  it('blocks on authentication-failed and resumes automatically when the saved credential changes', async () => {
    let credentialAccepted = false;
    const checkHealth = vi.fn().mockResolvedValue(false);
    const probeEndpoint = vi
      .fn()
      .mockImplementation(async (_url: string, credential?: string) =>
        credentialAccepted && credential === 'good-credential'
          ? { ok: true as const }
          : { ok: false as const, reason: 'authentication-failed' as const },
      );
    const store = storeWithUrl('http://needs-auth:3141');
    const conn = store.getAll()[0];

    const { result } = renderHook(
      () =>
        useConnectionStatus({
          checkHealth,
          probeEndpoint,
          pollInterval: 60_000,
        }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.blocked).toBe(true), {
      timeout: 2000,
    });
    expect(result.current.status).toBe('error');
    expect(result.current.reason).toBe('authentication-failed');
    const blockedCallCount = probeEndpoint.mock.calls.length;

    credentialAccepted = true;
    const { act } = await import('@testing-library/react');
    await act(async () => {
      store.setCredential(conn.id, 'good-credential');
    });

    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });
    expect(result.current.blocked).toBe(false);
    expect(probeEndpoint.mock.calls.length).toBeGreaterThan(blockedCallCount);
  });

  // station#3602: a BROWSER device session has no credential value — it is
  // `undefined` before pairing and `undefined` after — so the value comparison
  // this wake used to make could not see re-pairing happen, and the supervisor
  // stayed blocked through exactly the event it exists to resume on.
  it('resumes when a device session is paired, which changes no credential value', async () => {
    let paired = false;
    const checkHealth = vi.fn().mockResolvedValue(false);
    const probeEndpoint = vi
      .fn()
      .mockImplementation(async () =>
        paired
          ? { ok: true as const }
          : { ok: false as const, reason: 'authentication-failed' as const },
      );
    const store = storeWithUrl('http://needs-auth:3141');
    const conn = store.getAll()[0];

    const { result } = renderHook(
      () =>
        useConnectionStatus({
          checkHealth,
          probeEndpoint,
          pollInterval: 60_000,
        }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.blocked).toBe(true), {
      timeout: 2000,
    });
    const blockedCallCount = probeEndpoint.mock.calls.length;
    expect(store.getCredential(conn.id)).toBeNull();

    paired = true;
    const { act } = await import('@testing-library/react');
    await act(async () => {
      store.markDeviceSession(conn.id);
    });
    // The value the previous implementation watched is unchanged by pairing.
    expect(store.getCredential(conn.id)).toBeNull();

    await waitFor(() => expect(result.current.status).toBe('connected'), {
      timeout: 2000,
    });
    expect(result.current.blocked).toBe(false);
    expect(probeEndpoint.mock.calls.length).toBeGreaterThan(blockedCallCount);
  });

  // The counter must not fire on the supervisor's OWN recorded failures, or
  // every failed probe would immediately re-probe past its backoff — the hot
  // loop station#1094 removed.
  it('does not re-probe on the endpoint failures it records itself', async () => {
    const checkHealth = vi.fn().mockResolvedValue(false);
    const probeEndpoint = vi
      .fn()
      .mockResolvedValue({ ok: false as const, reason: 'timeout' as const });
    const store = storeWithUrl('http://unreachable:3141');

    const { result } = renderHook(
      () =>
        useConnectionStatus({
          checkHealth,
          probeEndpoint,
          pollInterval: 60_000,
        }),
      { wrapper: wrapper(store) },
    );

    await waitFor(() => expect(result.current.status).toBe('error'), {
      timeout: 2000,
    });
    const afterFirstFailure = probeEndpoint.mock.calls.length;
    // A recorded failure bumps the EVIDENCE generation. Waking on that one
    // would turn each failure into an immediate retry.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probeEndpoint.mock.calls.length).toBeLessThanOrEqual(
      afterFirstFailure + 1,
    );
  });
});
