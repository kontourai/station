import { describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../core/ConnectionStore';
import {
  type CredentialVaultBackend,
  HydratedCredentialStorage,
} from '../core/storage';
import type { StorageAdapter } from '../core/types';

/**
 * The web build keeps pairing credentials in `sessionStorage` on purpose: a
 * bearer credential in `localStorage` is readable by any injected script. In a
 * native shell there is no separate browsing session, so that choice only
 * discarded the credential on every launch — the Station still had the device
 * paired, the device had nothing to authenticate with, and the user re-paired
 * each time they opened the app.
 *
 * `StorageAdapter` is synchronous and every native bridge is not, hence the
 * hydrate-then-serve-from-memory shape being tested here.
 */

function memoryBackend(seed: Record<string, string> = {}) {
  const disk = { ...seed };
  return {
    disk,
    backend: {
      load: async () => ({ ...disk }),
      save: async (entries: Record<string, string>) => {
        for (const key of Object.keys(disk)) delete disk[key];
        Object.assign(disk, entries);
      },
    } satisfies CredentialVaultBackend,
  };
}

function memoryAdapter(): StorageAdapter {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

describe('HydratedCredentialStorage', () => {
  it('serves a hydrated value synchronously', async () => {
    const { backend } = memoryBackend({ 'device:1': 'secret' });
    const vault = new HydratedCredentialStorage(backend);
    await vault.hydrate();
    expect(vault.get('device:1')).toBe('secret');
  });

  it('persists a write through to the backend', async () => {
    const { disk, backend } = memoryBackend();
    const vault = new HydratedCredentialStorage(backend);
    await vault.hydrate();

    vault.set('device:1', 'secret');
    await vi.waitFor(() => expect(disk['device:1']).toBe('secret'));
  });

  it('reads back a written credential in a fresh instance — the restart case', async () => {
    const { disk, backend } = memoryBackend();
    const first = new HydratedCredentialStorage(backend);
    await first.hydrate();
    first.set('device:1', 'secret');
    await vi.waitFor(() => expect(disk['device:1']).toBe('secret'));

    // A new app launch: same backend, new in-memory vault.
    const second = new HydratedCredentialStorage(backend);
    await second.hydrate();
    expect(second.get('device:1')).toBe('secret');
  });

  it('reports not-hydrated before hydrate resolves', () => {
    const { backend } = memoryBackend({ 'device:1': 'secret' });
    const vault = new HydratedCredentialStorage(backend);
    // A read here would look like "no credential" and send the user back
    // through pairing, which is why bootstrap must await hydration.
    expect(vault.isHydrated).toBe(false);
    expect(vault.get('device:1')).toBeNull();
  });

  it('keeps its last known-good credentials and rejects a transient reload failure', async () => {
    let available = true;
    const vault = new HydratedCredentialStorage({
      load: async () => {
        if (!available) throw new Error('vault unreadable');
        return { 'device:1': 'secret' };
      },
      save: async () => {},
    });
    await vault.hydrate();

    available = false;
    await expect(vault.hydrate()).rejects.toThrow('vault unreadable');
    expect(vault.isHydrated).toBe(true);
    expect(vault.get('device:1')).toBe('secret');
  });

  it('remains unhydrated when its first vault read fails', async () => {
    const vault = new HydratedCredentialStorage({
      load: async () => {
        throw new Error('vault unreadable');
      },
      save: async () => {},
    });
    await expect(vault.hydrate()).rejects.toThrow('vault unreadable');
    expect(vault.isHydrated).toBe(false);
    expect(vault.get('device:1')).toBeNull();
  });

  it('keeps the credential usable when the write fails', async () => {
    const vault = new HydratedCredentialStorage({
      load: async () => ({}),
      save: async () => {
        throw new Error('disk full');
      },
    });
    await vault.hydrate();
    vault.set('device:1', 'secret');
    // The flush is fired and not awaited, so assert after it has had a chance
    // to reject — checking synchronously would pass against an implementation
    // that clears the entry in its catch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Dropping it here would turn a failed disk write into an immediate
    // re-pair, which is the very failure this replaces.
    expect(vault.get('device:1')).toBe('secret');
  });

  it('removes a credential from the backend too', async () => {
    const { disk, backend } = memoryBackend({ 'device:1': 'secret' });
    const vault = new HydratedCredentialStorage(backend);
    await vault.hydrate();
    vault.remove('device:1');
    await vi.waitFor(() => expect(disk['device:1']).toBeUndefined());
  });
});

describe('ConnectionStore with a persistent vault', () => {
  it('still has the credential after a restart', async () => {
    const { disk, backend } = memoryBackend();
    const vault = new HydratedCredentialStorage(backend);
    await vault.hydrate();

    const storage = memoryAdapter();
    const store = new ConnectionStore({
      storage,
      credentialStorage: vault,
    });
    const connection = store.add('Station', 'https://station.example.test');
    store.setCredential(connection.id, 'device-secret');
    expect(store.getCredential(connection.id)).toBe('device-secret');

    // Wait for the real write-through, not for a tautology. The store keeps
    // every credential in one JSON map under a single key, so the secret is
    // inside that value rather than being one.
    await vi.waitFor(() =>
      expect(Object.values(disk).join()).toContain('device-secret'),
    );

    // Relaunch: connections persist in their own storage, credentials come
    // back from the vault. Previously only the former survived, so the
    // connection claimed `credentialState: 'saved'` with nothing behind it.
    const revived = new HydratedCredentialStorage(backend);
    await revived.hydrate();
    const reopened = new ConnectionStore({
      storage,
      credentialStorage: revived,
    });
    const same = reopened.getAll().find((item) => item.id === connection.id);
    expect(same?.credentialState).toBe('saved');
    expect(reopened.getCredential(connection.id)).toBe('device-secret');
  });
});
