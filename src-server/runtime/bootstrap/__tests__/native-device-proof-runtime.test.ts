import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { loadLocalAccounts } from '../../../services/identity/local-account-runtime.js';
import { createProjectMembershipRuntime } from '../../../services/projects/project-membership-runtime.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createNativeDeviceProofRuntime } from '../native-device-proof-runtime.js';
import { StationRuntime } from '../station-runtime.js';

const makeTempDir = trackTempDirs();
const retire: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of retire.splice(0)) await close();
  vi.restoreAllMocks();
});

async function fixture() {
  const homeDir = makeTempDir('native-proof-runtime-');
  mkdirSync(join(homeDir, 'security'), { mode: 0o700, recursive: true });
  const security = new EnvironmentSecurityService({ homeDir });
  const { environmentId: stationId } = await security.initialize();
  const membership = createProjectMembershipRuntime(
    homeDir,
    stationId,
    new FileStorageAdapter(homeDir),
  );
  retire.push(() => membership.close());
  const authentication = await loadLocalAccounts(
    { publicOrigin: 'https://station.test' },
    { stationId, homeDirectory: homeDir },
    membership.service,
  );
  retire.unshift(() => authentication.service.close());
  return {
    homeDir,
    membership,
    databasePath: join(
      homeDir,
      'security',
      'native-device-proof-replay.sqlite',
    ),
    options: {
      flag: '1',
      homeDir,
      stationId,
      authentication: authentication.service,
      virtualApplicationOrigin: 'https://station.test',
      nativeApplication: {
        stationId,
        surface: {
          kind: 'station-native' as const,
          appIdentifier: 'io.kontourai.station.test',
          channel: 'dev' as const,
          clientInstanceId: randomUUID(),
          keyThumbprint: 'a'.repeat(43),
        },
      },
      pairing: security.devicePairing,
    },
  };
}

describe('native Device proof runtime composition', () => {
  test('absent and 0 opt-in preserve defaults without requiring provider or connector', async () => {
    const h = await fixture();
    for (const flag of [undefined, '0'])
      expect(
        createNativeDeviceProofRuntime({
          ...h.options,
          flag,
          authentication: undefined,
          nativeApplication: undefined,
          virtualApplicationOrigin: undefined,
        }),
      ).toBeUndefined();
    expect(existsSync(h.databasePath)).toBe(false);
  });

  test('unsupported flags, providers and native connectors refuse before opening replay storage', async () => {
    const h = await fixture();
    for (const changed of [
      { flag: 'false' },
      { authentication: undefined },
      { nativeApplication: undefined },
      { virtualApplicationOrigin: undefined },
      {
        nativeApplication: {
          ...h.options.nativeApplication,
          stationId: randomUUID(),
        },
      },
    ])
      expect(() =>
        createNativeDeviceProofRuntime({ ...h.options, ...changed }),
      ).toThrow('STATION_NATIVE_DEVICE_PROOF_PILOT');
    vi.spyOn(
      h.options.authentication,
      'sessionReferenceCapabilities',
    ).mockReturnValue({ verify: true, login: false });
    expect(() => createNativeDeviceProofRuntime(h.options)).toThrow(
      'verify and login',
    );
    expect(existsSync(h.databasePath)).toBe(false);
  });

  test('supported real provider and explicit native connector configuration own one replay lifetime', async () => {
    const h = await fixture();
    const runtime = createNativeDeviceProofRuntime(h.options);
    if (!runtime) throw new Error('supported native pilot did not compose');
    retire.unshift(() => runtime.close());
    expect(existsSync(h.databasePath)).toBe(true);
    await runtime.configuration.replayStore.consume(
      'owner-contract-proof',
      Math.floor(Date.now() / 1000) + 30,
    );
    runtime.close();
    await expect(
      runtime.configuration.replayStore.consume(
        'retired-contract-proof',
        Math.floor(Date.now() / 1000) + 30,
      ),
    ).rejects.toThrow('closed');
    await expect(
      runtime.authority.admit(
        new Request('https://station.test/api/projects'),
        {
          proof: 'invalid',
          method: 'GET',
          path: '/api/projects',
          body: new Uint8Array(),
        },
      ),
    ).rejects.toMatchObject({ code: 'device_not_current' });
  });
  test('failed opt-in initialization retires actual provider and membership owners', async () => {
    const h = await fixture();
    const providerClosed = vi.spyOn(h.options.authentication, 'close');
    const membershipClosed = vi.spyOn(h.membership, 'close');
    const runtime = Object.create(StationRuntime.prototype) as StationRuntime;
    const unsupported = () =>
      createNativeDeviceProofRuntime({
        ...h.options,
        nativeApplication: undefined,
      });
    Object.assign(runtime, {
      virtualApplicationLifetime: new AbortController(),
      runInitialize: async () => {
        unsupported();
      },
      deploymentAuthentication: { service: h.options.authentication },
      projectMembership: h.membership,
      retireSelfHostedBroker: async () => {},
    });
    vi.stubEnv('STATION_NATIVE_DEVICE_PROOF_PILOT', '1');
    try {
      await expect(runtime.initialize()).rejects.toThrow(
        'native application connector',
      );
      expect(providerClosed).toHaveBeenCalledOnce();
      expect(membershipClosed).toHaveBeenCalledOnce();
      expect(Reflect.get(runtime, 'deploymentAuthentication')).toBeUndefined();
      expect(Reflect.get(runtime, 'projectMembership')).toBeUndefined();
      expect(existsSync(h.databasePath)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
