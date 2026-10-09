/**
 * @vitest-environment jsdom
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { PluginRegistryGate } from '../components/registry/PluginRegistryGate';
import { bannerStore } from '../contexts/banner-store';
import { toastStore } from '../contexts/ToastContext';
import { setRemotePluginBundlesAllowed } from '../core/remotePluginBundleConsent';

const mocks = vi.hoisted(() => ({
  activeConnection: {
    id: 'local-station',
    credentialState: 'saved',
  },
  apiBase: 'http://127.0.0.1:3141',
  connectionStatus: 'connected' as 'connected' | 'connecting' | 'error',
  listeners: new Set<() => void>(),
  queryClient: { invalidateQueries: vi.fn() },
  reload: vi.fn(),
  setApiBase: vi.fn(),
  setLoadStatus: vi.fn(),
  navigate: vi.fn(),
  status: {
    failedPluginNames: [] as readonly string[],
    failure: undefined as
      | 'remote-isolation'
      | 'registry-unavailable'
      | 'bundle-load-failure'
      | undefined,
    state: 'loading' as 'loading' | 'ready' | 'degraded',
  },
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: mocks.apiBase }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: mocks.activeConnection }),
  useConnectionStatus: () => ({ status: mocks.connectionStatus }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: {
    getLoadStatus: () => mocks.status,
    reload: mocks.reload,
    setApiBase: mocks.setApiBase,
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));

function setLoadStatus(
  state: 'loading' | 'ready' | 'degraded',
  failedPluginNames: readonly string[] = [],
  failure?: 'remote-isolation' | 'registry-unavailable' | 'bundle-load-failure',
) {
  mocks.status = { failedPluginNames, failure, state };
  for (const listener of mocks.listeners) listener();
}

describe('PluginRegistryGate', () => {
  beforeEach(() => {
    bannerStore.reset();
    toastStore.clear();
    window.localStorage.clear();
    mocks.listeners.clear();
    mocks.queryClient.invalidateQueries.mockReset();
    mocks.reload.mockReset();
    mocks.setApiBase.mockReset();
    mocks.setLoadStatus.mockReset();
    mocks.navigate.mockReset();
    mocks.activeConnection.id = 'local-station';
    mocks.connectionStatus = 'connected';
    setLoadStatus('loading');
  });

  afterEach(() => {
    cleanup();
    bannerStore.reset();
    toastStore.clear();
  });

  test('keeps the ready shell clear of banners and invalidates layouts after loading settles', async () => {
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('ready');
      return 'ready';
    });

    render(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    expect(screen.getByText('Station shell')).toBeTruthy();
    await waitFor(() =>
      expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ['layouts'],
      }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([false, true])(
    'notifies a genuine bundle failure without a global banner (consent: %s)',
    async (consented) => {
      setRemotePluginBundlesAllowed('local-station', mocks.apiBase, consented);
      mocks.reload.mockImplementation(async () => {
        setLoadStatus('degraded', ['broken-layout'], 'bundle-load-failure');
        return 'degraded';
      });
      render(
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>,
      );
      await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(1));
      expect(bannerStore.getSnapshot()).toHaveLength(0);
      expect(toastStore.getSnapshot()[0]?.message).toContain('broken-layout');
      toastStore.getSnapshot()[0]?.actions?.[0]?.onClick();
      expect(mocks.navigate).toHaveBeenCalledWith('/registry');
      act(() => setLoadStatus('ready'));
      expect(toastStore.getSnapshot()).toHaveLength(0);
    },
  );

  test.each(['ready', 'degraded'] as const)(
    'first connection lets the initial load settle %s before deciding whether to retry',
    async (settled) => {
      mocks.connectionStatus = 'connecting';
      mocks.reload.mockImplementation(async () => 'loading');
      const view = render(
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>,
      );
      await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
      mocks.connectionStatus = 'connected';
      view.rerender(
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>,
      );
      expect(mocks.reload).toHaveBeenCalledTimes(1);
      act(() =>
        setLoadStatus(
          settled,
          [],
          settled === 'degraded' ? 'registry-unavailable' : undefined,
        ),
      );
      await waitFor(() =>
        expect(mocks.reload).toHaveBeenCalledTimes(settled === 'ready' ? 1 : 2),
      );
    },
  );

  test('reloads on reconnect even when the outage-era attempt has not settled yet', async () => {
    // The reconnect can land while the offline attempt is still in flight.
    // Gating the reload on the SETTLED state loses it entirely: the transition
    // is spent by the time the old attempt reports degraded, and the banner
    // then reports a failure no post-reconnect attempt ever produced.
    mocks.connectionStatus = 'error';
    mocks.reload.mockImplementation(async () => 'loading');

    const view = render(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    setLoadStatus('loading');

    mocks.connectionStatus = 'connected';
    view.rerender(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    // A fresh attempt is what earns the right to report a failure.
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(2));

    setLoadStatus('degraded', [], 'registry-unavailable');
    view.rerender(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );
    await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('suppresses an outage-caused registry failure, then presents it once the connection is healthy', async () => {
    mocks.connectionStatus = 'error';
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('degraded', [], 'registry-unavailable');
      return 'degraded';
    });

    const view = render(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(toastStore.getSnapshot()).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: 'Retry extensions' }),
    ).toBeNull();

    mocks.connectionStatus = 'connected';
    view.rerender(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(1));
    expect(toastStore.getSnapshot()[0]?.actions?.[0]?.label).toBe(
      'Open Extensions',
    );
    expect(bannerStore.getSnapshot()).toHaveLength(0);
    expect(mocks.reload).toHaveBeenCalledTimes(2);
  });

  test('automatically clears an outage-caused registry failure when reconnect reload succeeds', async () => {
    mocks.connectionStatus = 'error';
    mocks.reload
      .mockImplementationOnce(async () => {
        setLoadStatus('degraded', [], 'registry-unavailable');
        return 'degraded';
      })
      .mockImplementationOnce(async () => {
        setLoadStatus('ready');
        return 'ready';
      });

    const view = render(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();

    mocks.connectionStatus = 'connected';
    view.rerender(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  test('invalidates layouts when a reload changes the degraded plugin set', async () => {
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('degraded', ['first-layout'], 'bundle-load-failure');
      return 'degraded';
    });
    render(
      <PluginRegistryGate>
        <main>Station shell</main>
      </PluginRegistryGate>,
    );
    await waitFor(() =>
      expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledTimes(1),
    );
    act(() =>
      setLoadStatus('degraded', ['second-layout'], 'bundle-load-failure'),
    );
    await waitFor(() =>
      expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledTimes(2),
    );
    expect(bannerStore.getSnapshot()).toHaveLength(0);
  });

  test('keeps intentional remote isolation quiet across profile changes and unavailable storage', async () => {
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('degraded', [], 'remote-isolation');
      return 'degraded';
    });
    const storage = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('Storage disabled');
      });
    try {
      const view = render(
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>,
      );
      await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
      expect(bannerStore.getSnapshot()).toHaveLength(0);
      expect(toastStore.getSnapshot()).toHaveLength(0);
      mocks.activeConnection.id = 'other-station';
      view.rerender(
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>,
      );
      await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(2));
      expect(bannerStore.getSnapshot()).toHaveLength(0);
      expect(toastStore.getSnapshot()).toHaveLength(0);
      expect(screen.getByText('Station shell')).toBeTruthy();
    } finally {
      storage.mockRestore();
    }
  });
});
