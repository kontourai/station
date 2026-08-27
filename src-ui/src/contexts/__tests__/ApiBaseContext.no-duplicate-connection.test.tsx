/**
 * A Desktop shell can attach to a durable per-user Station service or
 * supervise its own sidecar. Unified native status supplies one transient
 * `managed-loopback` connection for that selected local owner; an explicit
 * CLI base still takes precedence, and no status snapshot produces no
 * connection.
 *
 * The tests cover the injected connection's lifecycle states and precedence;
 * saved Station connections are outside this focused fixture.
 */
// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundledServerStatus } from '../../platform/native';

let bundledStatus: BundledServerStatus | null = null;

vi.mock('../../platform/PlatformProfileContext', () => ({
  useNativeProfileStoreEpoch: () => 0,
  useNativeProfileSelection: async () => {},
  usePlatformProfile: () => ({
    isTauri: true,
    target: 'macos',
    isMobile: false,
    isDesktop: true,
    // The real-world value on every current desktop build (`isDesktop &&
    // trayEnabled`, and `desktop-tray` is unconditionally "enabled" for
    // every non-mobile compile target) — the case that used to duplicate
    // the row.
    supervisesBundledServer: true,
    isDevBuild: false,
  }),
  nativeProfileRepository: () => ({
    get: () => null,
    set: () => {},
    remove: () => {},
    commitVerifiedPairing: async () => {},
    makeDefault: async () => {},
    authorizeActiveConnection: async () => false,
  }),
}));

vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => bundledStatus,
  restartBundledServer: vi.fn(),
}));

function running(url: string): BundledServerStatus {
  return {
    phase: 'running',
    attempt: 0,
    maxAttempts: 5,
    apiBase: url,
    port: Number(new URL(url).port),
    lastExitCode: null,
    nextRetryInMs: null,
    logPath: '/tmp/station-server.log',
    ownership: 'sidecar',
    canRunInBackground: true,
    failClosed: false,
    message: '',
  };
}

function failed(): BundledServerStatus {
  return {
    phase: 'failed',
    attempt: 5,
    maxAttempts: 5,
    apiBase: null,
    port: null,
    lastExitCode: 1,
    nextRetryInMs: null,
    logPath: '/tmp/station-server.log',
    ownership: 'none',
    canRunInBackground: false,
    failClosed: true,
    message: "Station's local service stopped.",
    detail: 'panic: boom',
  };
}

async function importFresh() {
  vi.resetModules();
  const mod = await import('../ApiBaseContext');
  const connect = await import('@kontourai/station-connect');
  return {
    ApiBaseProvider: mod.ApiBaseProvider,
    useConnections: connect.useConnections,
  };
}

describe('ApiBaseContext — desktop managed-loopback injection', () => {
  beforeEach(() => {
    bundledStatus = null;
    delete (window as unknown as { __API_BASE__?: string }).__API_BASE__;
    localStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { __API_BASE__?: string }).__API_BASE__;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('injects exactly one managed-loopback connection while the sidecar is running', async () => {
    bundledStatus = running('http://127.0.0.1:3141');
    const { ApiBaseProvider, useConnections } = await importFresh();
    const { result } = renderHook(() => useConnections(), {
      wrapper: ApiBaseProvider,
    });

    await waitFor(() => expect(result.current).toBeTruthy());
    expect(
      result.current.connections.some((c) => c.id === 'managed-loopback'),
    ).toBe(true);
    expect(
      result.current.connections.filter((c) => c.id === 'managed-loopback'),
    ).toHaveLength(1);
    expect(result.current.activeConnection?.id).toBe('managed-loopback');
  });

  it('injects a failed managed-loopback connection without a reachable base', async () => {
    bundledStatus = failed();
    const { ApiBaseProvider, useConnections } = await importFresh();
    const { result } = renderHook(() => useConnections(), {
      wrapper: ApiBaseProvider,
    });

    await waitFor(() => expect(result.current).toBeTruthy());
    expect(
      result.current.connections.some((c) => c.id === 'managed-loopback'),
    ).toBe(true);
  });

  it('does not invent a managed-loopback connection before any status snapshot has arrived', async () => {
    bundledStatus = null;
    const { ApiBaseProvider, useConnections } = await importFresh();
    const { result } = renderHook(() => useConnections(), {
      wrapper: ApiBaseProvider,
    });

    await waitFor(() => expect(result.current).toBeTruthy());
    expect(
      result.current.connections.some((c) => c.id === 'managed-loopback'),
    ).toBe(false);
  });

  it('still lets an explicit cli-base override inject as the active connection', async () => {
    (window as unknown as { __API_BASE__?: string }).__API_BASE__ =
      'http://cli-host:9099';
    bundledStatus = running('http://127.0.0.1:3141');
    const { ApiBaseProvider, useConnections } = await importFresh();
    const { result } = renderHook(() => useConnections(), {
      wrapper: ApiBaseProvider,
    });

    await waitFor(() =>
      expect(result.current.activeConnection?.id).toBe('cli-base'),
    );
    expect(result.current.apiBase).toBe('http://cli-host:9099');
    expect(
      result.current.connections.some((c) => c.id === 'managed-loopback'),
    ).toBe(false);
  });
});
