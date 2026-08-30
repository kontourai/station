import {
  ConnectionStore,
  type StorageAdapter,
} from '@kontourai/station-connect';
import type {
  StationProfile,
  StationProfileStore,
} from '@kontourai/station-contracts';
import { describe, expect, it } from 'vitest';
import {
  NativeStationProfileStorage,
  savedConnectionFromStationProfile,
} from '../stationProfileStorage';

const hostRef = (id: string) => ({
  kind: 'station-bearer' as const,
  id,
});
const CLIENT_INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function memoryStorage(initial: Record<string, string> = {}): StorageAdapter {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    remove: (key) => values.delete(key),
  };
}

const PROFILE_STORE = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: 'kontour',
  projectProfiles: {},
  profiles: [
    {
      schemaVersion: 1,
      name: 'kontour',
      endpoint: 'http://127.0.0.1:3141',
      credentialRef: { kind: 'station-bearer', id: 'kontour-token' },
      environmentId: 'environment-kontour',
      setupSource: 'local',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 2,
    },
    {
      schemaVersion: 1,
      name: 'station.kontourai.io',
      endpoint: 'https://station.kontourai.io',
      credentialRef: { kind: 'station-bearer', id: 'hosted-token' },
      setupSource: 'hosted',
      configurationState: 'requires-auth',
      createdAt: 1,
      updatedAt: 2,
    },
  ],
} as const;

function storageWithProfileStore(
  profileStore: unknown = PROFILE_STORE,
  clientSelectionStorage: StorageAdapter = memoryStorage(),
) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const bridge = {
    async invoke<T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> {
      calls.push([command, args]);
      return (
        command === 'station_profile_store_read'
          ? JSON.stringify(profileStore)
          : command === 'station_profile_authorize_active'
            ? {
                bindingId: '11111111-1111-4111-8111-111111111111',
                exactOrigin: (
                  profileStore as StationProfileStore
                ).profiles.find((profile) => profile.name === args?.profileName)
                  ?.endpoint,
              }
            : undefined
      ) as T;
    },
  };
  return {
    calls,
    storage: new NativeStationProfileStorage(bridge, clientSelectionStorage),
  };
}

function storageWithKeyring(
  options: {
    initialStore?: StationProfileStore;
    clientSelectionStorage?: StorageAdapter;
    failProfileWrite?: boolean;
    failOldReferenceDelete?: boolean;
    conflictOnceBeforeWrite?: (
      store: StationProfileStore,
    ) => StationProfileStore;
    conflictOnceBeforeConfiguredWrite?: (
      store: StationProfileStore,
    ) => StationProfileStore;
  } = {},
) {
  let store = structuredClone(
    options.initialStore ?? PROFILE_STORE,
  ) as unknown as StationProfileStore;
  let injectedConflict = false;
  let injectedConfiguredConflict = false;
  const credentials = new Map<string, string>([
    ['station-bearer:kontour-token', 'old-token'],
  ]);
  const calls: string[] = [];
  const bridge = {
    async invoke<T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> {
      calls.push(command);
      if (command === 'station_profile_store_read') return store as T;
      if (command === 'station_profile_authorize_active') {
        return {
          bindingId: '11111111-1111-4111-8111-111111111111',
          exactOrigin: store.profiles.find(
            (profile) => profile.name === args?.profileName,
          )?.endpoint,
        } as T;
      }
      if (command === 'credential_vault_commit_pairing') {
        const handle = args?.handle as string;
        const referenceId =
          handle === 'handle-rotated'
            ? 'rotated-token-ref'
            : `host-ref-${handle.replace(/^handle-/, '')}`;
        const active = store.profiles.find(
          (profile) => profile.credentialRef?.id === referenceId,
        );
        const reference = active?.credentialRef;
        if (!reference) throw new Error('active Station has no credential');
        credentials.set(
          `${reference.kind}:${reference.id}`,
          `host-owned:${handle}`,
        );
        return undefined as T;
      }
      if (command === 'credential_vault_delete_unreferenced') {
        const reference = args?.reference as { kind: string; id: string };
        if (
          options.failOldReferenceDelete &&
          reference.id === 'kontour-token'
        ) {
          throw new Error('keyring delete denied');
        }
        credentials.delete(`${reference.kind}:${reference.id}`);
        return undefined as T;
      }
      if (command === 'station_profile_store_write') {
        if (options.failProfileWrite) throw new Error('disk full');
        if (!injectedConflict && options.conflictOnceBeforeWrite) {
          injectedConflict = true;
          store = options.conflictOnceBeforeWrite(store);
          throw new Error('saved Station revision conflict');
        }
        if (args?.expectedRevision !== store.revision) {
          throw new Error('saved Station revision conflict');
        }
        const next = JSON.parse(args?.contents as string);
        if (
          !injectedConfiguredConflict &&
          options.conflictOnceBeforeConfiguredWrite &&
          next.profiles.some(
            (profile: StationProfile) =>
              profile.configurationState === 'configured',
          ) &&
          store.profiles.some(
            (profile) => profile.configurationState === 'requires-auth',
          )
        ) {
          injectedConfiguredConflict = true;
          store = options.conflictOnceBeforeConfiguredWrite(store);
          throw new Error('saved Station revision conflict');
        }
        if (next.revision !== store.revision + 1) {
          throw new Error('invalid next revision');
        }
        store = next;
        return undefined as T;
      }
      return undefined as T;
    },
  };
  return {
    calls,
    credentials,
    currentStore: () => store,
    replaceStore: (next: StationProfileStore) => {
      store = next;
    },
    storage: new NativeStationProfileStorage(
      bridge,
      options.clientSelectionStorage ?? memoryStorage(),
    ),
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

describe('NativeStationProfileStorage', () => {
  describe('pendingLocalSelfProvisionProfileName (station#1715)', () => {
    it('returns undefined for a default Station with no localService, even with a working credential', async () => {
      // PROFILE_STORE's "kontour" carries a credentialRef AND
      // configurationState "configured" but no `localService` at all — not
      // a local-service install, so there is nothing for
      // `station_local_self_provision` to do regardless of credential state.
      const { storage } = storageWithProfileStore();
      await storage.hydrate();

      expect(storage.pendingLocalSelfProvisionProfileName()).toBeUndefined();
    });

    /**
     * archive#1818 — THE regression this test
     * exists to catch. Before this fix, a profile carrying BOTH
     * `credentialRef` AND `configurationState: 'configured'` short-circuited
     * here to `undefined`, on the theory those two RECORDED fields mean
     * "already durably provisioned". That is exactly the shape a Station is
     * left in after a nightly bundle swap re-signs the app and the macOS
     * keychain ACL bound to the previous signature refuses every read of
     * the credential — the fields never change, so the old short-circuit
     * silently prevented `station_local_self_provision` (and therefore
     * `read_credential_for_eligibility`'s keychain read-back,
     * `src-desktop/src/lib.rs`) from EVER running again for a stranded
     * profile. This process cannot read the OS keychain itself to tell a
     * merely-recorded credential from a genuinely usable one, so it must
     * not pre-empt that decision — it now returns the name unconditionally
     * whenever the Station is a local-service install, and leaves
     * usability entirely to the Rust command.
     */
    it('returns the default Station name even when credentialRef and configured are already set (station#1818)', async () => {
      const strandedLikeHealthy = structuredClone(
        PROFILE_STORE,
      ) as unknown as StationProfileStore;
      strandedLikeHealthy.profiles[0] = {
        ...strandedLikeHealthy.profiles[0],
        // Exactly the shape a stranded post-bundle-swap Station is left in:
        // both fields present and "healthy"-looking, credential unreadable.
        credentialRef: { kind: 'station-bearer', id: 'kontour-token' },
        configurationState: 'configured',
        localService: {
          instanceId: 'inst',
          baseDir: '/home/station',
          serverPort: 3141,
          uiPort: 3000,
        },
      };
      const { storage } = storageWithProfileStore(strandedLikeHealthy);
      await storage.hydrate();

      expect(storage.pendingLocalSelfProvisionProfileName()).toBe('kontour');
    });

    // archive#1715 LIVE-BOOT REGRESSION (the bug this test would have
    // caught): `station setup local`
    // (packages/cli/src/commands/setup-command.ts) writes a fresh local
    // profile with configurationState "configured" and NO credentialRef at
    // all — the CLI itself never needed one. The original implementation
    // treated "configured" alone as "already done" and returned undefined
    // here, so the boot-time effect never fired on any real installation.
    // Every earlier version of this fixture used configurationState
    // "unconfigured" for the positive case, a shape `station setup local`
    // never actually produces — which is exactly how 69 green
    // OnboardingGate tests (and this file) missed a real-machine no-op.
    it('returns the default Station name for a real fresh local install (configured, no credentialRef)', async () => {
      const pending = structuredClone(
        PROFILE_STORE,
      ) as unknown as StationProfileStore;
      pending.profiles[0] = {
        ...pending.profiles[0],
        credentialRef: undefined,
        environmentId: undefined,
        // The REAL state a fresh `station setup local` install is in.
        configurationState: 'configured',
        localService: {
          instanceId: 'inst',
          baseDir: '/home/station',
          serverPort: 3141,
          uiPort: 3000,
        },
      };
      const { storage } = storageWithProfileStore(pending);
      await storage.hydrate();

      expect(storage.pendingLocalSelfProvisionProfileName()).toBe('kontour');
    });

    it('returns the default Station name for an interrupted attempt stranded at requires-auth', async () => {
      const stranded = structuredClone(
        PROFILE_STORE,
      ) as unknown as StationProfileStore;
      stranded.profiles[0] = {
        ...stranded.profiles[0],
        // A credentialRef exists (a previous attempt got partway through)
        // but the profile never reached "configured" — never trusted on
        // its own, so this must still be eligible for a retry rather than
        // silently stuck forever.
        configurationState: 'requires-auth',
        localService: {
          instanceId: 'inst',
          baseDir: '/home/station',
          serverPort: 3141,
          uiPort: 3000,
        },
      };
      const { storage } = storageWithProfileStore(stranded);
      await storage.hydrate();

      expect(storage.pendingLocalSelfProvisionProfileName()).toBe('kontour');
    });

    it('returns undefined for a stranded requires-auth local Station that is not the default', async () => {
      const notDefault = structuredClone(
        PROFILE_STORE,
      ) as unknown as StationProfileStore;
      notDefault.defaultProfile = 'station.kontourai.io';
      notDefault.profiles[0] = {
        ...notDefault.profiles[0],
        credentialRef: undefined,
        configurationState: 'unconfigured',
        localService: {
          instanceId: 'inst',
          baseDir: '/home/station',
          serverPort: 3141,
          uiPort: 3000,
        },
      };
      const { storage } = storageWithProfileStore(notDefault);
      await storage.hydrate();

      // The default Station ("station.kontourai.io") has no localService at
      // all, so this is undefined even though ANOTHER profile qualifies —
      // this command only ever targets the default Station.
      expect(storage.pendingLocalSelfProvisionProfileName()).toBeUndefined();
    });

    it('returns undefined for a remote Station with no local service', async () => {
      const remoteDefault = structuredClone(
        PROFILE_STORE,
      ) as unknown as StationProfileStore;
      remoteDefault.defaultProfile = 'station.kontourai.io';
      const { storage } = storageWithProfileStore(remoteDefault);
      await storage.hydrate();

      expect(storage.pendingLocalSelfProvisionProfileName()).toBeUndefined();
    });

    it('does not target a paired profile merely because it shares a local-service shape', async () => {
      const paired = structuredClone(
        PROFILE_STORE,
      ) as unknown as StationProfileStore;
      paired.profiles[0] = {
        ...paired.profiles[0],
        setupSource: 'paired',
        localService: {
          instanceId: 'foreign-service',
          baseDir: '/another/station',
          serverPort: 3141,
          uiPort: 3000,
        },
      };
      const { storage } = storageWithProfileStore(paired);
      await storage.hydrate();

      expect(storage.pendingLocalSelfProvisionProfileName()).toBeUndefined();
    });
  });

  it('exposes only the selected Station credential to the webview vault', async () => {
    const { storage } = storageWithProfileStore();
    await storage.hydrate();

    expect(storage.credentialEntries()).toEqual([
      {
        key: 'environment:kontour-token',
        profileName: 'kontour',
        reference: { kind: 'station-bearer', id: 'kontour-token' },
      },
    ]);
  });

  it('authorizes a transient selected Station without mutating the CLI default', async () => {
    const { calls, storage } = storageWithProfileStore();
    await storage.hydrate();

    await expect(
      storage.authorizeActiveConnection('station-profile:station.kontourai.io'),
    ).resolves.toBe(true);

    expect(calls).toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'station.kontourai.io' },
    ]);
    expect(calls.map(([command]) => command)).not.toContain(
      'station_profile_store_write',
    );
    expect(storage.credentialEntries()).toEqual([
      {
        key: 'connection:hosted-token',
        profileName: 'station.kontourai.io',
        reference: { kind: 'station-bearer', id: 'hosted-token' },
      },
    ]);
  });

  it('preserves a process-local selection across shared metadata refreshes', async () => {
    const { currentStore, replaceStore, storage } = storageWithKeyring();
    await storage.hydrate();
    expect(storage.selectProfileForProcess('station.kontourai.io')).toBe(
      'station-profile:station.kontourai.io',
    );

    const changed = structuredClone(currentStore());
    changed.revision += 1;
    changed.profiles[0] = { ...changed.profiles[0], updatedAt: 7 };
    replaceStore(changed);
    await expect(storage.refresh()).resolves.toBe(true);

    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:station.kontourai.io',
    );
    expect(currentStore().defaultProfile).toBe('kontour');
    expect(storage.pendingLocalSelfProvisionProfileName()).toBeUndefined();
  });

  it('targets the process-selected local owner rather than the shared default', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.defaultProfile = 'station.kontourai.io';
    shared.profiles[0] = {
      ...shared.profiles[0],
      localService: {
        instanceId: 'desktop-sidecar-beta',
        baseDir: '/home/station/instances/beta',
        serverPort: 28141,
        uiPort: 28000,
      },
    };
    const { storage } = storageWithProfileStore(shared);
    await storage.hydrate();
    expect(storage.pendingLocalSelfProvisionProfileName()).toBeUndefined();

    expect(storage.selectProfileForProcess('kontour')).toBe(
      'station-profile:kontour',
    );
    expect(storage.pendingLocalSelfProvisionProfileName()).toBe('kontour');
  });

  it('selects each matching bundled channel profile instead of an inherited shared default', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.defaultProfile = 'kontour';
    shared.profiles[0] = {
      ...shared.profiles[0],
      localService: {
        instanceId: 'desktop-sidecar-stable',
        baseDir: '/home/station/instances/stable',
        serverPort: 18141,
        uiPort: 18000,
      },
    };
    for (const [channel, serverPort, uiPort] of [
      ['beta', 28141, 28000],
      ['nightly', 38141, 38000],
    ] as const) {
      shared.profiles.push({
        schemaVersion: 1,
        name: `${channel}-local`,
        endpoint: `http://127.0.0.1:${serverPort}`,
        credentialRef: hostRef(`${channel}-token`),
        environmentId: `environment-${channel}`,
        localService: {
          instanceId: `desktop-sidecar-${channel}`,
          baseDir: `/home/station/instances/${channel}`,
          serverPort,
          uiPort,
        },
        setupSource: 'local',
        configurationState: 'configured',
        createdAt: 1,
        updatedAt: 2,
      });
    }
    const { calls, storage } = storageWithProfileStore(shared);
    await storage.hydrate();

    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:kontour',
    );
    for (const profileName of ['kontour', 'beta-local', 'nightly-local']) {
      expect(storage.selectProfileForProcess(profileName)).toBe(
        `station-profile:${profileName}`,
      );
    }
    expect(storage.selectProfileForProcess('beta-local')).toBe(
      'station-profile:beta-local',
    );
    await expect(
      storage.authorizeActiveConnection('station-profile:beta-local'),
    ).resolves.toBe(true);

    expect(shared.defaultProfile).toBe('kontour');
    expect(calls).toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'beta-local' },
    ]);
    expect(calls).not.toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'kontour' },
    ]);
  });

  it('migrates an inherited legacy local pointer to the packaged channel owner without credential access', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.profiles[0] = {
      ...shared.profiles[0],
      name: 'stable-local',
      localService: {
        instanceId: 'desktop-sidecar-stable',
        baseDir: '/home/station/instances/stable',
        serverPort: 18141,
        uiPort: 18000,
      },
    };
    shared.defaultProfile = 'stable-local';
    shared.profiles.push({
      schemaVersion: 1,
      name: 'beta-local',
      endpoint: 'http://127.0.0.1:28141',
      credentialRef: hostRef('beta-token'),
      environmentId: 'environment-beta',
      localService: {
        instanceId: 'desktop-sidecar-beta',
        baseDir: '/home/station/instances/beta',
        serverPort: 28141,
        uiPort: 28000,
      },
      setupSource: 'local',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 2,
    });
    const selectionStorage = memoryStorage({
      'station-connect-connections-active': 'station-profile:stable-local',
    });
    const { calls, storage } = storageWithProfileStore(
      shared,
      selectionStorage,
    );

    await storage.hydrate();
    expect(storage.selectProfileForProcess('beta-local')).toBe(
      'station-profile:beta-local',
    );
    expect(
      selectionStorage.get('station-connect-connections-active'),
    ).toBeNull();
    expect(
      selectionStorage.get('station-native-profile-selection-v1'),
    ).toBeNull();
    expect(shared.defaultProfile).toBe('stable-local');
    expect(calls.map(([command]) => command)).toEqual([
      'station_profile_store_read',
    ]);
  });

  it('does not promote a legacy shared remote default to explicit client intent', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.defaultProfile = 'station.kontourai.io';
    const selectionStorage = memoryStorage({
      'station-connect-connections-active':
        'station-profile:station.kontourai.io',
    });
    const { calls, storage } = storageWithProfileStore(
      shared,
      selectionStorage,
    );

    await storage.hydrate();
    expect(storage.selectProfileForProcess('kontour')).toBe(
      'station-profile:kontour',
    );
    expect(
      selectionStorage.get('station-native-profile-selection-v1'),
    ).toBeNull();
    expect(calls.map(([command]) => command)).toEqual([
      'station_profile_store_read',
    ]);
  });

  it('migrates a legacy non-default foreign selection without reading its pairing credential', async () => {
    const selectionStorage = memoryStorage({
      'station-connect-connections-active':
        'station-profile:station.kontourai.io',
    });
    const { calls, storage } = storageWithProfileStore(
      PROFILE_STORE,
      selectionStorage,
    );

    await storage.hydrate();
    expect(storage.selectProfileForProcess('kontour')).toBe(
      'station-profile:station.kontourai.io',
    );
    expect(
      JSON.parse(
        selectionStorage.get('station-native-profile-selection-v1') ?? '{}',
      ),
    ).toEqual({
      schemaVersion: 1,
      connectionId: 'station-profile:station.kontourai.io',
    });
    expect(
      selectionStorage.get('station-connect-connections-active'),
    ).toBeNull();
    expect(calls.map(([command]) => command)).toEqual([
      'station_profile_store_read',
    ]);
  });

  it('restores a versioned explicit foreign selection and clears it when the profile disappears', async () => {
    const selectionStorage = memoryStorage({
      'station-native-profile-selection-v1': JSON.stringify({
        schemaVersion: 1,
        connectionId: 'station-profile:station.kontourai.io',
      }),
    });
    const { currentStore, replaceStore, storage } = storageWithKeyring({
      clientSelectionStorage: selectionStorage,
    });

    await storage.hydrate();
    expect(storage.selectProfileForProcess('kontour')).toBe(
      'station-profile:station.kontourai.io',
    );

    const withoutRemote = structuredClone(currentStore());
    withoutRemote.revision += 1;
    withoutRemote.profiles = withoutRemote.profiles.filter(
      (profile) => profile.name !== 'station.kontourai.io',
    );
    replaceStore(withoutRemote);
    await storage.refresh();

    expect(
      selectionStorage.get('station-native-profile-selection-v1'),
    ).toBeNull();
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:kontour',
    );
  });

  it('preserves an explicit process choice over automatic bundled channel selection', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.profiles.push({
      schemaVersion: 1,
      name: 'beta-local',
      endpoint: 'http://127.0.0.1:28141',
      credentialRef: hostRef('beta-token'),
      environmentId: 'environment-beta',
      localService: {
        instanceId: 'desktop-sidecar-beta',
        baseDir: '/home/station/instances/beta',
        serverPort: 28141,
        uiPort: 28000,
      },
      setupSource: 'local',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 2,
    });
    const { calls, storage } = storageWithProfileStore(shared);
    await storage.hydrate();
    await expect(
      storage.authorizeActiveConnection(
        'station-profile:station.kontourai.io',
        true,
      ),
    ).resolves.toBe(true);

    expect(storage.selectProfileForProcess('beta-local')).toBe(
      'station-profile:station.kontourai.io',
    );
    expect(shared.defaultProfile).toBe('kontour');
    expect(calls).toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'station.kontourai.io' },
    ]);
    expect(calls).not.toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'beta-local' },
    ]);
  });

  it('retains an explicit credential-recovery selection without reading another channel keyring entry', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.profiles.push(
      {
        schemaVersion: 1,
        name: 'recovery-needed',
        endpoint: 'https://recovery.example.test',
        setupSource: 'paired',
        configurationState: 'requires-auth',
        createdAt: 1,
        updatedAt: 2,
      },
      {
        schemaVersion: 1,
        name: 'beta-local',
        endpoint: 'http://127.0.0.1:28141',
        credentialRef: hostRef('beta-token'),
        environmentId: 'environment-beta',
        localService: {
          instanceId: 'desktop-sidecar-beta',
          baseDir: '/home/station/instances/beta',
          serverPort: 28141,
          uiPort: 28000,
        },
        setupSource: 'local',
        configurationState: 'configured',
        createdAt: 1,
        updatedAt: 2,
      },
    );
    const { calls, storage } = storageWithProfileStore(shared);
    await storage.hydrate();

    await expect(
      storage.authorizeActiveConnection(
        'station-profile:recovery-needed',
        true,
      ),
    ).resolves.toBe(false);

    expect(storage.selectProfileForProcess('beta-local')).toBe(
      'station-profile:recovery-needed',
    );
    expect(calls.map(([command]) => command)).toEqual([
      'station_profile_store_read',
    ]);
  });

  it('does not mistake a routine ConnectionStore write for explicit selection', async () => {
    const shared = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    shared.profiles.push({
      schemaVersion: 1,
      name: 'beta-local',
      endpoint: 'http://127.0.0.1:28141',
      credentialRef: hostRef('beta-token'),
      environmentId: 'environment-beta',
      localService: {
        instanceId: 'desktop-sidecar-beta',
        baseDir: '/home/station/instances/beta',
        serverPort: 28141,
        uiPort: 28000,
      },
      setupSource: 'local',
      configurationState: 'configured',
      createdAt: 1,
      updatedAt: 2,
    });
    const { calls, storage } = storageWithProfileStore(shared);
    await storage.hydrate();
    const connections = new ConnectionStore({ storage });

    connections.update('station-profile:kontour', { name: 'Stable renamed' });
    expect(storage.selectProfileForProcess('beta-local')).toBe(
      'station-profile:beta-local',
    );
    await storage.authorizeActiveConnection('station-profile:beta-local');

    expect(calls).toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'beta-local' },
    ]);
    expect(calls).not.toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'kontour' },
    ]);
  });

  it('retains an explicit process choice through refresh and drops it when its profile is removed', async () => {
    const { currentStore, replaceStore, storage } = storageWithKeyring();
    await storage.hydrate();
    await expect(
      storage.authorizeActiveConnection(
        'station-profile:station.kontourai.io',
        true,
      ),
    ).resolves.toBe(true);

    const changed = structuredClone(currentStore());
    changed.revision += 1;
    changed.profiles[0] = { ...changed.profiles[0], updatedAt: 3 };
    replaceStore(changed);
    await expect(storage.refresh()).resolves.toBe(true);
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:station.kontourai.io',
    );

    const withoutExplicit = structuredClone(currentStore());
    withoutExplicit.revision += 1;
    withoutExplicit.profiles = withoutExplicit.profiles.filter(
      (profile) => profile.name !== 'station.kontourai.io',
    );
    replaceStore(withoutExplicit);
    await expect(storage.refresh()).resolves.toBe(true);
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:kontour',
    );
  });

  it('retains a native request binding only for its exact authorized connection and base', async () => {
    const { storage } = storageWithProfileStore();
    await storage.hydrate();
    const connectionId = 'station-profile:station.kontourai.io';
    await expect(storage.authorizeActiveConnection(connectionId)).resolves.toBe(
      true,
    );
    expect(
      storage.captureNativeRequestBinding(
        connectionId,
        'https://station.kontourai.io',
      ),
    ).toEqual({
      bindingId: '11111111-1111-4111-8111-111111111111',
      exactOrigin: 'https://station.kontourai.io',
    });
    expect(
      storage.captureNativeRequestBinding(connectionId, 'https://other.test'),
    ).toBeNull();
  });

  it('preserves a retained native request binding through harmless metadata refresh but clears an authority change', async () => {
    const { currentStore, replaceStore, storage } = storageWithKeyring();
    await storage.hydrate();
    const connectionId = 'station-profile:kontour';
    await storage.authorizeActiveConnection(connectionId);
    expect(
      storage.captureNativeRequestBinding(
        connectionId,
        'http://127.0.0.1:3141',
      ),
    ).toBeTruthy();
    const changed = structuredClone(currentStore());
    changed.revision += 1;
    changed.profiles[0] = { ...changed.profiles[0], updatedAt: 3 };
    replaceStore(changed);
    await expect(storage.refresh()).resolves.toBe(true);
    expect(
      storage.captureNativeRequestBinding(
        connectionId,
        'http://127.0.0.1:3141',
      ),
    ).toBeTruthy();

    const authorityChanged = structuredClone(currentStore());
    authorityChanged.revision += 1;
    authorityChanged.profiles[0] = {
      ...authorityChanged.profiles[0],
      environmentId: 'replacement-environment',
    };
    replaceStore(authorityChanged);
    await expect(storage.refresh()).resolves.toBe(true);
    expect(
      storage.captureNativeRequestBinding(
        connectionId,
        'http://127.0.0.1:3141',
      ),
    ).toBeNull();
  });

  it('re-authorizes the hydrated default Station for a new native process', async () => {
    const { calls, storage } = storageWithProfileStore();
    await storage.hydrate();

    await expect(storage.authorizeDefaultProfile()).resolves.toBe(true);

    expect(calls).toContainEqual([
      'station_profile_authorize_active',
      { profileName: 'kontour' },
    ]);
  });

  it('refuses credential-bearing profiles that would send a bearer over remote HTTP', async () => {
    const insecure = structuredClone(
      PROFILE_STORE,
    ) as unknown as StationProfileStore;
    insecure.profiles[1] = {
      ...insecure.profiles[1],
      endpoint: 'http://station.kontourai.io',
    };
    insecure.defaultProfile = 'station.kontourai.io';
    const { storage } = storageWithProfileStore(insecure);

    await expect(storage.hydrate()).rejects.toThrow('non-loopback HTTP');
  });

  it('hydrates SavedConnection rows and the CLI-selected default from shared metadata', async () => {
    const { storage } = storageWithProfileStore();
    await storage.hydrate();

    const connections = JSON.parse(
      storage.get('station-connect-connections') ?? '[]',
    );
    expect(connections).toHaveLength(2);
    expect(connections[0]).toMatchObject({
      id: 'station-profile:kontour',
      name: 'kontour',
      url: 'http://127.0.0.1:3141',
      environmentId: 'environment-kontour',
      credentialRef: { kind: 'environment', id: 'kontour-token' },
    });
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:kontour',
    );
  });

  it('does not turn a temporary connection selection into the shared default', async () => {
    const { calls, storage } = storageWithProfileStore();
    await storage.hydrate();

    storage.set(
      'station-connect-connections-active',
      'station-profile:station.kontourai.io',
    );

    expect(calls).toHaveLength(1);
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:station.kontourai.io',
    );
    expect(storage.credentialEntries()).toEqual([
      {
        key: 'connection:hosted-token',
        profileName: 'station.kontourai.io',
        reference: { kind: 'station-bearer', id: 'hosted-token' },
      },
    ]);
  });

  it('refreshes the connection and default projection after an out-of-band CLI profile change', async () => {
    const { calls, replaceStore, storage } = storageWithKeyring();
    await storage.hydrate();
    const connections = new ConnectionStore({ storage });
    expect(connections.getAll()).toHaveLength(2);
    calls.length = 0;

    replaceStore({
      ...PROFILE_STORE,
      revision: 1,
      defaultProfile: 'station.kontourai.io',
      profiles: [PROFILE_STORE.profiles[1]],
    });

    await expect(storage.refresh()).resolves.toBe(true);
    connections.reload();
    expect(
      JSON.parse(storage.get('station-connect-connections') ?? '[]'),
    ).toEqual([
      expect.objectContaining({ id: 'station-profile:station.kontourai.io' }),
    ]);
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:station.kontourai.io',
    );
    expect(connections.getAll()).toEqual([
      expect.objectContaining({ id: 'station-profile:station.kontourai.io' }),
    ]);
    expect(connections.getActive()).toMatchObject({
      id: 'station-profile:station.kontourai.io',
    });
    // A CLI metadata change must not rehydrate or rewrite keyring entries.
    expect(calls).toEqual(['station_profile_store_read']);
  });

  it('retains the last known-good projection when a later profile read fails', async () => {
    let readCount = 0;
    const storage = new NativeStationProfileStorage({
      async invoke<T>(command: string): Promise<T> {
        if (command !== 'station_profile_store_read') return undefined as T;
        readCount += 1;
        if (readCount === 1) return PROFILE_STORE as T;
        throw new Error('profiles.json unavailable');
      },
    });
    await storage.hydrate();

    await expect(storage.refresh()).rejects.toThrow(
      'profiles.json unavailable',
    );
    expect(storage.get('station-connect-connections-active')).toBe(
      'station-profile:kontour',
    );
    expect(
      JSON.parse(storage.get('station-connect-connections') ?? '[]'),
    ).toHaveLength(2);
  });

  it('writes the shared default only through the explicit action', async () => {
    const { calls, storage } = storageWithProfileStore();
    await storage.hydrate();

    await storage.makeDefault('station-profile:station.kontourai.io');

    expect(calls.at(-1)).toEqual([
      'station_profile_store_write',
      {
        contents: expect.stringContaining(
          '"defaultProfile": "station.kontourai.io"',
        ),
        expectedRevision: 0,
      },
    ]);
  });

  it('refuses corrupt metadata rather than substituting browser-local Stations', async () => {
    const { storage } = storageWithProfileStore({ nope: true });
    await expect(storage.hydrate()).rejects.toThrow('corrupt, unsupported');
  });

  it('rejects non-loopback HTTP before writing a pairing credential', async () => {
    const { calls, storage } = storageWithKeyring();
    await storage.hydrate();

    await expect(
      storage.commitVerifiedPairing({
        connectionId: 'temporary-desktop-connection',
        name: 'unsafe-http',
        endpoint: 'http://station.example.test',
        credential: 'never-write',
        clientInstanceId: CLIENT_INSTANCE_ID,
        handshake: {
          environmentId: 'environment-unsafe',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        },
      }),
    ).rejects.toThrow('HTTPS or strict loopback HTTP');
    expect(calls).not.toContain('credential_vault_commit_pairing');
  });

  it('keeps credential material out of the connection projection', () => {
    const connection = savedConnectionFromStationProfile(
      PROFILE_STORE.profiles[0],
    );
    expect(JSON.stringify(connection)).not.toContain('credential-value');
    expect(connection.credentialRef).toEqual({
      credentialVersion: 1,
      kind: 'environment',
      id: 'kontour-token',
    });
    expect(connection.hostOwnedCredential).toBe(true);
  });

  it('projects a channel-owned local service identity without tagging same-origin paired profiles', () => {
    const local = {
      ...PROFILE_STORE.profiles[0],
      localService: {
        instanceId: 'desktop-sidecar-nightly',
        baseDir: '/Users/test/.station-nightly',
        serverPort: 38141,
        uiPort: 38000,
      },
    } satisfies StationProfile;
    const paired = {
      ...local,
      name: 'paired-at-loopback',
      setupSource: 'paired' as const,
    } satisfies StationProfile;

    expect(savedConnectionFromStationProfile(local)).toMatchObject({
      ownerId: 'desktop-sidecar-nightly',
    });
    expect(savedConnectionFromStationProfile(paired).ownerId).toBeUndefined();
  });

  it('dedupes a matching mobile default on cold boot and restores the host-owned profile after authenticated recovery', async () => {
    const profileStore = JSON.parse(
      JSON.stringify(PROFILE_STORE),
    ) as StationProfileStore;
    profileStore.profiles[0].endpoint = 'https://station.example.test:8444';
    const { storage } = storageWithProfileStore(profileStore);
    await storage.hydrate();

    const connections = new ConnectionStore({ storage });
    const paired = connections.getActive();
    expect(paired).toMatchObject({
      id: 'station-profile:kontour',
      credentialState: 'saved',
      hostOwnedCredential: true,
    });

    connections.setInjectedConnection({
      id: 'mobile-default-nightly',
      name: 'Station Nightly',
      url: 'https://Station.Example.test:8444/',
      source: 'mobile-default',
    });
    // The injected URL is only a cold-boot routing hint. The paired native
    // profile owns the credential and is the one row/active subject.
    expect(connections.getAll()).toHaveLength(2);
    expect(connections.getAll()[0].id).toBe('station-profile:kontour');
    expect(connections.getActive()?.id).toBe('station-profile:kontour');

    connections.recordEndpointFailure(paired!.id, 'unreachable');
    connections.markCredentialRequired(
      paired!.id,
      undefined,
      connections.credentialGeneration(paired!.id),
    );
    connections.recordAuthenticatedSuccess(
      paired!.id,
      'https://station.example.test:8444/api/system/status',
      connections.credentialGeneration(paired!.id),
    );
    expect(connections.getActive()).toMatchObject({
      id: paired!.id,
      credentialState: 'saved',
    });
    expect(connections.getActive()?.lastError).toBeUndefined();
  });

  it('uses the matching paired profile when no default is selected and an unrelated profile is first', async () => {
    const profileStore = JSON.parse(
      JSON.stringify(PROFILE_STORE),
    ) as StationProfileStore;
    profileStore.defaultProfile = null;
    profileStore.profiles = [
      profileStore.profiles[1],
      {
        ...profileStore.profiles[0],
        endpoint: 'https://station.example.test:8444',
      },
    ];
    const { storage } = storageWithProfileStore(profileStore);
    await storage.hydrate();

    const connections = new ConnectionStore({ storage });
    connections.setInjectedConnection({
      id: 'mobile-default-nightly',
      name: 'Station Nightly',
      url: 'https://Station.Example.test:8444/',
      source: 'mobile-default',
    });

    expect(connections.getAll().map((connection) => connection.id)).toEqual([
      'station-profile:station.kontourai.io',
      'station-profile:kontour',
    ]);
    expect(connections.getActive()?.id).toBe('station-profile:kontour');
  });

  it('persists a profile only from a verified pairing identity', async () => {
    const { currentStore, storage } = storageWithKeyring();
    await storage.hydrate();

    const connectionId = await storage.commitVerifiedPairing({
      connectionId: 'station-profile:kontour',
      name: 'kontour',
      endpoint: 'http://127.0.0.1:3141',
      credentialHandle: 'handle-refreshed',
      nextCredentialRef: hostRef('host-ref-refreshed'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-confirmed',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });

    expect(currentStore().profiles[0]).toMatchObject({
      environmentId: 'environment-confirmed',
      setupSource: 'paired',
      configurationState: 'configured',
      credentialRef: {
        kind: 'station-bearer',
        id: 'host-ref-refreshed',
      },
    });
    expect(connectionId).toBe('station-profile:kontour');
  });

  it('keeps the shared default unchanged when pairing a different Station', async () => {
    const { currentStore, storage } = storageWithKeyring();
    await storage.hydrate();

    await storage.commitVerifiedPairing({
      connectionId: 'temporary-desktop-connection',
      name: 'Other Station',
      endpoint: 'https://other.example',
      credentialHandle: 'handle-other',
      nextCredentialRef: hostRef('host-ref-other'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-other',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });

    expect(currentStore().defaultProfile).toBe('kontour');
  });

  it('atomically selects the first paired Station and retains the exact client instance for cold authorization', async () => {
    const empty: StationProfileStore = {
      schemaVersion: 1,
      revision: 0,
      defaultProfile: null,
      profiles: [],
      projectProfiles: {},
    };
    const { calls, currentStore, storage } = storageWithKeyring({
      initialStore: empty,
      conflictOnceBeforeConfiguredWrite: (store) => ({
        ...store,
        revision: store.revision + 1,
        projectProfiles: { mobile: store.profiles[0].name },
      }),
    });
    await storage.hydrate();

    await storage.commitVerifiedPairing({
      connectionId: 'mobile-build-default-stable',
      name: 'Station stable',
      endpoint: 'https://station.example.test:8441',
      credentialHandle: 'handle-first-mobile',
      nextCredentialRef: hostRef('host-ref-first-mobile'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-stable',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });

    expect(currentStore()).toMatchObject({
      revision: 3,
      defaultProfile: 'station-stable',
      projectProfiles: { mobile: 'station-stable' },
      profiles: [
        {
          name: 'station-stable',
          configurationState: 'configured',
          clientInstanceId: CLIENT_INSTANCE_ID,
        },
      ],
    });
    await storage.hydrate();
    expect(await storage.authorizeDefaultProfile()).toBe(true);
    expect(calls.slice(-2)).toEqual([
      'station_profile_store_read',
      'station_profile_authorize_active',
    ]);
  });

  it('creates a collision-safe saved Station and first keyring reference from verified identity', async () => {
    const { credentials, currentStore, storage } = storageWithKeyring();
    await storage.hydrate();

    const connectionId = await storage.commitVerifiedPairing({
      connectionId: 'temporary-desktop-connection',
      name: 'Kontour',
      endpoint: 'https://desktop-kontour.example',
      credentialHandle: 'handle-hosted',
      nextCredentialRef: hostRef('host-ref-hosted'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-hosted',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });

    expect(currentStore().profiles.at(-1)).toMatchObject({
      name: 'kontour-2',
      endpoint: 'https://desktop-kontour.example',
      credentialRef: {
        kind: 'station-bearer',
        id: 'host-ref-hosted',
      },
      environmentId: 'environment-hosted',
    });
    expect(
      [...credentials.entries()].some(
        ([key, value]) =>
          key === 'station-bearer:host-ref-hosted' &&
          value === 'host-owned:handle-hosted',
      ),
    ).toBe(true);
    expect(connectionId).toBe('station-profile:kontour-2');
  });

  it('switches a second paired runtime to its persisted profile before identity, credential, and active updates', async () => {
    const { storage } = storageWithKeyring();
    await storage.hydrate();
    const store = new ConnectionStore({
      storage,
      credentialStorage: memoryAdapter(),
    });

    const firstTemporary = store.add(
      'Temporary first pairing',
      'https://desktop-one.example',
    );
    const firstId = await storage.commitVerifiedPairing({
      connectionId: firstTemporary.id,
      name: 'Desktop',
      endpoint: 'https://desktop-one.example',
      credentialHandle: 'handle-first',
      nextCredentialRef: hostRef('host-ref-first'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-desktop-one',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });
    expect(firstId).toBe('station-profile:desktop');
    expect(
      store.reconcileHandshake(firstId, {
        environmentId: 'environment-desktop-one',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      }),
    ).toMatchObject({
      id: firstId,
      credentialRef: { id: 'host-ref-first' },
    });
    store.setCredential(firstId, 'first-pairing-token');

    const secondTemporary = store.add(
      'Temporary second pairing',
      'https://desktop-two.example',
    );
    const secondId = await storage.commitVerifiedPairing({
      connectionId: secondTemporary.id,
      name: 'Desktop',
      endpoint: 'https://desktop-two.example',
      credentialHandle: 'handle-second',
      nextCredentialRef: hostRef('host-ref-second'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-desktop-two',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });
    expect(secondId).toBe('station-profile:desktop-2');
    expect(
      store.reconcileHandshake(secondId, {
        environmentId: 'environment-desktop-two',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      }),
    ).toMatchObject({ id: secondId });
    store.setCredential(secondId, 'second-pairing-token');
    store.setActive(secondId);

    expect(store.getActive()?.id).toBe(secondId);
    expect(store.getCredential(firstId)).toBe('first-pairing-token');
    expect(store.getCredential(secondId)).toBe('second-pairing-token');
    expect(store.getAll().map((connection) => connection.id)).toContain(
      secondId,
    );
    expect(store.getAll().map((connection) => connection.id)).not.toContain(
      secondTemporary.id,
    );
  });

  it('does not write a new keyring value when pending metadata cannot persist', async () => {
    const { credentials, storage } = storageWithKeyring({
      failProfileWrite: true,
    });
    await storage.hydrate();

    await expect(
      storage.commitVerifiedPairing({
        connectionId: 'station-profile:kontour',
        name: 'kontour',
        endpoint: 'http://127.0.0.1:3141',
        credentialHandle: 'handle-rotated',
        nextCredentialRef: hostRef('host-ref-rotated'),
        clientInstanceId: CLIENT_INSTANCE_ID,
        handshake: {
          environmentId: 'environment-confirmed',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        },
      }),
    ).rejects.toThrow('metadata was not saved');

    expect(credentials.get('station-bearer:kontour-token')).toBe('old-token');
  });

  it('does not leave a new profile or keyring account behind when creation cannot persist', async () => {
    const { credentials, currentStore, storage } = storageWithKeyring({
      failProfileWrite: true,
    });
    await storage.hydrate();

    await expect(
      storage.commitVerifiedPairing({
        connectionId: 'temporary-desktop-connection',
        name: 'brian-media',
        endpoint: 'https://brian-media.example',
        credentialHandle: 'handle-new',
        nextCredentialRef: hostRef('host-ref-new'),
        clientInstanceId: CLIENT_INSTANCE_ID,
        handshake: {
          environmentId: 'environment-brian-media',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        },
      }),
    ).rejects.toThrow('metadata was not saved');

    expect(currentStore().profiles).toHaveLength(PROFILE_STORE.profiles.length);
    expect(credentials.has('station-bearer:environment-brian-media')).toBe(
      false,
    );
  });

  it('reports cleanup failure after the new profile and keyring value are durable', async () => {
    const { credentials, currentStore, storage } = storageWithKeyring({
      failOldReferenceDelete: true,
    });
    await storage.hydrate();

    await expect(
      storage.commitVerifiedPairing({
        connectionId: 'station-profile:kontour',
        name: 'kontour',
        endpoint: 'http://127.0.0.1:3141',
        credentialHandle: 'handle-rotated',
        nextCredentialRef: { kind: 'station-bearer', id: 'rotated-token-ref' },
        clientInstanceId: CLIENT_INSTANCE_ID,
        handshake: {
          environmentId: 'environment-confirmed',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
        },
      }),
    ).rejects.toThrow('unreferenced prior credential could not be removed');

    expect(currentStore().profiles[0]).toMatchObject({
      environmentId: 'environment-confirmed',
      credentialRef: { kind: 'station-bearer', id: 'rotated-token-ref' },
    });
    expect(credentials.get('station-bearer:kontour-token')).toBe('old-token');
    expect(credentials.get('station-bearer:rotated-token-ref')).toBe(
      'host-owned:handle-rotated',
    );
  });

  it('re-reads and merges an out-of-band CLI update after a CAS conflict', async () => {
    const { currentStore, storage } = storageWithKeyring({
      conflictOnceBeforeWrite: (store) => ({
        ...store,
        revision: store.revision + 1,
        defaultProfile: 'station.kontourai.io',
      }),
    });
    await storage.hydrate();

    await storage.commitVerifiedPairing({
      connectionId: 'station-profile:kontour',
      name: 'kontour',
      endpoint: 'http://127.0.0.1:3141',
      credentialHandle: 'handle-refreshed',
      nextCredentialRef: hostRef('host-ref-refreshed'),
      clientInstanceId: CLIENT_INSTANCE_ID,
      handshake: {
        environmentId: 'environment-confirmed',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      },
    });

    expect(currentStore()).toMatchObject({
      revision: 3,
      defaultProfile: 'station.kontourai.io',
    });
    expect(currentStore().profiles[0]).toMatchObject({
      environmentId: 'environment-confirmed',
    });
  });
});
