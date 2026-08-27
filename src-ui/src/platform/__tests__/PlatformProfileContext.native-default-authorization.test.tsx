// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => [] as string[]);
const readinessProof = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const profileStorage = vi.hoisted(() => ({
  hydrate: vi.fn(async () => {
    lifecycle.push('hydrate');
  }),
  authorizeDefaultProfile: vi.fn(async () => {
    lifecycle.push('authorize');
    return true;
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

vi.mock('../native/startupReadiness', () => ({
  startStartupReadinessProof: readinessProof,
}));

import { PlatformBootstrap } from '../PlatformProfileContext';

function NativeChild() {
  lifecycle.push('child');
  return <div>native child</div>;
}

describe('PlatformBootstrap native default authorization', () => {
  afterEach(() => {
    lifecycle.length = 0;
    vi.clearAllMocks();
  });

  it('starts the native readiness proof while profile hydration is pending and authorizes before native children render', async () => {
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

    await vi.waitFor(() => expect(readinessProof).toHaveBeenCalledOnce());
    expect(lifecycle).toEqual(['hydrate']);
    expect(screen.queryByText('native child')).toBeNull();

    releaseHydration?.();
    await screen.findByText('native child');
    expect(lifecycle).toEqual(['hydrate', 'authorize', 'child']);
    expect(readinessProof).toHaveBeenCalledOnce();
  });
});
