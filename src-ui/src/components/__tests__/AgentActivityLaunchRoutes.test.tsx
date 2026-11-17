/** @vitest-environment jsdom */

import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNotificationOpenNotice,
  installNotificationOpener,
  openNotificationTarget,
  setNotificationOpenNotice,
} from '../../lib/notificationStationOpen';
import { completeNativeCapabilityReport } from '../../platform/native/__tests__/completeNativeCapabilityReportFixture';
import { TauriNativePlatformAdapter } from '../../platform/native/tauri';

/**
 * #2515: a card tap's route reaches the navigator through the REAL Tauri
 * adapter, the REAL validation and the REAL notification opener, over a
 * fake plugin bridge that holds one pending route the way
 * AgentActivityPlugin.kt does (take returns and clears it; a nudge announces
 * a new one). The phone is paired with two Stations, A (connected) and B.
 */
let target = 'android';
const navigate = vi.fn();
let pending: unknown = null;
let nudge: (() => void) | undefined;
/** Resolved by a test to finish the plugin listener registration; null = at once. */
let registration: Promise<void> | null = null;
let takes = 0;
let adapterPromise: Promise<TauriNativePlatformAdapter>;

vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ target }),
}));
const STATION_A = {
  id: 'conn-a',
  name: 'Studio Mac',
  url: 'https://a.example',
  environmentId: 'env-a',
};
const STATION_B = {
  id: 'conn-b',
  name: 'Home server',
  url: 'https://b.example',
  environmentId: 'env-b',
};
let active = STATION_A;
const switched: string[] = [];
let uninstallOpener: () => void = () => {};
vi.mock('../../platform/native', () => ({
  get nativePlatformPromise() {
    return adapterPromise;
  },
}));

import { AgentActivityLaunchRoutes } from '../AgentActivityRefresher';

async function phoneAdapter(platform: 'android' | 'ios' = 'android') {
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport(platform, {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      if (command === 'plugin:station-agent-activity|take_launch_route') {
        takes += 1;
        const route = pending;
        pending = null;
        return { route } as T;
      }
      return null as T;
    },
    listen: async () => () => {},
    async addPluginListener(_plugin, _event, handler) {
      if (registration) await registration;
      nudge = handler;
      return () => {
        nudge = undefined;
      };
    },
  });
  await adapter.getCapabilityReport();
  return adapter;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
}

describe('AgentActivityLaunchRoutes', () => {
  beforeEach(() => {
    target = 'android';
    pending = null;
    nudge = undefined;
    registration = null;
    takes = 0;
    navigate.mockClear();
    adapterPromise = phoneAdapter();
    active = STATION_A;
    switched.length = 0;
    uninstallOpener = installNotificationOpener((request) => {
      void openNotificationTarget(request, {
        connections: () => [STATION_A, STATION_B],
        active: () => active,
        committedActiveId: () => active.id,
        setActiveConnection: async (id) => {
          switched.push(id);
          active = id === STATION_B.id ? STATION_B : STATION_A;
        },
        navigate: (pathname, params) => navigate(pathname, params, active.id),
      });
    });
  });

  afterEach(() => {
    uninstallOpener();
    setNotificationOpenNotice(null);
  });

  it('opens the session a tap that launched the app names', async () => {
    pending = {
      stationId: 'env-a',
      sessionId: 'thread-1',
      projectSlug: 'login-app',
    };
    render(<AgentActivityLaunchRoutes />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    await settle();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      '/projects/login-app',
      { chat: 'thread-1', dock: 'open' },
      'conn-a',
    );
    expect(switched).toEqual([]);
    expect(pending).toBeNull();
  });

  it('opens the session a tap names while the app runs, on the plugin nudge', async () => {
    render(<AgentActivityLaunchRoutes />);
    await waitFor(() => expect(nudge).toBeDefined());
    await settle();
    expect(navigate).not.toHaveBeenCalled();

    pending = { stationId: 'env-a', sessionId: 'thread-2' };
    await act(async () => nudge?.());
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(
      '/',
      { chat: 'thread-2', dock: 'open' },
      'conn-a',
    );
  });

  it('a tap from the other paired Station switches to it, then opens the session there', async () => {
    pending = { stationId: 'env-b', sessionId: 'thread-1' };
    render(<AgentActivityLaunchRoutes />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(switched).toEqual(['conn-b']);
    // Navigated only once B was active: the id is looked up on its Station.
    expect(navigate).toHaveBeenCalledWith(
      '/',
      { chat: 'thread-1', dock: 'open' },
      'conn-b',
    );
  });

  it('a tap from a Station not saved here says so instead of opening nothing', async () => {
    pending = { stationId: 'env-unpaired', sessionId: 'thread-1' };
    render(<AgentActivityLaunchRoutes />);
    await waitFor(() =>
      expect(getNotificationOpenNotice()).toEqual({ kind: 'not-saved' }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores a route outside the grammar, and consumes it', async () => {
    pending = { stationId: 'env-a', sessionId: 'a/b' };
    render(<AgentActivityLaunchRoutes />);
    // Taken (cleared) proves the route was read, not that nothing ran.
    await waitFor(() => expect(pending).toBeNull());
    await waitFor(() => expect(nudge).toBeDefined());
    pending = { stationId: 'env-a', sessionId: '../settings' };
    await act(async () => nudge?.());
    await waitFor(() => expect(pending).toBeNull());
    await settle();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('takes the pending route only after the nudge listener is registered', async () => {
    let finishRegistration: () => void = () => {};
    registration = new Promise((resolve) => {
      finishRegistration = resolve;
    });
    pending = { stationId: 'env-a', sessionId: 'thread-1' };
    render(<AgentActivityLaunchRoutes />);
    await settle();
    // Still registering: taking now would leave a window in which a tap is
    // neither pending at the take nor announced to a listener.
    expect(takes).toBe(0);
    expect(nudge).toBeUndefined();
    finishRegistration();
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(takes).toBe(1);
    expect(nudge).toBeDefined();
  });

  it('an iOS alert tap opens through the same path', async () => {
    target = 'ios';
    adapterPromise = phoneAdapter('ios');
    pending = {
      stationId: 'env-b',
      sessionId: 'thread-ios',
      projectSlug: 'web',
    };
    render(<AgentActivityLaunchRoutes />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(switched).toEqual(['conn-b']);
    expect(navigate).toHaveBeenCalledWith(
      '/projects/web',
      { chat: 'thread-ios', dock: 'open' },
      'conn-b',
    );
  });

  it('an alert tap names its record, so opening it reads it (iOS and Android)', async () => {
    for (const platform of ['ios', 'android'] as const) {
      navigate.mockClear();
      target = platform;
      adapterPromise = phoneAdapter(platform);
      // The plugin's route: the sealed alert's `notification_id` rides it.
      pending = {
        stationId: 'env-a',
        sessionId: 'thread-1',
        notificationId: 'notif-0001',
      };
      const { unmount } = render(<AgentActivityLaunchRoutes />);
      await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
      expect(navigate).toHaveBeenCalledWith(
        '/',
        { chat: 'thread-1', dock: 'open', openedNotification: 'notif-0001' },
        'conn-a',
      );
      unmount();
    }
    // An id outside the record grammar drops only the read.
    navigate.mockClear();
    pending = {
      stationId: 'env-a',
      sessionId: 'thread-1',
      notificationId: 'a/b',
    };
    render(<AgentActivityLaunchRoutes />);
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(
      '/',
      { chat: 'thread-1', dock: 'open' },
      'conn-a',
    );
  });

  it('does nothing outside the phone apps', async () => {
    target = 'macos';
    pending = { stationId: 'env-a', sessionId: 'thread-1' };
    render(<AgentActivityLaunchRoutes />);
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    expect(nudge).toBeUndefined();
  });
});
