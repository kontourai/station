// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import type { SavedStationRemoval, StorageAdapter } from '../core/types';
import {
  ConnectionsProvider,
  useConnections,
} from '../react/ConnectionsContext';

function memoryAdapter(): StorageAdapter {
  const s: Record<string, string> = {};
  return {
    get: (k) => s[k] ?? null,
    set: (k, v) => {
      s[k] = v;
    },
    remove: (k) => {
      delete s[k];
    },
  };
}

/** A store holding one browser-saved Station and one shared CLI profile. */
function storeWithSharedProfile() {
  const storage = memoryAdapter();
  const store = new ConnectionStore({ storage });
  store.setActive(store.add('Desk', 'https://desk.example.test').id);
  const shared = store.add('Box', 'https://box.example.test');
  const key = 'station-connect-connections';
  storage.set(
    key,
    (storage.get(key) ?? '').replaceAll(shared.id, 'station-profile:Box'),
  );
  store.reload();
  return store;
}

function mount(
  store: ConnectionStore,
  removeSharedProfile?: (input: SavedStationRemoval) => Promise<void>,
  canRemoveSharedProfile?: (connectionId: string) => boolean,
) {
  const captured: { value?: ReturnType<typeof useConnections> } = {};
  function Probe() {
    captured.value = useConnections();
    return null;
  }
  render(
    <ConnectionsProvider
      store={store}
      defaultUrl="https://desk.example.test"
      {...(removeSharedProfile ? { removeSharedProfile } : {})}
      {...(canRemoveSharedProfile ? { canRemoveSharedProfile } : {})}
    >
      <Probe />
    </ConnectionsProvider>,
  );
  if (!captured.value) throw new Error('provider did not render');
  return captured.value;
}

describe('forgetConnection', () => {
  it('forgets a browser-saved Station from the store', async () => {
    const store = storeWithSharedProfile();
    const desk = store.getAll().find((c) => c.name === 'Desk');
    await mount(store).forgetConnection(desk!.id);
    expect(store.getAll().map((c) => c.name)).toEqual(['Box']);
  });

  it('forgets a shared profile through the host, bound to what was listed', async () => {
    const store = storeWithSharedProfile();
    const removeSharedProfile = vi.fn(async () => {});
    await mount(store, removeSharedProfile).forgetConnection(
      'station-profile:Box',
    );
    expect(removeSharedProfile).toHaveBeenCalledExactlyOnceWith({
      connectionId: 'station-profile:Box',
      expected: { name: 'Box', url: 'https://box.example.test' },
    });
  });

  it('rejects a shared profile no host can forget, and keeps it', async () => {
    const store = storeWithSharedProfile();
    await expect(
      mount(store).forgetConnection('station-profile:Box'),
    ).rejects.toThrow('Forget this Station in the CLI.');
    expect(store.getAll().map((c) => c.id)).toContain('station-profile:Box');
  });

  it('says where forgetting can succeed', () => {
    const store = storeWithSharedProfile();
    const desk = store.getAll().find((c) => c.name === 'Desk')!;
    const withoutHost = mount(store);
    expect(withoutHost.canForgetConnection(desk.id)).toBe(true);
    expect(withoutHost.canForgetConnection('station-profile:Box')).toBe(false);
    expect(withoutHost.canForgetConnection('missing')).toBe(false);
    const withHost = mount(
      store,
      vi.fn(async () => {}),
    );
    expect(withHost.canForgetConnection('station-profile:Box')).toBe(true);
    // The host can still refuse one it owns, such as the app's own Station.
    const refusing = mount(
      store,
      vi.fn(async () => {}),
      (id) => id !== 'station-profile:Box',
    );
    expect(refusing.canForgetConnection('station-profile:Box')).toBe(false);
  });
});
