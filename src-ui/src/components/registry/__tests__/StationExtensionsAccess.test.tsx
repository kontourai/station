/** @vitest-environment jsdom */
import {
  ConnectionStore,
  ConnectionsProvider,
  useConnections,
} from '@kontourai/station-connect';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as consent from '../../../core/remotePluginBundleConsent';
import {
  remotePluginBundlesAllowed,
  remotePluginBundlesAllowedKey,
  setRemotePluginBundlesAllowed,
} from '../../../core/remotePluginBundleConsent';
import { StationExtensionsAccess } from '../StationExtensionsAccess';

const platform = vi.hoisted(() => ({ isTauri: true }));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platform,
}));

const loadStatus = {
  state: 'degraded',
  failure: 'remote-isolation',
  failedPluginNames: [],
};
vi.mock('../../../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: () => () => {},
    getLoadStatus: () => loadStatus,
  },
}));

function mount() {
  const saved = new Map<string, string>();
  const storage = {
    get: (key: string) => saved.get(key) ?? null,
    set: (key: string, value: string) => {
      saved.set(key, value);
    },
    remove: (key: string) => {
      saved.delete(key);
    },
  };
  const store = new ConnectionStore({ storage, credentialStorage: storage });
  const a = store.add('Studio', 'https://studio.example.test');
  const b = store.add('Office', 'https://office.example.test');
  store.setActive(a.id);
  function Switch() {
    const { setActiveConnection } = useConnections();
    return (
      <button type="button" onClick={() => void setActiveConnection(b.id)}>
        Switch Station
      </button>
    );
  }
  render(
    <ConnectionsProvider store={store} seedDefault={false}>
      <StationExtensionsAccess />
      <Switch />
    </ConnectionsProvider>,
  );
  return { a, b, store };
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  platform.isTauri = true;
});

describe('Station extension access at the user decision', () => {
  test('Cancel grants nothing; Allow grants the named origin without switching Stations', () => {
    const { a, store } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    expect(
      screen.getByRole('dialog', { name: 'Allow extensions from Studio?' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Station hasn't verified that the frames keep extension code away from the rest of the app/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/native features and saved Station credentials/),
    ).toBeTruthy();
    expect(screen.queryByText(/run inside this app/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(remotePluginBundlesAllowed(a.id, a.url)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow extensions' }));
    expect(remotePluginBundlesAllowed(a.id, a.url)).toBe(true);
    expect(
      remotePluginBundlesAllowed(a.id, 'https://another.example.test'),
    ).toBe(false);
    expect(store.getActive()?.id).toBe(a.id);
  });

  test('an injected native origin reviews app-wide loading rather than claiming a frame boundary', () => {
    render(
      <ConnectionsProvider
        seedDefault={false}
        injectedConnection={{
          id: 'cli',
          name: 'CLI Station',
          url: 'https://owned.example.test',
          source: 'cli-base',
        }}
      >
        <StationExtensionsAccess />
      </ConnectionsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    expect(screen.getByText(/run inside this app/)).toBeTruthy();
    expect(
      screen.getByText(/native features and your paired Station credentials/),
    ).toBeTruthy();
    expect(screen.queryByText(/They run in separate frames/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(
      remotePluginBundlesAllowed('cli', 'https://owned.example.test'),
    ).toBe(false);
  });

  test('a Station switch before a render cannot grant the old or new Station', () => {
    const { a, b } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    const allow = screen.getByRole('button', { name: 'Allow extensions' });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch Station' }));
      fireEvent.click(allow);
    });
    expect(
      screen.getByText(
        'The selected Station changed. Close this review and try again.',
      ),
    ).toBeTruthy();
    expect(remotePluginBundlesAllowed(a.id, a.url)).toBe(false);
    expect(remotePluginBundlesAllowed(b.id, b.url)).toBe(false);
  });

  test('failed persistence stays in the review and never reports success', () => {
    const { a } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === remotePluginBundlesAllowedKey(a.id)) throw new Error('full');
      return original.call(this, key, value);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow extensions' }));
    expect(screen.getByRole('alert').textContent).toContain(
      "Couldn't save this permission",
    );
    expect(
      screen.getByRole('dialog', { name: 'Allow extensions from Studio?' }),
    ).toBeTruthy();
    expect(remotePluginBundlesAllowed(a.id, a.url)).toBe(false);
  });

  test('a browser ignores legacy loading consent instead of promising a false revoke', () => {
    platform.isTauri = false;
    const { a } = mount();
    act(() => {
      setRemotePluginBundlesAllowed(a.id, a.url, true);
    });
    expect(
      screen.queryByRole('button', { name: 'Turn off extensions' }),
    ).toBeNull();
  });

  test('an owned native loopback ignores legacy consent and never offers an inert revoke', () => {
    const origin = 'http://127.0.0.1:3141';
    setRemotePluginBundlesAllowed('owned', origin, true);
    render(
      <ConnectionsProvider
        seedDefault={false}
        injectedConnection={{
          id: 'owned',
          name: 'Local',
          url: origin,
          source: 'managed-loopback',
          ownerId: 'local-owner',
        }}
      >
        <StationExtensionsAccess />
      </ConnectionsProvider>,
    );
    expect(
      screen.queryByRole('button', { name: 'Turn off extensions' }),
    ).toBeNull();
  });

  test('turning off verifies removal before reloading', () => {
    const { a } = mount();
    act(() => {
      setRemotePluginBundlesAllowed(a.id, a.url, true);
    });
    const reload = vi
      .spyOn(consent, 'reloadAfterRemotePluginBundleRevoke')
      .mockImplementation(() => {});
    fireEvent.click(
      screen.getByRole('button', { name: 'Turn off extensions' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Turn off and reload' }),
    );
    expect(remotePluginBundlesAllowed(a.id, a.url)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
