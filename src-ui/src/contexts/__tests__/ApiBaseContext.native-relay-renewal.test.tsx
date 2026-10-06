/** @vitest-environment jsdom */
import type { StationProfileStore } from '@kontourai/station-contracts';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeStationProfileStorage } from '../../platform/native/stationProfileStorage';

const host = vi.hoisted(() => ({
  repository: null as NativeStationProfileStorage | null,
  invoke:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => host.repository,
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => ({
    isTauri: true,
    isDesktop: false,
    isMobile: true,
    supervisesBundledServer: false,
    target: 'ios',
    channel: 'nightly',
  }),
}));
vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
}));
vi.mock('../../platform/native/tauriInvoke', () => ({
  invokeTauri: (command: string, args?: Record<string, unknown>) =>
    host.invoke(command, args),
}));

// The production ApiBase mount imports the real supervisor and closed RPC adapter.
import { ApiBaseProvider } from '../ApiBaseContext';

const route = {
  brokerOrigin: 'https://broker.example.test',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};
let currentStore: StationProfileStore;
let visibility: DocumentVisibilityState;
let expiry: number;
function metadata() {
  return {
    route: { ...route, routingGeneration: 1, grantId: 'grant-current' },
    stationSigningKeyId: 'approved-signing-key',
    stationSigningGeneration: 1,
    expiresAt: expiry,
  };
}
function status() {
  return {
    profileName: 'relay',
    profileRevision: currentStore.revision,
    stationId: route.stationId,
    enrollmentId: route.enrollmentId,
    grants: [{ metadata: metadata(), expired: false }],
    cleanups: [],
  };
}
function commands(name: string) {
  return host.invoke.mock.calls.filter(([command]) => command === name);
}
function foreground(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}
beforeEach(async () => {
  visibility = 'visible';
  expiry = Date.now() + 10_000;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility,
  );
  currentStore = {
    schemaVersion: 1,
    revision: 7,
    defaultProfile: null,
    projectProfiles: {},
    profiles: [
      {
        schemaVersion: 1,
        name: 'relay',
        endpoint: 'https://station.example.test',
        relayRoute: route,
        setupSource: 'manual',
        configurationState: 'unconfigured',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  host.repository = new NativeStationProfileStorage({
    async invoke<T>(command: string) {
      if (command === 'station_profile_store_read')
        return structuredClone(currentStore) as T;
      throw new Error(command);
    },
  });
  await host.repository.hydrate();
  host.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === 'station_native_relay_grant_status') return status();
    if (command === 'station_native_relay_grant_renew') {
      if (args?.expectedProfileRevision !== currentStore.revision)
        throw new Error('StaleProfile');
      expiry = Date.now() + 24 * 60 * 60 * 1000;
      return metadata();
    }
    throw new Error(`unexpected fixed host command: ${command}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  host.repository = null;
});
it('mounts renewal on iOS only while visible and rechecks host custody on foreground wake', async () => {
  foreground('hidden');
  render(
    <ApiBaseProvider>
      <div>native route</div>
    </ApiBaseProvider>,
  );
  // Flush mounted imports without starting a supervisor RPC while hidden.
  await act(async () => {
    await import('../../platform/native/nativeRelayGrantRenewalSupervisor');
    await import('../../platform/native/nativeRelayGrantRenewalAdapter');
  });
  expect(host.invoke).not.toHaveBeenCalled();
  act(() => foreground('visible'));
  await waitFor(() =>
    expect(commands('station_native_relay_grant_renew')).toHaveLength(1),
  );
  expect(commands('station_native_relay_grant_renew')[0][1]).toEqual({
    profileName: 'relay',
    expectedProfileRevision: 7,
  });
  expect(commands('station_native_relay_grant_status')).toHaveLength(2);
  act(() => foreground('hidden'));
  const count = host.invoke.mock.calls.length;
  act(() => window.dispatchEvent(new Event('focus')));
  expect(host.invoke).toHaveBeenCalledTimes(count);
  act(() => foreground('visible'));
  await waitFor(() =>
    expect(commands('station_native_relay_grant_status')).toHaveLength(3),
  );
  expect(commands('station_native_relay_grant_renew')).toHaveLength(1);
  cleanup();
  const stopped = host.invoke.mock.calls.length;
  act(() => window.dispatchEvent(new Event('focus')));
  expect(host.invoke).toHaveBeenCalledTimes(stopped);
});
it('drops retired profile status and renews only from the replacement host revision', async () => {
  let resolve!: (value: unknown) => void;
  const oldStatus = status();
  host.invoke.mockImplementationOnce(
    () =>
      new Promise<unknown>((done) => {
        resolve = done;
      }),
  );
  render(
    <ApiBaseProvider>
      <div>native route</div>
    </ApiBaseProvider>,
  );
  await waitFor(() =>
    expect(commands('station_native_relay_grant_status')).toHaveLength(1),
  );
  currentStore = {
    ...currentStore,
    revision: 8,
    profiles: currentStore.profiles.map((profile) => ({
      ...profile,
      updatedAt: 2,
    })),
  };
  await act(async () => {
    if (!host.repository) throw new Error('native profile fixture missing');
    await host.repository.refresh();
    resolve(oldStatus);
  });
  await waitFor(() =>
    expect(commands('station_native_relay_grant_renew')).toHaveLength(1),
  );
  expect(commands('station_native_relay_grant_renew')[0][1]).toEqual({
    profileName: 'relay',
    expectedProfileRevision: 8,
  });
  expect(
    commands('station_native_relay_grant_renew').some(
      ([, args]) => args?.expectedProfileRevision === 7,
    ),
  ).toBe(false);
});
