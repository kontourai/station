/**
 * @vitest-environment jsdom
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  NativeCapabilityReport,
  NativeCommandResult,
  NativeCompileTarget,
  NativePlatformAdapter,
} from '../platform/native/types';

type PlatformProfileAdapter = Pick<
  NativePlatformAdapter,
  | 'platform'
  | 'getCapabilityReport'
  | 'getBundledServerStatus'
  | 'subscribeToStartupReadinessRetry'
>;

const state = vi.hoisted(() => ({
  adapter: null as PlatformProfileAdapter | null,
  profileRefresh: async () => false,
  authorizeDefaultProfile: async () => false,
  authorizeActiveConnection: async (_connectionId: string) => false,
}));

vi.mock('../platform/native', () => ({
  get nativePlatformPromise() {
    return Promise.resolve(state.adapter);
  },
}));

vi.mock('../platform/native/stationProfileStorage', () => ({
  nativeStationProfileStorage: () => ({
    hydrate: async () => {},
    refresh: () => state.profileRefresh(),
    get: () => null,
    set: () => {},
    remove: () => {},
    commitVerifiedPairing: async () => {},
    makeDefault: async () => {
      throw new Error('not used');
    },
    authorizeDefaultProfile: () => state.authorizeDefaultProfile(),
    authorizeActiveConnection: (connectionId: string) =>
      state.authorizeActiveConnection(connectionId),
    credentialEntries: () => [],
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  FullScreenLoader: ({ label }: { label?: string }) => <div>{label}</div>,
}));

function platformProfileAdapter(
  overrides: Pick<PlatformProfileAdapter, 'platform' | 'getCapabilityReport'>,
) {
  const dispose = vi.fn();
  return {
    ...overrides,
    // These profile-derivation tests do not own a real bundled service. Return
    // a terminal adapter error so the desktop bootstrap exits immediately
    // instead of polling a capability the fixture never intended to model.
    getBundledServerStatus: async () => ({
      status: 'error' as const,
      command: 'bundled-server-status' as const,
      message: 'not available in the platform-profile fixture',
    }),
    subscribeToStartupReadinessRetry: vi.fn((_listener: () => void) => ({
      dispose,
    })),
  } satisfies PlatformProfileAdapter;
}

function tauriAdapter(
  target: NativeCompileTarget,
  trayState: 'enabled' | 'disabled',
) {
  return platformProfileAdapter({
    platform: 'tauri' as const,
    getCapabilityReport: async (): Promise<
      NativeCommandResult<NativeCapabilityReport>
    > => ({
      status: 'ok',
      value: {
        platform: target,
        capabilities: [
          {
            id: 'desktop-tray',
            state: trayState,
            reason: 'fixture',
          },
        ],
      },
    }),
  });
}

async function resolveProfile(adapter: typeof state.adapter) {
  state.adapter = adapter;
  vi.resetModules();
  const mod = await import('../platform/PlatformProfileContext');
  function Probe() {
    return (
      <span data-testid="profile">
        {JSON.stringify(mod.usePlatformProfile())}
      </span>
    );
  }
  render(
    <mod.PlatformBootstrap>
      <Probe />
    </mod.PlatformBootstrap>,
  );
  const node = await screen.findByTestId('profile');
  // `findByTestId` settles on the element being queryable — that is the commit,
  // not the passive-effect flush that stamps `<html>`. Treating it as "the
  // render is finished" is what let assertions about the root class read a
  // half-applied render (station#1079). Flush the effects explicitly so every
  // caller gets a settled tree; this is an ordering fix, not a longer wait.
  await act(async () => {});
  return JSON.parse(node.textContent ?? '{}');
}

async function resolveProfileWithFakeTimers(adapter: typeof state.adapter) {
  state.adapter = adapter;
  vi.resetModules();
  const mod = await import('../platform/PlatformProfileContext');
  function Probe() {
    return (
      <>
        <span data-testid="profile">{mod.usePlatformProfile().target}</span>
        <span data-testid="profile-store-epoch">
          {mod.useNativeProfileStoreEpoch()}
        </span>
      </>
    );
  }
  render(
    <mod.PlatformBootstrap>
      <Probe />
    </mod.PlatformBootstrap>,
  );
  // Avoid `findBy*` here: its retry timer deliberately does not advance while
  // this test owns fake clock time. The native Platform Profile promise resolves in the
  // microtask queue, which `act` flushes directly.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByTestId('profile')).toBeTruthy();
  return mod;
}

describe('PlatformProfile derivation', () => {
  // Unmount before asserting rather than scrubbing `is-desktop-mac` by hand.
  // This file used to remove the class between tests to compensate for
  // `PlatformBootstrap` adding it and never taking it back off; the context now
  // unwinds its own root tag, and dropping the compensation is what keeps the
  // "disabled tray" test below able to see a leak if that ever regresses.
  afterEach(() => {
    cleanup();
    state.profileRefresh = async () => false;
    state.authorizeDefaultProfile = async () => false;
    state.authorizeActiveConnection = async (_connectionId: string) => false;
    expect(document.documentElement.classList.contains('is-desktop-mac')).toBe(
      false,
    );
  });

  test('web adapter resolves to a non-native web profile', async () => {
    const profile = await resolveProfile(
      platformProfileAdapter({
        platform: 'web',
        // getCapabilityReport must never be reached for web.
        getCapabilityReport: async () => {
          throw new Error('web must not request a capability report');
        },
      }),
    );
    expect(profile).toEqual({
      isTauri: false,
      target: 'web',
      isMobile: false,
      isDesktop: false,
      supervisesBundledServer: false,
      // The web app is never the dev-tinted native build.
      isDevBuild: false,
      productName: 'Station',
    });
  });

  test('mobile tauri target is mobile and never supervises a bundled server', async () => {
    const profile = await resolveProfile(tauriAdapter('android', 'enabled'));
    expect(profile).toMatchObject({
      isTauri: true,
      target: 'android',
      isMobile: true,
      isDesktop: false,
      supervisesBundledServer: false,
    });
  });

  test('desktop macOS with an enabled tray supervises and tags the root', async () => {
    const profile = await resolveProfile(tauriAdapter('macos', 'enabled'));
    expect(profile).toMatchObject({
      isTauri: true,
      target: 'macos',
      isDesktop: true,
      isMobile: false,
      supervisesBundledServer: true,
    });
    expect(document.documentElement.classList.contains('is-desktop-mac')).toBe(
      true,
    );
  });

  test('macOS shell stamps the traffic-light inset variable on the root (station#3316)', async () => {
    await resolveProfile(tauriAdapter('macos', 'enabled'));
    expect(
      document.documentElement.style.getPropertyValue('--titlebar-inset-left'),
    ).toBe('80px');
    // Unwound with the shell tag: a leftover inset would push the toolbar of
    // whatever renders next 80px right on a host with no traffic lights.
    cleanup();
    expect(
      document.documentElement.style.getPropertyValue('--titlebar-inset-left'),
    ).toBe('');
  });

  test('non-mac shells never carry the traffic-light inset variable', async () => {
    await resolveProfile(tauriAdapter('linux', 'disabled'));
    expect(
      document.documentElement.style.getPropertyValue('--titlebar-inset-left'),
    ).toBe('');
  });

  test('unmounting takes the macOS root tag back off', async () => {
    // `<html>` outlives the bootstrap, so a tag it only ever adds is a claim
    // about the host that nothing can retract — the next thing to render
    // inherits "this is a macOS desktop shell". station#1079.
    await resolveProfile(tauriAdapter('macos', 'enabled'));
    expect(document.documentElement.classList.contains('is-desktop-mac')).toBe(
      true,
    );
    cleanup();
    expect(document.documentElement.classList.contains('is-desktop-mac')).toBe(
      false,
    );
  });

  test('desktop with a disabled tray does not supervise', async () => {
    const profile = await resolveProfile(tauriAdapter('linux', 'disabled'));
    expect(profile).toMatchObject({
      isTauri: true,
      target: 'linux',
      isDesktop: true,
      supervisesBundledServer: false,
    });
    expect(document.documentElement.classList.contains('is-desktop-mac')).toBe(
      false,
    );
  });

  test('desktop polls shared saved Station metadata and clears its observer on unmount', async () => {
    vi.useFakeTimers();
    let settleRefresh: ((changed: boolean) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleRefresh = resolve;
        }),
    );
    state.profileRefresh = refresh;
    try {
      await resolveProfileWithFakeTimers(tauriAdapter('macos', 'enabled'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      // The second interval finds the first refresh in flight rather than
      // starting another native Platform Profile read.
      expect(refresh).toHaveBeenCalledTimes(1);

      cleanup();
      settleRefresh?.(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('republishes an external secret-free profile change', async () => {
    vi.useFakeTimers();
    const profileRefresh = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    state.profileRefresh = profileRefresh;
    try {
      await resolveProfileWithFakeTimers(tauriAdapter('macos', 'enabled'));
      expect(screen.getByTestId('profile-store-epoch').textContent).toBe('0');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(screen.getByTestId('profile-store-epoch').textContent).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  test('authorizes and republishes a selected native Station before its caller may probe', async () => {
    const events: string[] = [];
    state.adapter = tauriAdapter('macos', 'enabled');
    state.authorizeActiveConnection = async (connectionId: string) => {
      events.push(`authorize:${connectionId}`);
      return true;
    };
    vi.resetModules();
    const mod = await import('../platform/PlatformProfileContext');
    let selectNativeProfile: ((connectionId: string) => Promise<void>) | null =
      null;
    function Probe() {
      selectNativeProfile = mod.useNativeProfileSelection();
      return (
        <span data-testid="profile-store-epoch">
          {mod.useNativeProfileStoreEpoch()}
        </span>
      );
    }
    render(
      <mod.PlatformBootstrap>
        <Probe />
      </mod.PlatformBootstrap>,
    );
    await screen.findByTestId('profile-store-epoch');
    await act(async () => {});

    await act(async () => {
      await selectNativeProfile?.('station-profile:remote');
    });

    expect(events).toEqual(['authorize:station-profile:remote']);
    expect(screen.getByTestId('profile-store-epoch').textContent).toBe('1');
  });

  test('carries a dev build through from the host report', async () => {
    const profile = await resolveProfile(
      platformProfileAdapter({
        platform: 'tauri',
        getCapabilityReport: async () => ({
          status: 'ok',
          value: { platform: 'android', capabilities: [], devBuild: true },
        }),
      }),
    );
    expect(profile.isDevBuild).toBe(true);
  });

  test('treats a host that omits the dev flag as a release build', async () => {
    // Older hosts do not send the field. Guessing dev would tint a real
    // install, which misidentifies the app the user is actually running.
    const profile = await resolveProfile(
      platformProfileAdapter({
        platform: 'tauri',
        getCapabilityReport: async () => ({
          status: 'ok',
          value: { platform: 'android', capabilities: [] },
        }),
      }),
    );
    expect(profile.isDevBuild).toBe(false);
  });

  test('tauri with an unreadable capability report degrades to unknown', async () => {
    const profile = await resolveProfile(
      platformProfileAdapter({
        platform: 'tauri',
        getCapabilityReport: async () => ({
          status: 'error',
          command: 'capability-report',
          message: 'report unavailable',
        }),
      }),
    );
    expect(profile).toEqual({
      isTauri: true,
      target: 'unknown',
      isMobile: false,
      isDesktop: false,
      supervisesBundledServer: false,
      // An unreadable report must not tint a real install as a dev build.
      isDevBuild: false,
      productName: 'Station',
    });
  });

  test('owns the startup readiness retry subscription for the mounted bootstrap', async () => {
    const adapter = platformProfileAdapter({
      platform: 'tauri',
      getCapabilityReport: async () => ({
        status: 'ok',
        value: { platform: 'android', capabilities: [] },
      }),
    });

    await resolveProfile(adapter);
    await vi.waitFor(() => {
      expect(adapter.subscribeToStartupReadinessRetry).toHaveBeenCalledOnce();
    });
    const subscription =
      adapter.subscribeToStartupReadinessRetry.mock.results[0]?.value;

    cleanup();

    expect(subscription?.dispose).toHaveBeenCalledOnce();
  });
});
