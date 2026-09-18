// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const profileStorage = vi.hoisted(() => ({
  hydrate: vi.fn(async () => {}),
  authorizeDefaultProfile: vi.fn(async () => true),
  hasSavedProfiles: vi.fn(() => true),
}));

vi.mock('../native', () => ({
  nativePlatformPromise: Promise.resolve({
    platform: 'tauri',
    getCapabilityReport: async () => ({
      status: 'ok',
      value: {
        platform: 'ios',
        capabilities: [],
        devBuild: true,
      },
    }),
  }),
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
  render(
    <PlatformBootstrap>
      <div>boot child</div>
    </PlatformBootstrap>,
  );
  await screen.findByText('boot child');
  return vi.mocked(primeNativeNotifications);
}

describe('PlatformBootstrap notification priming', () => {
  afterEach(() => {
    vi.clearAllMocks();
    profileStorage.hasSavedProfiles.mockReturnValue(true);
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
});
