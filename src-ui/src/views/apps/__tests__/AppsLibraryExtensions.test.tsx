/**
 * @vitest-environment jsdom
 *
 * The remote extension code controls and the "couldn't load" notice moved
 * from the Registry page to Apps › Library, unchanged. These drive the
 * Library tab itself (AppsView) through the real control and the real
 * consent store, so they prove the moved controls still reach the same
 * consent states, dialogs and reload.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as remotePluginBundleConsent from '../../../core/remotePluginBundleConsent';

const API_BASE = 'http://127.0.0.1:3141';
const CONNECTION_ID = 'local-station';

const pluginRegistryListeners = new Set<() => void>();
let pluginRegistryStatus: {
  state: 'ready' | 'degraded';
  failedPluginNames: readonly string[];
  failure:
    | 'remote-isolation'
    | 'registry-unavailable'
    | 'bundle-load-failure'
    | undefined;
} = { state: 'ready', failedPluginNames: [], failure: undefined };
const pluginRegistryReload = vi.fn();
const platformProfile = vi.hoisted(() => ({ isTauri: false }));

vi.mock('../../PluginManagementView', () => ({
  PluginManagementView: () => <div data-testid="installed-apps" />,
}));
vi.mock('../DiscoverView', () => ({ DiscoverView: () => null }));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: CONNECTION_ID },
    captureSelectionIntent: () => 0,
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: API_BASE }),
}));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platformProfile,
}));
vi.mock('../../../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: (listener: () => void) => {
      pluginRegistryListeners.add(listener);
      return () => pluginRegistryListeners.delete(listener);
    },
    getLoadStatus: () => pluginRegistryStatus,
    reload: () => pluginRegistryReload(),
  },
}));

import { AppsView } from '../AppsView';

function setStatus(next: typeof pluginRegistryStatus) {
  act(() => {
    pluginRegistryStatus = next;
    for (const listener of pluginRegistryListeners) listener();
  });
}
const REFUSED = {
  state: 'degraded',
  failedPluginNames: [],
  failure: 'remote-isolation',
} as const;
const follows = (a: Node, b: Node) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

afterEach(() => {
  localStorage.clear();
  pluginRegistryReload.mockClear();
  platformProfile.isTauri = false;
  pluginRegistryStatus = {
    state: 'ready',
    failedPluginNames: [],
    failure: undefined,
  };
  pluginRegistryListeners.clear();
});

describe('Apps › Library extension controls', () => {
  test('a refused extension load shows the switch before the installed apps, and allowing stores consent for this Station', () => {
    render(<AppsView tab="library" />);
    setStatus(REFUSED);
    expect(
      screen.getByText(
        /Extensions from http:\/\/127.0.0.1:3141 are off on this device/,
      ),
    ).toBeTruthy();
    const review = screen.getByRole('button', { name: 'Review and enable' });
    expect(follows(review, screen.getByTestId('installed-apps'))).toBe(true);
    fireEvent.click(review);
    expect(
      screen.getByText(/other Stations' data, credentials in this window/i),
    ).toBeTruthy();
    expect(screen.queryByText(/applies only to this Station/i)).toBeNull();
    expect(
      remotePluginBundleConsent.remotePluginBundlesAllowed(
        CONNECTION_ID,
        API_BASE,
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Allow extensions' }));
    expect(
      remotePluginBundleConsent.remotePluginBundlesAllowed(
        CONNECTION_ID,
        API_BASE,
      ),
    ).toBe(true);
  });

  test('names framed native loading and its unverified protection', () => {
    platformProfile.isTauri = true;
    render(<AppsView tab="library" />);
    setStatus(REFUSED);
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    expect(
      screen.getByText(/runs in frames whose isolation isn't verified/),
    ).toBeTruthy();
    expect(screen.queryByText(/runs inside this app/)).toBeNull();
  });

  test('granted consent keeps Turn off after the installed apps, and turning off reloads only once revocation is saved', () => {
    platformProfile.isTauri = true;
    remotePluginBundleConsent.setRemotePluginBundlesAllowed(
      CONNECTION_ID,
      API_BASE,
      true,
    );
    const reload = vi
      .spyOn(remotePluginBundleConsent, 'reloadAfterRemotePluginBundleRevoke')
      .mockImplementation(() => {});
    try {
      render(<AppsView tab="library" />);
      // The refusal lingers until the reload completes (archive#2539).
      setStatus(REFUSED);
      const disable = screen.getByRole('button', {
        name: 'Turn off extensions',
      });
      expect(follows(screen.getByTestId('installed-apps'), disable)).toBe(true);
      fireEvent.click(disable);
      fireEvent.click(
        screen.getByRole('button', { name: 'Turn off and reload' }),
      );
      expect(reload).toHaveBeenCalledOnce();
      expect(
        remotePluginBundleConsent.remotePluginBundlesAllowed(
          CONNECTION_ID,
          API_BASE,
        ),
      ).toBe(false);
    } finally {
      reload.mockRestore();
    }
  });

  test('keeps extensions allowed and says so when revocation cannot be saved', () => {
    platformProfile.isTauri = true;
    remotePluginBundleConsent.setRemotePluginBundlesAllowed(
      CONNECTION_ID,
      API_BASE,
      true,
    );
    const reload = vi
      .spyOn(remotePluginBundleConsent, 'reloadAfterRemotePluginBundleRevoke')
      .mockImplementation(() => {});
    const removeItem = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('storage unavailable');
      });
    try {
      render(<AppsView tab="library" />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Turn off extensions' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Turn off and reload' }),
      );
      expect(reload).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "Couldn't turn extensions off. They are still allowed.",
        ),
      ).toBeTruthy();
    } finally {
      removeItem.mockRestore();
      reload.mockRestore();
    }
  });

  test.each(['registry-unavailable', 'bundle-load-failure'] as const)(
    'Library says when apps could not load (%s) and retries',
    (failure) => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames:
          failure === 'bundle-load-failure' ? ['broken-extension'] : [],
        failure,
      };
      render(<AppsView tab="library" />);
      expect(
        screen.getByText(
          failure === 'bundle-load-failure'
            ? "Couldn't load: broken-extension"
            : "Couldn't load this Station's apps",
        ),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(pluginRegistryReload).toHaveBeenCalledTimes(1);
      setStatus({ state: 'ready', failedPluginNames: [], failure: undefined });
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    },
  );
});
