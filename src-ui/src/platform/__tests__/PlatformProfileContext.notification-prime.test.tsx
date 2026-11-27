// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const profileStorage = vi.hoisted(() => ({
  hydrate: vi.fn(async () => {}),
  authorizeDefaultProfile: vi.fn(async () => true),
  authorizeRememberedProfile: vi.fn(async () => true),
  hasSavedProfiles: vi.fn(() => true),
  subscribeRelayRouteProfiles: vi.fn(() => () => {}),
}));

const nativeTarget = vi.hoisted(() => ({ platform: 'ios' }));
const unregisterDiscovery = vi.hoisted(() => vi.fn());

vi.mock('../native', () => ({
  nativePlatformPromise: Promise.resolve({
    platform: 'tauri',
    getCapabilityReport: async () => ({
      status: 'ok',
      value: {
        platform: nativeTarget.platform,
        capabilities: [],
        devBuild: true,
      },
    }),
  }),
}));

// Discovery IPC is covered by connectionDiscovery.test.ts; this notification
// fixture owns only boot priming and waits for its unrelated lazy effect.
vi.mock('../native/connectionDiscovery', () => ({
  registerNativeConnectionDiscovery: vi.fn(() => unregisterDiscovery),
}));

vi.mock('../native/bundledLocalProfileBootstrap', () => ({
  bootstrapBundledLocalProfile: vi.fn(async () => ({})),
}));

vi.mock('../native/notify', () => ({
  primeNativeNotifications: vi.fn(),
}));

vi.mock('../native/stationProfileStorage', () => ({
  nativeStationProfileStorage: () => profileStorage,
}));

async function renderFreshBootstrap() {
  // The bootstrap runs once per module load (`profileReady`), so each case
  // needs a fresh module registry to observe its own boot.
  vi.resetModules();
  const { PlatformBootstrap } = await import('../PlatformProfileContext');
  const { primeNativeNotifications } = await import('../native/notify');
  const { registerNativeConnectionDiscovery } = await import(
    '../native/connectionDiscovery'
  );
  render(
    <PlatformBootstrap>
      <div>boot child</div>
    </PlatformBootstrap>,
  );
  await screen.findByText('boot child');
  await waitFor(() =>
    expect(registerNativeConnectionDiscovery).toHaveBeenCalledOnce(),
  );
  return vi.mocked(primeNativeNotifications);
}

describe('PlatformBootstrap notification priming', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    profileStorage.hasSavedProfiles.mockReturnValue(true);
    nativeTarget.platform = 'ios';
  });

  it('primes notifications at boot when a saved Station exists', async () => {
    const prime = await renderFreshBootstrap();
    expect(profileStorage.hasSavedProfiles).toHaveBeenCalled();
    expect(prime).toHaveBeenCalledOnce();
  });

  it('skips the boot prime on a fresh device with no saved Station', async () => {
    profileStorage.hasSavedProfiles.mockReturnValue(false);
    const prime = await renderFreshBootstrap();
    expect(prime).not.toHaveBeenCalled();
  });

  it('registers Nearby in a trusted Windows shell and disposes its provider on unmount', async () => {
    nativeTarget.platform = 'windows';
    await renderFreshBootstrap();
    expect(unregisterDiscovery).not.toHaveBeenCalled();
    cleanup();
    expect(unregisterDiscovery).toHaveBeenCalledOnce();
  });
});
