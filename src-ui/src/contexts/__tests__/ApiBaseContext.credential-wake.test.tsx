/**
 * #3602 — a browser device session re-pairing releases a terminally parked
 * SSE stream.
 *
 * `fetchSSE` stops permanently on a 401 rather than hot-looping against a
 * credential the Station has rejected (archive#1094), and waits for
 * `notifyCredentialChanged` for its origin. `ApiBaseContext` is what sends
 * that signal — and it used to send it on a change in the saved credential
 * VALUE, which a browser device session never has: `undefined` before pairing
 * and `undefined` after. So the one event the wake exists for could not be
 * observed, and a parked stream stayed parked until unrelated traffic or a
 * manual retry.
 *
 * This drives the real provider, the real store and the real `fetchSSE`; only
 * the peripheral modules `ApiBaseProvider` needs are substituted.
 */
// @vitest-environment jsdom

import { useConnections } from '@kontourai/station-connect';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
  restartBundledServer: vi.fn(),
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  useNativeProfileStoreEpoch: () => 0,
  useNativeProfileSelection: () => async () => {},
  usePlatformProfile: () => ({
    isTauri: false,
    target: 'web',
    isMobile: false,
    isDesktop: false,
    supervisesBundledServer: false,
    isDevBuild: false,
  }),
  nativeProfileRepository: () => ({
    get: () => null,
    set: () => {},
    remove: () => {},
    commitVerifiedPairing: async () => {},
    makeDefault: async () => {},
    authorizeActiveConnection: async () => false,
    pendingLocalSelfProvisionProfileName: () => undefined,
    refresh: async () => false,
  }),
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionManagerModal: () => null,
}));

import { fetchSSE } from '@kontourai/station-sdk';
import { ApiBaseProvider } from '../ApiBaseContext';

type ConnectionsApi = ReturnType<typeof useConnections>;

let connections: ConnectionsApi | undefined;

function ConnectionsProbe() {
  connections = useConnections();
  return null;
}

async function renderShell() {
  render(
    <ApiBaseProvider>
      <ConnectionsProbe />
      <div>App</div>
    </ApiBaseProvider>,
  );
  await screen.findByText('App');
  const active = connections?.activeConnection;
  if (!active) throw new Error('no active connection to base the test on');
  return active.id;
}

describe('a parked SSE stream wakes when the device session is re-paired', () => {
  afterEach(() => {
    connections = undefined;
    vi.unstubAllGlobals();
  });

  it('wakes on the pairing, which changes no credential value', async () => {
    const origin = window.location.origin;
    const id = await renderShell();

    // The stream is rejected and parks. Every later call is left hanging, so
    // a second call can only be the wake.
    const streamFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockImplementation(async () => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', streamFetch);

    const stream = fetchSSE(`${origin}/api/events`, {
      retryDelayMs: 10,
      onMessage: () => undefined,
    });
    await waitFor(() => expect(streamFetch).toHaveBeenCalledTimes(1));
    // Parked: no retry ladder is running behind this.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(streamFetch).toHaveBeenCalledTimes(1);

    // A browser device session has no credential value, before or after.
    expect(connections?.getConnectionCredential(id)).toBeUndefined();
    await act(async () => {
      connections?.markDeviceSession(id);
    });
    expect(connections?.getConnectionCredential(id)).toBeUndefined();

    await waitFor(() => expect(streamFetch).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    stream.close();
  });

  it('leaves a parked stream alone when nothing gained authority', async () => {
    // The wake has to stay a statement about credentials: renaming the
    // connection must not resume a stream whose credential is still rejected.
    const origin = window.location.origin;
    const id = await renderShell();

    const streamFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockImplementation(async () => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', streamFetch);

    const stream = fetchSSE(`${origin}/api/events`, {
      retryDelayMs: 10,
      onMessage: () => undefined,
    });
    await waitFor(() => expect(streamFetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      connections?.updateConnection(id, { name: 'Renamed' });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(streamFetch).toHaveBeenCalledTimes(1);
    stream.close();
  });
});
