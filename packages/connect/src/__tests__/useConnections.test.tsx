/**
 * React integration tests for ConnectionsProvider / useConnections.
 * Uses jsdom + @testing-library/react so no browser needed.
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';
import {
  ConnectionsProvider,
  useConnections,
} from '../react/ConnectionsContext';
import { requestAuthorityScopeFromCredentialEvidence } from '../react/request-authority';

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

function makeStore(_defaultUrl = 'http://localhost:3141') {
  return new ConnectionStore({ storage: memoryAdapter() });
}

function wrapper(store: ConnectionStore) {
  return ({ children }: { children: React.ReactNode }) => (
    <ConnectionsProvider store={store} defaultUrl="http://localhost:3141">
      {children}
    </ConnectionsProvider>
  );
}

describe('useConnections', () => {
  it('keeps same-origin connections in distinct live authority snapshots', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });
    let connectionA = '';
    const connectionB = 'injected-same-origin-b';
    act(() => {
      connectionA = result.current.addConnection('A', 'https://same.test').id;
      store.setInjectedConnection({
        id: connectionB,
        name: 'B',
        url: 'https://same.test',
        source: 'cli-base',
      });
      result.current.setCredential(connectionA, 'private-a');
    });
    await act(async () => {
      await result.current.setActiveConnection(connectionA);
    });
    const evidenceA = result.current.captureCredentialEvidence();
    if (!evidenceA) throw new Error('missing A evidence');
    expect(result.current.isCredentialEvidenceCurrent(evidenceA)).toBe(true);
    expect(requestAuthorityScopeFromCredentialEvidence(evidenceA)).toEqual({
      apiBase: 'https://same.test',
      authorityKey: JSON.stringify([
        connectionA,
        evidenceA.activationEpoch,
        evidenceA.authorityGeneration,
        evidenceA.credentialState,
      ]),
    });
    expect(
      JSON.stringify(requestAuthorityScopeFromCredentialEvidence(evidenceA)),
    ).not.toContain('private-a');

    act(() => {
      result.current.removeCredential(connectionA);
    });
    expect(result.current.isCredentialEvidenceCurrent(evidenceA)).toBe(false);
    act(() => {
      result.current.setCredential(connectionA, 'private-a-recovered');
    });
    const recoveredEvidenceA = result.current.captureCredentialEvidence();
    expect(recoveredEvidenceA).toBeTruthy();
    expect(
      result.current.isCredentialEvidenceCurrent(recoveredEvidenceA!),
    ).toBe(true);
    expect(recoveredEvidenceA?.authorityGeneration).toBeGreaterThan(
      evidenceA.authorityGeneration,
    );

    await act(async () => {
      await result.current.setActiveConnection(connectionB);
    });
    expect(
      result.current.isCredentialEvidenceCurrent(recoveredEvidenceA!),
    ).toBe(false);
    const evidenceB = result.current.captureCredentialEvidence();
    expect(evidenceB?.activationEpoch).not.toBe(
      recoveredEvidenceA?.activationEpoch,
    );
    expect(new URL(evidenceB?.origin ?? '').origin).toBe(
      new URL(evidenceA.origin).origin,
    );
    expect(evidenceB?.connectionId).toBe(connectionB);
    expect(requestAuthorityScopeFromCredentialEvidence(evidenceB!)).not.toEqual(
      requestAuthorityScopeFromCredentialEvidence(recoveredEvidenceA!),
    );

    await act(async () => {
      await result.current.setActiveConnection(connectionA);
    });
    const returnedEvidenceA = result.current.captureCredentialEvidence();
    expect(returnedEvidenceA?.connectionId).toBe(connectionA);
    expect(returnedEvidenceA?.activationEpoch).not.toBe(
      recoveredEvidenceA?.activationEpoch,
    );
    expect(
      requestAuthorityScopeFromCredentialEvidence(returnedEvidenceA!),
    ).not.toEqual(
      requestAuthorityScopeFromCredentialEvidence(recoveredEvidenceA!),
    );
  });

  it('starts with empty connections when store is empty', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });
    expect(result.current.connections).toHaveLength(0);
    expect(result.current.activeConnection).toBeNull();
    expect(result.current.apiBase).toBe('http://localhost:3141');
  });

  it('addConnection() appears in connections and activates it', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });

    act(() => {
      result.current.addConnection('Home', 'http://192.168.1.10:3141');
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.activeConnection?.url).toBe(
      'http://192.168.1.10:3141',
    );
    expect(result.current.apiBase).toBe('http://192.168.1.10:3141');
  });

  it('removeConnection() removes from list', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });

    act(() => {
      result.current.addConnection('A', 'http://a:3141');
      result.current.addConnection('B', 'http://b:3141');
    });

    const idToRemove = result.current.connections[0].id;
    act(() => {
      result.current.removeConnection(idToRemove);
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].name).toBe('B');
  });

  it('setActiveConnection() switches apiBase', async () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });

    let idB = '';
    act(() => {
      result.current.addConnection('A', 'http://a:3141');
      idB = result.current.addConnection('B', 'http://b:3141').id;
    });

    await act(async () => {
      await result.current.setActiveConnection(idB!);
    });

    expect(result.current.apiBase).toBe('http://b:3141');
    expect(result.current.isCustom).toBe(true);
  });

  it('awaits host credential preparation before publishing an active connection', async () => {
    const store = makeStore();
    let releasePreparation: (() => void) | undefined;
    const prepareActiveConnection = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePreparation = resolve;
        }),
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }) => (
        <ConnectionsProvider
          store={store}
          defaultUrl="http://localhost:3141"
          prepareActiveConnection={prepareActiveConnection}
        >
          {children}
        </ConnectionsProvider>
      ),
    });

    let idB = '';
    act(() => {
      result.current.addConnection('A', 'http://a:3141');
      idB = result.current.addConnection('B', 'http://b:3141').id;
    });

    const selection = result.current.setActiveConnection(idB!);
    expect(prepareActiveConnection).toHaveBeenCalledWith(idB);
    expect(result.current.activeConnection?.id).not.toBe(idB);

    await act(async () => {
      releasePreparation?.();
      await selection;
    });
    expect(result.current.activeConnection?.id).toBe(idB);
  });

  it('setApiBase() upserts by URL', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });

    act(() => {
      result.current.setApiBase('http://new-server:3141');
    });

    expect(result.current.connections).toHaveLength(1);
    expect(result.current.apiBase).toBe('http://new-server:3141');

    // Calling again with the same URL should not create a duplicate
    act(() => {
      result.current.setApiBase('http://new-server:3141');
    });
    expect(result.current.connections).toHaveLength(1);
  });

  it('resetToDefault() switches back to defaultUrl', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });

    act(() => {
      result.current.addConnection('Custom', 'http://custom:3141');
    });
    act(() => {
      result.current.resetToDefault();
    });

    expect(result.current.apiBase).toBe('http://localhost:3141');
    expect(result.current.isCustom).toBe(false);
  });

  it('updateConnection() reflects new name in connections list', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });

    act(() => {
      result.current.addConnection('Old Name', 'http://a:3141');
    });

    const id = result.current.connections[0].id;
    act(() => {
      result.current.updateConnection(id, { name: 'New Name' });
    });

    expect(result.current.connections[0].name).toBe('New Name');
  });
});

describe('useConnections — isCustom', () => {
  it('isCustom is false when using default URL', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });
    act(() => {
      result.current.addConnection('Default', 'http://localhost:3141');
    });
    expect(result.current.isCustom).toBe(false);
  });

  it('isCustom is true when using a different URL', () => {
    const store = makeStore();
    const { result } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });
    act(() => {
      result.current.addConnection('Remote', 'http://192.168.1.5:3141');
    });
    expect(result.current.isCustom).toBe(true);
  });
});

describe('ConnectionsProvider — makeDefaultStore self-heal (#198)', () => {
  it('moves legacy local credentials into session storage and removes the local copy', async () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        {
          id: 'default-1',
          name: 'Default',
          url: 'https://station.example.test',
        },
      ]),
    );
    localStorage.setItem(
      'station-connect-connections-credentials',
      JSON.stringify({ 'connection:default-1': 'legacy-secret' }),
    );

    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider defaultUrl="https://station.example.test">
          {children}
        </ConnectionsProvider>
      ),
    });

    expect(
      localStorage.getItem('station-connect-connections-credentials'),
    ).toBeNull();
    expect(
      sessionStorage.getItem('station-connect-connections-credentials'),
    ).toContain('legacy-secret');
    expect(
      result.current.getConnectionCredential(result.current.connections[0].id),
    ).toBe('legacy-secret');
  });

  it('corrects a stale persisted "Default" connection URL to the new defaultUrl on next load', async () => {
    // Simulate a prior session persisted at an old origin (e.g. localhost),
    // then loading the app from a different origin (e.g. after moving to a
    // LAN/tailnet host) with no explicit override configured.
    localStorage.clear();
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        { id: 'default-1', name: 'Default', url: 'http://localhost:3141' },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', 'default-1');

    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider defaultUrl="http://192.168.1.42:3010">
          {children}
        </ConnectionsProvider>
      ),
    });

    expect(result.current.apiBase).toBe('http://192.168.1.42:3010');
    expect(result.current.isCustom).toBe(false);
    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].name).toBe('Default');
    expect(result.current.connections[0].url).toBe('http://192.168.1.42:3010');
  });

  it('leaves a genuinely custom (non-Default) persisted connection untouched when defaultUrl changes', async () => {
    localStorage.clear();
    localStorage.setItem(
      'station-connect-connections',
      JSON.stringify([
        { id: 'default-1', name: 'Default', url: 'http://localhost:3141' },
        { id: 'custom-1', name: 'My server', url: 'http://custom-host:9999' },
      ]),
    );
    localStorage.setItem('station-connect-connections-active', 'custom-1');

    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider defaultUrl="http://192.168.1.42:3010">
          {children}
        </ConnectionsProvider>
      ),
    });

    // The active custom connection still wins (override behavior)...
    expect(result.current.apiBase).toBe('http://custom-host:9999');
    expect(result.current.isCustom).toBe(true);
    // ...but the stale "Default" entry was still healed to the new origin
    // so resetToDefault() lands on the current same-origin value, not a
    // stale localhost URL.
    const healedDefault = result.current.connections.find(
      (c) => c.name === 'Default',
    );
    expect(healedDefault?.url).toBe('http://192.168.1.42:3010');
  });
});

describe('ConnectionsProvider — seedDefault matrix (D4)', () => {
  it('seeds an origin Default connection by default (seedDefault omitted)', async () => {
    localStorage.clear();
    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider defaultUrl="http://localhost:3141">
          {children}
        </ConnectionsProvider>
      ),
    });
    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].name).toBe('Default');
    expect(result.current.apiBase).toBe('http://localhost:3141');
  });

  it('skips origin default seeding when seedDefault is false', async () => {
    localStorage.clear();
    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider
          defaultUrl="http://127.0.0.1:3142"
          seedDefault={false}
        >
          {children}
        </ConnectionsProvider>
      ),
    });
    expect(result.current.connections).toHaveLength(0);
    expect(result.current.activeConnection).toBeNull();
    // apiBase falls back to defaultUrl when nothing is active.
    expect(result.current.apiBase).toBe('http://127.0.0.1:3142');
  });

  it('still runs legacy single-URL migration when seedDefault is false', async () => {
    localStorage.clear();
    localStorage.setItem('project-station-api-base', 'http://legacy-host:3141');
    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider
          defaultUrl="http://127.0.0.1:3142"
          seedDefault={false}
        >
          {children}
        </ConnectionsProvider>
      ),
    });
    expect(result.current.connections).toHaveLength(1);
    expect(result.current.connections[0].url).toBe('http://legacy-host:3141');
  });
});

describe('ConnectionsProvider — injected connection (R1)', () => {
  it('exposes a host-injected connection and resolves it as active without a saved connection', async () => {
    localStorage.clear();
    vi.resetModules();
    const { ConnectionsProvider, useConnections } = await import(
      '../react/ConnectionsContext'
    );
    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider
          defaultUrl="http://127.0.0.1:3142"
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
    });
    expect(result.current.connections).toHaveLength(1);
    expect(result.current.activeConnection?.id).toBe('managed-loopback');
    expect(result.current.apiBase).toBe('http://127.0.0.1:3142');
    // Never persisted to storage.
    expect(localStorage.getItem('station-connect-connections')).toBeNull();
  });

  it('keeps an explicit saved selection ahead of a mobile build default', async () => {
    const storage = memoryAdapter();
    const store = new ConnectionStore({ storage });
    const saved = store.add(
      'Explicit Station',
      'https://explicit.example.test',
    );
    store.setActive(saved.id);

    const { result } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider
          store={store}
          seedDefault={false}
          injectedConnection={{
            id: 'mobile-default-beta',
            name: 'Station beta',
            url: 'https://build-default.example.test:8442',
            source: 'mobile-default',
          }}
        >
          {children}
        </ConnectionsProvider>
      ),
    });

    expect(result.current.activeConnection?.id).toBe(saved.id);
    expect(result.current.apiBase).toBe('https://explicit.example.test');
    expect(result.current.connections.map(({ id }) => id)).toEqual([
      'mobile-default-beta',
      saved.id,
    ]);
  });
});

describe('ConnectionsProvider — nativeShell signal (station#1286)', () => {
  it('exposes an explicit nativeShell prop through the context, defaulting to false', () => {
    const store = makeStore();
    const { result: withoutProp } = renderHook(() => useConnections(), {
      wrapper: wrapper(store),
    });
    expect(withoutProp.current.nativeShell).toBe(false);

    const { result: withProp } = renderHook(() => useConnections(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <ConnectionsProvider
          store={store}
          defaultUrl="http://localhost:3141"
          nativeShell
        >
          {children}
        </ConnectionsProvider>
      ),
    });
    expect(withProp.current.nativeShell).toBe(true);
  });

  it('falls back to the inline Tauri-runtime-marker detector when the prop is omitted', () => {
    const store = makeStore();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const { result } = renderHook(() => useConnections(), {
        wrapper: wrapper(store),
      });
      expect(result.current.nativeShell).toBe(true);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
