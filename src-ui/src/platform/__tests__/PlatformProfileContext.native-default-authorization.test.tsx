// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => [] as string[]);
const metadata = vi.hoisted(() => ({
  listener: undefined as (() => void) | undefined,
}));
const profileStorage = vi.hoisted(() => ({
  hydrate: vi.fn(async () => {
    lifecycle.push('hydrate');
  }),
  authorizeDefaultProfile: vi.fn(
    async (_forgetRememberedSelection?: boolean) => {
      lifecycle.push('authorize');
      return true;
    },
  ),
  // #2511: mobile launch reopens this device's remembered Station (falling
  // back to the shared default) while `openLastStationOnLaunch` is on, its
  // default.
  authorizeRememberedProfile: vi.fn(async () => {
    lifecycle.push('authorize');
    return true;
  }),
  hasSavedProfiles: vi.fn(() => true),
  subscribeRelayRouteProfiles: vi.fn((listener: () => void) => {
    metadata.listener = listener;
    return () => {
      metadata.listener = undefined;
    };
  }),
}));

vi.mock('../native', () => ({
  nativePlatformPromise: Promise.resolve({
    platform: 'tauri',
    getCapabilityReport: async () => ({
      status: 'ok',
      value: {
        platform: 'android',
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

import {
  PlatformBootstrap,
  useNativeProfileStoreEpoch,
} from '../PlatformProfileContext';

function NativeChild() {
  lifecycle.push('child');
  return <div>native child</div>;
}

describe('PlatformBootstrap native default authorization', () => {
  afterEach(() => {
    lifecycle.length = 0;
    vi.clearAllMocks();
  });

  it('authorizes the launch Station before native children render', async () => {
    let releaseHydration: (() => void) | undefined;
    profileStorage.hydrate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          lifecycle.push('hydrate');
          releaseHydration = resolve;
        }),
    );
    render(
      <PlatformBootstrap>
        <NativeChild />
      </PlatformBootstrap>,
    );

    await vi.waitFor(() =>
      expect(profileStorage.hydrate).toHaveBeenCalledOnce(),
    );
    expect(lifecycle).toEqual(['hydrate']);
    expect(screen.queryByText('native child')).toBeNull();

    releaseHydration?.();
    await screen.findByText('native child');
    expect(lifecycle).toEqual(['hydrate', 'authorize', 'child']);
    expect(profileStorage.authorizeRememberedProfile).toHaveBeenCalledOnce();
    expect(profileStorage.authorizeDefaultProfile).not.toHaveBeenCalled();
  });
});

it('publishes refreshed mobile host metadata to the actual ConnectionStore revision context', async () => {
  function Revision() {
    return <div>revision:{useNativeProfileStoreEpoch()}</div>;
  }
  const mounted = render(
    <PlatformBootstrap>
      <Revision />
    </PlatformBootstrap>,
  );
  await screen.findByText('revision:0');
  act(() => metadata.listener?.());
  expect(screen.getByText('revision:1')).toBeDefined();
  mounted.unmount();
  expect(metadata.listener).toBeUndefined();
});
