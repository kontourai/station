/** @vitest-environment jsdom */

import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeNativeCapabilityReport } from '../../platform/native/__tests__/completeNativeCapabilityReportFixture';
import { TauriNativePlatformAdapter } from '../../platform/native/tauri';

/**
 * #2515: a card tap's route reaches the navigator through the REAL Tauri
 * adapter and the REAL validation, over a fake plugin bridge that holds one
 * pending route the way AgentActivityPlugin.kt does (take returns and
 * clears it; a nudge announces a new one).
 */
let target = 'android';
const navigate = vi.fn();
let pending: unknown = null;
let nudge: (() => void) | undefined;
let adapterPromise: Promise<TauriNativePlatformAdapter>;

vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ target }),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    apiBase: 'https://station.test',
    activeConnection: { environmentId: 'env-a' },
  }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate }),
}));
vi.mock('../../platform/native', () => ({
  get nativePlatformPromise() {
    return adapterPromise;
  },
}));

import { AgentActivityLaunchRoutes } from '../AgentActivityRefresher';

async function phoneAdapter() {
  const adapter = new TauriNativePlatformAdapter({
    async invoke<T>(command: string) {
      if (command === 'native_capability_report') {
        return completeNativeCapabilityReport('android', {
          'remote-push': { state: 'enabled' },
        }) as T;
      }
      if (command === 'plugin:station-agent-activity|take_launch_route') {
        const route = pending;
        pending = null;
        return { route } as T;
      }
      return null as T;
    },
    listen: async () => () => {},
    async addPluginListener(_plugin, _event, handler) {
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
    navigate.mockClear();
    adapterPromise = phoneAdapter();
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
    expect(navigate).toHaveBeenCalledWith('/projects/login-app', {
      chat: 'thread-1',
      dock: 'open',
    });
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
    expect(navigate).toHaveBeenCalledWith('/', {
      chat: 'thread-2',
      dock: 'open',
    });
  });

  it('ignores a route for another Station or outside the grammar, and consumes it', async () => {
    pending = { stationId: 'env-b', sessionId: 'thread-1' };
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

  it('does nothing outside the Android app', async () => {
    target = 'macos';
    pending = { stationId: 'env-a', sessionId: 'thread-1' };
    render(<AgentActivityLaunchRoutes />);
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    expect(nudge).toBeUndefined();
  });
});
