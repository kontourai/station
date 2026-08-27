import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  pairSavedStation,
  runEnvironmentCommand,
} from '../commands/environment.js';
import type { ProfileCredentialStore } from '../commands/profile-credentials.js';
import {
  findProfile,
  readProfileStore,
  registerPairedProfile,
  setDefaultProfile,
  upsertProfile,
} from '../commands/profile-store.js';

const API_BASE = 'https://host.example.test';
const ACCESS = {
  environmentId: 'env-1111',
  offerId: 'offer-abc',
  proof: 'proof-secret',
  requestId: 'req-42',
  expiresAt: Date.now() + 60_000,
};

const ISSUED = {
  environmentId: 'env-1111',
  device: {
    id: 'device-9',
    name: 'Test CLI',
    scope: 'station:interactive',
    createdAt: 1,
    lastUsedAt: null,
    revokedAt: null,
  },
  credential: 'issued-bearer-credential',
  browserSession: false,
};

function pairing(
  store: ProfileCredentialStore,
  exchange = vi.fn().mockResolvedValue(ISSUED),
) {
  return {
    credentialStore: store,
    requestAccess: vi.fn().mockResolvedValue(ACCESS),
    exchangePairing: exchange,
    sleep: vi.fn(),
    now: () => 1000,
    hostname: () => 'test-box',
  };
}

function credentialStore(): ProfileCredentialStore & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    get: (ref) => values.get(ref.id),
    set: (ref, credential) => values.set(ref.id, credential),
    delete: (ref) => values.delete(ref.id),
    status: (ref) => (values.has(ref.id) ? 'available' : 'missing'),
  };
}

let home: string;
let previousHome: string | undefined;
let previousRoot: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-pair-profile-'));
  previousHome = process.env.STATION_HOME;
  previousRoot = process.env.STATION_ROOT;
  process.env.STATION_HOME = home;
  process.env.STATION_ROOT = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = previousHome;
  if (previousRoot === undefined) delete process.env.STATION_ROOT;
  else process.env.STATION_ROOT = previousRoot;
  rmSync(home, { recursive: true, force: true });
});

describe('environment access pairing', () => {
  test('stores a bearer only via the credential seam and materializes a secret-free profile', async () => {
    const store = credentialStore();
    const stdout = vi.fn();
    await runEnvironmentCommand(
      ['access', 'request', `--api-base=${API_BASE}`, '--station=work'],
      {
        projectHome: '/tmp/home',
        stdout,
        stderr: vi.fn(),
        isInteractive: false,
        pairing: pairing(store),
      },
    );
    const profile = findProfile('work');
    expect(profile).toMatchObject({
      endpoint: API_BASE,
      environmentId: 'env-1111',
      configurationState: 'configured',
    });
    expect(profile?.credentialRef).toEqual({
      kind: 'station-bearer',
      id: expect.stringMatching(/^pairing:env-1111:/),
    });
    expect(store.values.get(profile!.credentialRef!.id)).toBe(
      'issued-bearer-credential',
    );
    expect(JSON.stringify(profile)).not.toContain('issued-bearer-credential');
    expect(JSON.stringify(stdout.mock.calls)).not.toContain(
      'issued-bearer-credential',
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('OS credential store'),
    );
  });

  test('fails before a network request without an explicit direct --api-base', async () => {
    const requestAccess = vi.fn();
    await expect(
      runEnvironmentCommand(['access', 'request'], {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: { credentialStore: credentialStore(), requestAccess },
      }),
    ).rejects.toThrow(/requires --api-base/);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  test('refuses insecure HTTP pairing before any network request', async () => {
    const requestAccess = vi.fn();
    await expect(
      runEnvironmentCommand(
        ['access', 'request', '--api-base=http://host.example.test'],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: credentialStore(), requestAccess },
        },
      ),
    ).rejects.toThrow(/bearer credentials require HTTPS/);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  test('prints the resolved target exactly once for a verbose pairing mutation', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    try {
      await runEnvironmentCommand(
        ['access', 'request', `--api-base=${API_BASE}`, '--verbose'],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: pairing(credentialStore()),
        },
      );
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Target: station=direct endpoint=https://host.example.test source=api-base-flag',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('polls pending approvals until exchange succeeds', async () => {
    const store = credentialStore();
    const pending = Object.assign(new Error('pending'), {
      code: 'request_not_confirmed',
      status: 409,
    });
    const exchange = vi
      .fn()
      .mockRejectedValueOnce(pending)
      .mockRejectedValueOnce(pending)
      .mockResolvedValueOnce(ISSUED);
    const pairingDependencies = pairing(store, exchange);
    await runEnvironmentCommand(
      ['access', 'request', `--api-base=${API_BASE}`],
      {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: pairingDependencies,
      },
    );
    expect(exchange).toHaveBeenCalledTimes(3);
    expect(pairingDependencies.sleep).toHaveBeenCalledTimes(2);
  });

  test('selects the requested default through the already-paired shortcut without network or keyring writes', async () => {
    const store = credentialStore();
    const credentialRef = { kind: 'station-bearer' as const, id: 'paired-ref' };
    upsertProfile({
      name: 'first',
      endpoint: 'https://first.example.test',
      makeDefault: true,
      force: true,
    });
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'env-1111',
      credentialRef,
      configurationState: 'configured',
      force: true,
    });
    store.values.set(credentialRef.id, 'old-bearer');
    const requestAccess = vi.fn();
    const set = vi.spyOn(store, 'set');

    const result = await pairSavedStation(
      { name: 'media', endpoint: API_BASE, makeDefault: true },
      { credentialStore: store, requestAccess },
    );

    expect(result.alreadyPaired).toBe(true);
    expect(readProfileStore().defaultProfile).toBe('media');
    expect(requestAccess).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  test('validates already-paired inputs before reading credentials or selecting a default', async () => {
    const store = credentialStore();
    const credentialRef = { kind: 'station-bearer' as const, id: 'paired-ref' };
    upsertProfile({
      name: 'first',
      endpoint: 'https://first.example.test',
      makeDefault: true,
      force: true,
    });
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'env-1111',
      credentialRef,
      configurationState: 'configured',
      force: true,
    });
    store.values.set(credentialRef.id, 'old-bearer');
    const before = readProfileStore();
    const get = vi.spyOn(store, 'get');
    const set = vi.spyOn(store, 'set');
    const requestAccess = vi.fn();

    await expect(
      pairSavedStation(
        {
          name: 'media',
          endpoint: API_BASE,
          makeDefault: true,
          timeoutSeconds: Number.NaN,
        },
        { credentialStore: store, requestAccess },
      ),
    ).rejects.toThrow(/timeout/);
    await expect(
      pairSavedStation(
        {
          name: 'media',
          endpoint: API_BASE,
          makeDefault: true,
          deviceName: '',
        },
        { credentialStore: store, requestAccess },
      ),
    ).rejects.toThrow(/device-name/);

    expect(readProfileStore()).toEqual(before);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(requestAccess).not.toHaveBeenCalled();
  });

  test('validates raw access-request flags and honors explicit force true or false', async () => {
    const store = credentialStore();
    upsertProfile({
      name: 'first',
      endpoint: 'https://first.example.test',
      makeDefault: true,
      force: true,
    });
    upsertProfile({
      name: 'media',
      endpoint: 'https://old.example.test',
      environmentId: 'old-environment',
      credentialRef: { kind: 'station-bearer', id: 'old-ref' },
      configurationState: 'configured',
      force: true,
    });
    const get = vi.spyOn(store, 'get');
    const requestAccess = vi.fn();
    await expect(
      runEnvironmentCommand(['access', 'request', '--api-base='], {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: { credentialStore: store, requestAccess },
      }),
    ).rejects.toThrow(/api-base requires a value/);
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          `--api-base=${API_BASE}`,
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/Duplicate option --api-base/);
    await expect(
      runEnvironmentCommand(
        ['access', 'request', `--api-base=${API_BASE}`, '--station='],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/station requires a value/);
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--station=first',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/Duplicate option --station/);
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--device-name=',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/device-name requires a value/);
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--force',
          '--force=false',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/Duplicate option --force/);
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--force=false',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/refusing to replace its credential binding/);
    expect(requestAccess).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(readProfileStore().defaultProfile).toBe('first');

    const denied = Object.assign(new Error('denied'), {
      code: 'request_denied',
      status: 403,
    });
    const forced = pairing(store, vi.fn().mockRejectedValue(denied));
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--force=true',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: forced,
        },
      ),
    ).rejects.toThrow(/denied device access/);
    expect(forced.requestAccess).toHaveBeenCalledOnce();
  });

  test('rolls back a new credential and preserves a newer default selected during approval', async () => {
    const store = credentialStore();
    const oldRef = { kind: 'station-bearer' as const, id: 'old-ref' };
    const newRef = { kind: 'station-bearer' as const, id: 'new-ref' };
    upsertProfile({
      name: 'first',
      endpoint: 'https://first.example.test',
      makeDefault: true,
      force: true,
    });
    upsertProfile({
      name: 'other',
      endpoint: 'https://other.example.test',
      force: true,
    });
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'old-environment',
      credentialRef: oldRef,
      configurationState: 'configured',
      force: true,
    });
    store.values.set(oldRef.id, 'old-bearer');

    await expect(
      pairSavedStation(
        { name: 'media', endpoint: API_BASE, force: true, makeDefault: true },
        {
          ...pairing(store),
          createCredentialRef: () => newRef,
          beforeRegisterProfile: async () => {
            setDefaultProfile('other');
          },
        },
      ),
    ).rejects.toThrow(
      /default Station changed while pairing approval was pending/,
    );
    expect(readProfileStore().defaultProfile).toBe('other');
    expect(findProfile('media')?.credentialRef).toEqual(oldRef);
    expect(store.values).toEqual(new Map([[oldRef.id, 'old-bearer']]));
  });

  test('does not persist a credential when the host denies pairing', async () => {
    const store = credentialStore();
    const denied = Object.assign(new Error('denied'), {
      code: 'request_denied',
      status: 403,
    });
    await expect(
      runEnvironmentCommand(['access', 'request', `--api-base=${API_BASE}`], {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: pairing(store, vi.fn().mockRejectedValue(denied)),
      }),
    ).rejects.toThrow(/denied device access/);
    expect(store.values).toEqual(new Map());
  });

  test('keeps an existing default and credential untouched when pairing is denied', async () => {
    const store = credentialStore();
    const oldRef = { kind: 'station-bearer' as const, id: 'old-ref' };
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'old-environment',
      credentialRef: oldRef,
      configurationState: 'configured',
      makeDefault: true,
      force: true,
    });
    store.values.set(oldRef.id, 'old-bearer');
    const denied = Object.assign(new Error('denied'), {
      code: 'request_denied',
      status: 403,
    });
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--force',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: pairing(store, vi.fn().mockRejectedValue(denied)),
        },
      ),
    ).rejects.toThrow(/denied device access/);
    expect(readProfileStore().defaultProfile).toBe('media');
    expect(findProfile('media')?.credentialRef).toEqual(oldRef);
    expect(store.values).toEqual(new Map([[oldRef.id, 'old-bearer']]));
  });

  test('rejects a named endpoint mismatch before requesting approval unless forced', async () => {
    const store = credentialStore();
    upsertProfile({
      name: 'media',
      endpoint: 'https://old.example.test',
      credentialRef: { kind: 'station-bearer', id: 'old-ref' },
      environmentId: 'old-environment',
      configurationState: 'configured',
      force: true,
    });
    const requestAccess = vi.fn();
    await expect(
      runEnvironmentCommand(
        ['access', 'request', `--api-base=${API_BASE}`, '--station=media'],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: { credentialStore: store, requestAccess },
        },
      ),
    ).rejects.toThrow(/refusing to replace its credential binding/);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  test('times out while a pairing request remains pending', async () => {
    const store = credentialStore();
    const pending = Object.assign(new Error('pending'), {
      code: 'request_not_confirmed',
      status: 409,
    });
    const clock = [0, 1_001];
    await expect(
      runEnvironmentCommand(
        ['access', 'request', `--api-base=${API_BASE}`, '--timeout=1'],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: {
            ...pairing(store, vi.fn().mockRejectedValue(pending)),
            now: () => clock.shift() ?? 1_001,
          },
        },
      ),
    ).rejects.toThrow(/Timed out after 1s/);
    expect(store.values).toEqual(new Map());
  });

  test('re-pairing an unflagged endpoint reconciles its existing saved Station', async () => {
    const store = credentialStore();
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'env-1111',
      credentialRef: { kind: 'station-bearer', id: 'env-1111' },
      configurationState: 'configured',
      force: true,
    });
    store.values.set('env-1111', 'old-bearer');
    await runEnvironmentCommand(
      ['access', 'request', `--api-base=${API_BASE}`, '--force'],
      {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: pairing(store),
      },
    );
    expect(readProfileStore().profiles).toHaveLength(1);
    const ref = findProfile('media')?.credentialRef;
    expect(ref?.id).toMatch(/^pairing:env-1111:/);
    expect(store.values.get(ref!.id)).toBe('issued-bearer-credential');
    expect(store.values.has('env-1111')).toBe(false);
  });

  test('keeps a prior credential untouched if paired Station metadata cannot be saved', async () => {
    const store = credentialStore();
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'env-1111',
      credentialRef: { kind: 'station-bearer', id: 'env-1111' },
      configurationState: 'configured',
      force: true,
    });
    store.values.set('env-1111', 'old-bearer');
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--force',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: {
            ...pairing(store),
            registerProfile: () => {
              throw new Error('metadata failed');
            },
          },
        },
      ),
    ).rejects.toThrow('metadata failed');
    expect(store.values.get('env-1111')).toBe('old-bearer');
    expect(store.values).toHaveLength(1);
  });

  test('deletes a newly issued credential if paired Station metadata cannot be saved', async () => {
    const store = credentialStore();
    await expect(
      runEnvironmentCommand(
        ['access', 'request', `--api-base=${API_BASE}`, '--station=media'],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: {
            ...pairing(store),
            registerProfile: () => {
              throw new Error('metadata failed');
            },
          },
        },
      ),
    ).rejects.toThrow('metadata failed');
    expect(store.values).toHaveLength(0);
  });

  test('keeps the old binding when the OS keyring cannot store a new credential', async () => {
    const oldRef = { kind: 'station-bearer' as const, id: 'old-ref' };
    const deleted: string[] = [];
    const store: ProfileCredentialStore = {
      get: (ref) => (ref.id === oldRef.id ? 'old-bearer' : undefined),
      set: () => {
        throw new Error('keyring unavailable');
      },
      delete: (ref) => deleted.push(ref.id),
      status: () => 'available',
    };
    upsertProfile({
      name: 'media',
      endpoint: API_BASE,
      environmentId: 'old-environment',
      credentialRef: oldRef,
      configurationState: 'configured',
      makeDefault: true,
      force: true,
    });
    await expect(
      runEnvironmentCommand(
        [
          'access',
          'request',
          `--api-base=${API_BASE}`,
          '--station=media',
          '--force',
        ],
        {
          projectHome: '/tmp/home',
          isInteractive: false,
          pairing: pairing(store),
        },
      ),
    ).rejects.toThrow(/existing Station binding was preserved/);
    expect(findProfile('media')?.credentialRef).toEqual(oldRef);
    expect(readProfileStore().defaultProfile).toBe('media');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatch(/^pairing:env-1111:/);
  });

  test.skipIf(process.platform === 'win32')(
    'reports post-commit cleanup failure without changing the successful pairing result',
    async () => {
      const store = credentialStore();
      const oldRef = { kind: 'station-bearer' as const, id: 'old-ref' };
      upsertProfile({
        name: 'media',
        endpoint: API_BASE,
        environmentId: 'old-environment',
        credentialRef: oldRef,
        configurationState: 'configured',
        makeDefault: true,
        force: true,
      });
      store.values.set(oldRef.id, 'old-bearer');
      const stdout = vi.fn();
      try {
        await pairSavedStation(
          { name: 'media', endpoint: API_BASE, force: true },
          {
            ...pairing(store),
            stdout,
            registerProfile: (endpoint, input) => {
              const registration = registerPairedProfile(endpoint, input);
              chmodSync(join(home, 'config'), 0o755);
              return registration;
            },
          },
        );
      } finally {
        chmodSync(join(home, 'config'), 0o700);
      }
      const profile = findProfile('media');
      expect(profile?.credentialRef?.id).toMatch(/^pairing:env-1111:/);
      expect(readProfileStore().defaultProfile).toBe('media');
      expect(store.values.has(oldRef.id)).toBe(true);
      expect(JSON.stringify(stdout.mock.calls)).toContain(
        'retirement of the replaced credential could not be confirmed',
      );
      expect(JSON.stringify(stdout.mock.calls)).not.toContain('Retry');
    },
  );

  test('a stale concurrent pairing rolls back its own ref and preserves the newer winner', async () => {
    const store = credentialStore();
    const refA = { kind: 'station-bearer' as const, id: 'pairing:env-1111:a' };
    const refB = { kind: 'station-bearer' as const, id: 'pairing:env-1111:b' };
    let releaseFirst: (() => void) | undefined;
    const firstMayRegister = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStored!: () => void;
    const firstHasStored = new Promise<void>((resolve) => {
      firstStored = resolve;
    });

    const first = runEnvironmentCommand(
      ['access', 'request', `--api-base=${API_BASE}`, '--station=media'],
      {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: {
          ...pairing(store),
          createCredentialRef: () => refA,
          beforeRegisterProfile: async () => {
            firstStored();
            await firstMayRegister;
          },
        },
      },
    );
    await firstHasStored;

    await runEnvironmentCommand(
      ['access', 'request', `--api-base=${API_BASE}`, '--station=media'],
      {
        projectHome: '/tmp/home',
        isInteractive: false,
        pairing: { ...pairing(store), createCredentialRef: () => refB },
      },
    );
    releaseFirst!();
    await expect(first).rejects.toThrow(
      /created while pairing approval was pending/,
    );

    expect(findProfile('media')?.credentialRef).toEqual(refB);
    expect(store.values.has(refA.id)).toBe(false);
    expect(store.values.get(refB.id)).toBe('issued-bearer-credential');
  });
});
