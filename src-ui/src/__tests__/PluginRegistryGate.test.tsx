/**
 * @vitest-environment jsdom
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { PluginRegistryGate } from '../components/registry/PluginRegistryGate';
import {
  BANNER_EXIT_MS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../core/pluginRegistryCopy';
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

  test('keeps a bundle-load failure non-dismissible with its retry action until a successful retry recovers it', async () => {
    mocks.reload
      .mockImplementationOnce(async () => {
        setLoadStatus('degraded', ['broken-layout'], 'bundle-load-failure');
        return 'degraded';
      })
      .mockImplementationOnce(async () => {
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

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/broken-layout/),
    );
    expect(screen.queryByRole('button', { name: 'Dismiss notice' })).toBeNull();
    expect(bannerStore.getSnapshot()[0]).toMatchObject({
      dismissible: false,
      actions: [{ label: 'Retry extensions' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Retry extensions' }));

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

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
    await screen.findByText(EXTENSIONS_UNAVAILABLE_LABEL);
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
    expect(screen.queryByText(EXTENSIONS_UNAVAILABLE_LABEL)).toBeNull();
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

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'plugin registry',
      ),
    );
    expect(bannerStore.getSnapshot()[0]).toMatchObject({
      actions: [{ label: 'Retry extensions' }],
    });
    expect(bannerStore.getSnapshot()[0]?.actions).toHaveLength(1);
    expect(mocks.reload).toHaveBeenCalledTimes(2);
    expect(bannerStore.getSnapshot()[0]?.priority).toBe(
      BANNER_PRIORITY.capabilityFailure,
    );
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

  test('invalidates layouts when a retry changes the degraded plugin set', async () => {
    mocks.reload
      .mockImplementationOnce(async () => {
        setLoadStatus('degraded', ['first-layout'], 'bundle-load-failure');
        return 'degraded';
      })
      .mockImplementationOnce(async () => {
        setLoadStatus('degraded', ['second-layout'], 'bundle-load-failure');
        return 'degraded';
      });

    render(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/first-layout/),
    );
    expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry extensions' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/second-layout/),
    );
    await waitFor(() =>
      expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledTimes(2),
    );
  });

  test('makes remote extension isolation dismissible and remembers dismissal for the same Station', async () => {
    mocks.connectionStatus = 'error';
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('degraded', [], 'remote-isolation');
      return 'degraded';
    });

    render(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/remote Station/),
    );
    expect(
      screen.queryByRole('button', { name: 'Retry extensions' }),
    ).toBeNull();
    expect(bannerStore.getSnapshot()[0]).toMatchObject({
      actions: [{ label: 'Review in Registry' }],
    });
    expect(bannerStore.getSnapshot()[0]?.actions).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Review in Registry' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/registry');

    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss extensions unavailable notice',
      }),
    );
    act(() => vi.advanceTimersByTime(BANNER_EXIT_MS));
    vi.useRealTimers();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      window.localStorage.getItem(
        'station:plugin-registry:remote-isolation-dismissed:local-station',
      ),
    ).toBe('1');

    act(() => setLoadStatus('degraded', [], 'remote-isolation'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('does not present the remote-isolation banner when this profile has consented', async () => {
    mocks.connectionStatus = 'error';
    setRemotePluginBundlesAllowed('local-station', mocks.apiBase, true);
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

    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));
    expect(mocks.setApiBase).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { allowRemoteBundles: true, remoteProfile: true },
    );
    expect(bannerStore.getSnapshot()).toEqual([]);
  });

  test('degrades to session-only dismissal when storage access throws', async () => {
    mocks.connectionStatus = 'error';
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('degraded', [], 'remote-isolation');
      return 'degraded';
    });
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('storage disabled');
      });
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('storage disabled');
      });
    try {
      render(
        <>
          <PluginRegistryGate>
            <main>Station shell</main>
          </PluginRegistryGate>
          <BannerHost />
        </>,
      );

      // The banner still presents (read failure = not dismissed), and the
      // shell survives the throwing storage.
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/remote Station/),
      );

      // Dismissal works session-only: the write failure is swallowed.
      vi.useFakeTimers();
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Dismiss extensions unavailable notice',
        }),
      );
      act(() => vi.advanceTimersByTime(BANNER_EXIT_MS));
      vi.useRealTimers();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Station shell')).toBeTruthy();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  test('presents remote extension isolation once for a different profile', async () => {
    mocks.connectionStatus = 'error';
    mocks.reload.mockImplementation(async () => {
      setLoadStatus('degraded', [], 'remote-isolation');
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

    await screen.findByRole('alert');
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Dismiss extensions unavailable notice',
      }),
    );
    act(() => vi.advanceTimersByTime(BANNER_EXIT_MS));
    vi.useRealTimers();

    mocks.activeConnection.id = 'different-station';
    view.rerender(
      <>
        <PluginRegistryGate>
          <main>Station shell</main>
        </PluginRegistryGate>
        <BannerHost />
      </>,
    );

    await screen.findByRole('alert');
    expect(
      screen.getByRole('button', {
        name: 'Dismiss extensions unavailable notice',
      }),
    ).toBeTruthy();
  });
});
