import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readInstanceRegistry,
  resolveInstanceRegistryPath,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import {
  acquireStationHomeMaintenanceLease,
  acquireStationHomeRuntimeLease,
} from '@kontourai/station-shared/station-home-lifecycle';
import { afterEach, describe, expect, test } from 'vitest';
import { withProfileStoreLock } from '../../../packages/cli/src/commands/profile-store.js';
import {
  prepareRuntime,
  readRegistryInstances,
} from '../instance-registry-bridge.js';
import { quarantineLegacyServiceManifest } from '../legacy-service-manifest-quarantine.js';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'station-registry-bridge-'));
  roots.push(value);
  return value;
}

function legacyFixture(
  stationRoot: string,
  installedAt = '',
  manifestOverrides: Readonly<Record<string, unknown>> = {},
): {
  home: string;
  manifest: string;
} {
  const home = join(stationRoot, 'instances', 'stable');
  const manifest = join(home, 'service', 'default.json');
  mkdirSync(join(home, 'service'), { recursive: true, mode: 0o700 });
  writeFileSync(
    manifest,
    JSON.stringify({
      allowedOrigins: [],
      baseDir: stationRoot,
      features: '',
      host: '127.0.0.1',
      installedAt,
      instanceId: 'default',
      label: 'default',
      nodePath: '',
      platform: 'darwin',
      repoPath: '/tmp/station-service',
      serverPort: 3141,
      uiPort: 3000,
      unitPath: '',
      ...manifestOverrides,
    }),
    { mode: 0o600 },
  );
  return { home, manifest };
}

function profileStore(stationRoot: string): unknown {
  return {
    schemaVersion: 1,
    revision: 0,
    defaultProfile: 'stable',
    projectProfiles: {},
    profiles: [
      {
        schemaVersion: 1,
        name: 'stable',
        endpoint: 'http://127.0.0.1:3141',
        localService: {
          instanceId: 'default',
          baseDir: stationRoot,
          serverPort: 3141,
          uiPort: 3000,
        },
        setupSource: 'local',
        configurationState: 'configured',
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  };
}

function authorizeLegacyService(stationRoot: string): void {
  mkdirSync(join(stationRoot, 'config'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stationRoot, 'config', 'profiles.json'),
    JSON.stringify(profileStore(stationRoot)),
    { mode: 0o600 },
  );
}

function publishLiveLegacyService(home: string): void {
  const birth = lookupProcessBirthFingerprint(process.pid)!;
  upsertInstance(
    'legacy-service',
    { port: 3141, type: 'service', pid: process.pid, birth },
    home,
  );
}

function unavailableProcessProbe(code?: string): (pid: number) => void {
  return () => {
    const error = new Error(
      'injected process probe failure',
    ) as NodeJS.ErrnoException;
    if (code) error.code = code;
    throw error;
  };
}

function legacyQuarantine(home: string): string {
  return join(home, 'quarantine', 'legacy-service-manifest');
}

function manifestDigest(manifest: string): string {
  return createHash('sha256').update(readFileSync(manifest)).digest('hex');
}

function preparedReceipt(manifest: string): Record<string, unknown> {
  const source = lstatSync(manifest);
  const digest = manifestDigest(manifest);
  return {
    schemaVersion: 1,
    kind: 'legacy-service-default',
    state: 'prepared',
    digest,
    source: { dev: source.dev, ino: source.ino },
    sourcePath: join('service', 'default.json'),
    quarantinedPath: join(
      'quarantine',
      'legacy-service-manifest',
      `legacy-service-default-${digest}.json`,
    ),
  };
}

function quarantineTarget(home: string, digest: string): string {
  return join(legacyQuarantine(home), `legacy-service-default-${digest}.json`);
}

function preparedReceiptPath(home: string, digest: string): string {
  return join(
    legacyQuarantine(home),
    `legacy-service-default-${digest}.receipt.json`,
  );
}

function committedReceiptPath(home: string, digest: string): string {
  return join(
    legacyQuarantine(home),
    `legacy-service-default-${digest}.committed.json`,
  );
}

function ownedTemporaryPath(
  home: string,
  digest: string,
  state: 'receipt' | 'committed',
  uuid = '00000000-0000-4000-8000-000000000000',
): string {
  return join(
    legacyQuarantine(home),
    `.legacy-service-default-${digest}.${state}.json.${uuid}.tmp`,
  );
}

function bridgeChild(operation: string, input: unknown) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      'tsx/esm',
      'src-server/tools/instance-registry-bridge.ts',
      operation,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: JSON.stringify(input),
    },
  );
}

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe('instance registry bridge legacy manifest transaction (archive#4457)', () => {
  test('child bridge exposes exact prepare success/refusal output and redacts unexpected errors', () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const success = bridgeChild('prepareRuntime', {
      home: fixture.home,
      root: stationRoot,
    });
    expect(success.status).toBe(0);
    expect(success.stderr).toBe('');
    expect(success.stdout).toBe('{"ok":true,"kind":"new"}\n');

    const refusedRoot = root();
    const refusedFixture = legacyFixture(refusedRoot);
    chmodSync(refusedFixture.manifest, 0o644);
    const refused = bridgeChild('prepareRuntime', {
      home: refusedFixture.home,
      root: refusedRoot,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toBe('');
    expect(refused.stdout).toBe(
      '{"ok":false,"result":{"kind":"refused"},"error":{"code":"RUNTIME_REFUSED"}}\n',
    );

    const file = join(stationRoot, 'not-a-runtime-home');
    writeFileSync(file, 'not a directory', { mode: 0o600 });
    const unexpected = bridgeChild('read', { home: file });
    expect(unexpected.status).toBe(1);
    expect(unexpected.stderr).toBe('');
    expect(JSON.parse(unexpected.stdout)).toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    });
    expect(unexpected.stdout).not.toContain(file);
  });

  test('bounded registry or held profile lock cannot strand preparation ownership', () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const releaseRegistry = acquireFileMutationLock(
      `${resolveInstanceRegistryPath(fixture.home)}.mutation`,
    );
    try {
      const started = Date.now();
      const blocked = bridgeChild('prepareRuntime', {
        home: fixture.home,
        root: stationRoot,
      });
      expect(blocked.status).toBe(1);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(withProfileStoreLock(() => 'available', stationRoot)).toBe(
        'available',
      );
      const maintenance = acquireStationHomeMaintenanceLease(fixture.home);
      maintenance.release();
    } finally {
      releaseRegistry();
    }

    mkdirSync(join(stationRoot, 'config'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stationRoot, 'config', 'profiles.json.lock'),
      JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    const heldProfile = bridgeChild('prepareRuntime', {
      home: fixture.home,
      root: stationRoot,
    });
    expect(heldProfile.status).toBe(1);
    const registry = acquireFileMutationLock(
      `${resolveInstanceRegistryPath(fixture.home)}.mutation`,
    );
    registry();
    const maintenance = acquireStationHomeMaintenanceLease(fixture.home);
    maintenance.release();
  });

  test('moves the exact Stable fixture to a digest-keyed quarantine with a committed receipt', async () => {
    const stationRoot = root();
    const { home, manifest } = legacyFixture(stationRoot);
    await expect(prepareRuntime(home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    expect(existsSync(manifest)).toBe(false);
    const entries = readdirSync(legacyQuarantine(home));
    expect(entries).toHaveLength(3);
    expect(entries.some((entry) => entry.endsWith('.receipt.json'))).toBe(true);
    await expect(prepareRuntime(home, stationRoot)).resolves.toEqual({
      kind: 'already',
    });
  });

  test('repeats committed preparation after a graceful stop reaps only the provably stale desktop sidecar', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const receipt = readdirSync(legacyQuarantine(fixture.home)).find((entry) =>
      entry.endsWith('.committed.json'),
    )!;
    const committedBefore = readFileSync(
      join(legacyQuarantine(fixture.home), receipt),
    );

    // Models first launch -> a sidecar claim -> graceful sidecar exit. The
    // second launch uses the packaged bridge protocol, not a test-only helper.
    const exitedSidecar = spawnSync(process.execPath, ['-e', ''], {
      windowsHide: true,
    });
    expect(exitedSidecar.status).toBe(0);
    expect(exitedSidecar.pid).toBeGreaterThan(0);
    upsertInstance(
      'desktop-sidecar-prior-generation',
      {
        port: 18141,
        type: 'sidecar',
        pid: exitedSidecar.pid,
        birth: 'prior-sidecar-birth',
      },
      fixture.home,
    );
    const secondLaunch = bridgeChild('prepareRuntime', {
      home: fixture.home,
      root: stationRoot,
    });
    expect(secondLaunch.status).toBe(0);
    expect(secondLaunch.stdout).toBe('{"ok":true,"kind":"already"}\n');
    expect(
      readInstanceRegistry(fixture.home).instances[
        'desktop-sidecar-prior-generation'
      ],
    ).toBeUndefined();
    expect(existsSync(fixture.manifest)).toBe(false);
    expect(readFileSync(join(legacyQuarantine(fixture.home), receipt))).toEqual(
      committedBefore,
    );
  });

  test.each([
    ['live owner', 'exact' as const],
    ['ambiguous owner', 'ambiguous' as const],
    ['partial stopped owner', 'partial' as const],
  ])(
    'does not reap a %s sidecar claim during repeated preparation',
    async (_description, liveness) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'new',
      });
      const birth = lookupProcessBirthFingerprint(process.pid)!;
      upsertInstance(
        'desktop-sidecar-current-generation',
        liveness === 'partial'
          ? { port: 18141, type: 'sidecar', status: 'stopped' }
          : { port: 18141, type: 'sidecar', pid: process.pid, birth },
        fixture.home,
      );

      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          ...(liveness === 'ambiguous'
            ? { registryProcessProbe: unavailableProcessProbe('EPERM') }
            : {}),
        }),
      ).resolves.toEqual({ kind: 'already' });
      expect(
        readInstanceRegistry(fixture.home).instances[
          'desktop-sidecar-current-generation'
        ],
      ).toEqual(
        liveness === 'partial'
          ? expect.objectContaining({ status: 'stopped' })
          : expect.objectContaining({ pid: process.pid, birth }),
      );
    },
  );

  test.each([
    [
      'dead PID',
      { pid: 47_763, birth: 'prior-sidecar-birth' },
      unavailableProcessProbe('ESRCH'),
    ],
    [
      'reused PID',
      { pid: process.pid, birth: 'prior-sidecar-birth' },
      undefined,
    ],
  ] as const)(
    'preserves a terminal stopped sidecar record byte-for-byte when its %s is no longer current',
    async (_description, identity, registryProcessProbe) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'new',
      });
      upsertInstance(
        'desktop-sidecar-terminal-generation',
        {
          port: 18141,
          type: 'sidecar',
          status: 'stopped',
          ...identity,
        },
        fixture.home,
      );
      const before = readFileSync(resolveInstanceRegistryPath(fixture.home));

      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          ...(registryProcessProbe ? { registryProcessProbe } : {}),
        }),
      ).resolves.toEqual({ kind: 'already' });
      expect(readFileSync(resolveInstanceRegistryPath(fixture.home))).toEqual(
        before,
      );
      expect(
        readInstanceRegistry(fixture.home).instances[
          'desktop-sidecar-terminal-generation'
        ],
      ).toEqual(expect.objectContaining({ status: 'stopped', ...identity }));
    },
  );

  test('reaps a sidecar claim only when a successful liveness probe proves PID reuse', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    upsertInstance(
      'desktop-sidecar-reused-pid',
      {
        port: 18141,
        type: 'sidecar',
        pid: process.pid,
        birth: 'prior-process-birth',
      },
      fixture.home,
    );

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'already',
    });
    expect(
      readInstanceRegistry(fixture.home).instances[
        'desktop-sidecar-reused-pid'
      ],
    ).toBeUndefined();
  });

  test('quarantines the redacted owner-preserved qualified-label/null-features legacy shape', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot, '', {
      // The values that distinguish this historical shape are intentionally
      // non-sensitive; all owner-specific paths and timestamps stay fixture
      // local/redacted.
      label: 'io.kontourai.station.default',
      features: null,
    });

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    expect(existsSync(fixture.manifest)).toBe(false);
    expect(readdirSync(legacyQuarantine(fixture.home))).toHaveLength(3);
  });

  test.each([
    [
      'an unknown qualified label',
      { label: 'io.kontourai.station.default.unrecognized', features: null },
    ],
    ['array features', { label: 'io.kontourai.station.default', features: [] }],
    [
      'numeric features',
      { label: 'io.kontourai.station.default', features: 0 },
    ],
  ] as const)(
    'refuses the qualified-label legacy near miss with %s',
    async (_description, manifestOverrides) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot, '', manifestOverrides);

      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(existsSync(fixture.manifest)).toBe(true);
    },
  );

  test('uses the supplied shared root, not cwd, and leaves a different home untouched', async () => {
    const stationRoot = root();
    const { home } = legacyFixture(stationRoot);
    const other = legacyFixture(root());
    await expect(
      quarantineLegacyServiceManifest(home, stationRoot),
    ).resolves.toEqual({
      kind: 'new',
    });
    expect(existsSync(other.manifest)).toBe(true);
  });

  test('refuses a current shared localService profile or a live service registry owner', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    mkdirSync(join(stationRoot, 'config'), { mode: 0o700 });
    writeFileSync(
      join(stationRoot, 'config', 'profiles.json'),
      JSON.stringify(profileStore(stationRoot)),
      { mode: 0o600 },
    );
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    rmSync(join(stationRoot, 'config', 'profiles.json'));
    const previous = process.env.STATION_ROOT;
    process.env.STATION_ROOT = stationRoot;
    try {
      const birth = lookupProcessBirthFingerprint(process.pid)!;
      upsertInstance(
        'legacy-service',
        { port: 3141, type: 'service', pid: process.pid, birth },
        fixture.home,
      );
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
    } finally {
      if (previous === undefined) delete process.env.STATION_ROOT;
      else process.env.STATION_ROOT = previous;
    }
  });

  test.each([
    ['EPERM', unavailableProcessProbe('EPERM')],
    ['unknown error', unavailableProcessProbe()],
  ] as const)(
    'refuses and leaves the source untouched when the registry probe returns %s',
    async (_outcome, registryProcessProbe) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      const sourceBefore = readFileSync(fixture.manifest);
      upsertInstance(
        'legacy-service',
        {
          port: 3141,
          type: 'service',
          pid: process.pid,
          // EPERM/unknown failure remains live-or-ambiguous even if an old
          // fingerprint would otherwise prove PID reuse after a success.
          birth: 'old',
        },
        fixture.home,
      );

      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          registryProcessProbe,
        }),
      ).resolves.toEqual({ kind: 'refused' });
      expect(readFileSync(fixture.manifest)).toEqual(sourceBefore);
      expect(existsSync(legacyQuarantine(fixture.home))).toBe(false);
    },
  );

  test('quarantines the exact legacy source when the registry probe proves ESRCH', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    upsertInstance(
      'legacy-service',
      { port: 3141, type: 'service', pid: process.pid, birth: 'old' },
      fixture.home,
    );

    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        registryProcessProbe: unavailableProcessProbe('ESRCH'),
      }),
    ).resolves.toEqual({ kind: 'new' });
    expect(existsSync(fixture.manifest)).toBe(false);
    expect(existsSync(legacyQuarantine(fixture.home))).toBe(true);
  });

  test('refuses while a live runtime holds the maintenance boundary, then releases after outcomes', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const runtime = acquireStationHomeRuntimeLease(fixture.home);
    try {
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(existsSync(fixture.manifest)).toBe(true);
    } finally {
      runtime.release();
    }
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const afterSuccess = acquireStationHomeMaintenanceLease(fixture.home);
    afterSuccess.release();

    const refused = legacyFixture(root());
    chmodSync(refused.manifest, 0o644);
    await expect(prepareRuntime(refused.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    const afterRefusal = acquireStationHomeMaintenanceLease(refused.home);
    afterRefusal.release();
  });

  test('bounds held maintenance, preserves state, then releases for a later preparation', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const maintenance = acquireStationHomeMaintenanceLease(fixture.home);
    try {
      const started = Date.now();
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(existsSync(fixture.manifest)).toBe(true);
    } finally {
      maintenance.release();
    }
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const reacquired = acquireStationHomeMaintenanceLease(fixture.home);
    reacquired.release();
  });

  test('refuses a runtime home directory replacement while maintenance waits', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const original = readFileSync(fixture.manifest);
    const maintenance = acquireStationHomeMaintenanceLease(fixture.home);
    const pending = prepareRuntime(fixture.home, stationRoot);
    const replaced = `${fixture.home}.replaced`;
    try {
      renameSync(fixture.home, replaced);
      mkdirSync(join(fixture.home, 'service'), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(fixture.manifest, original, { mode: 0o600 });
    } finally {
      maintenance.release();
    }
    await expect(pending).resolves.toEqual({ kind: 'refused' });
    expect(readFileSync(fixture.manifest)).toEqual(original);
    expect(existsSync(join(fixture.home, 'quarantine'))).toBe(false);
  });

  test('refuses symlinks and loose modes without moving the source', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    chmodSync(fixture.manifest, 0o644);
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    chmodSync(fixture.manifest, 0o600);
    const outside = join(stationRoot, 'outside');
    mkdirSync(outside, { mode: 0o700 });
    renameSync(
      join(fixture.home, 'service'),
      join(fixture.home, 'service-real'),
    );
    symlinkSync(outside, join(fixture.home, 'service'));
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
  });

  test('refuses a source swap immediately before rename', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        beforeRename: () =>
          writeFileSync(fixture.manifest, '{"changed":true}', { mode: 0o600 }),
      }),
    ).resolves.toEqual({ kind: 'refused' });
    expect(existsSync(fixture.manifest)).toBe(true);
  });

  test.each(['service parent', 'home parent'] as const)(
    'refuses a %s pathname swap that preserves the observed manifest inode',
    async (parent) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      const before = lstatSync(fixture.manifest);
      const originalHome = fixture.home;
      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          afterPreparedBeforeRename: () => {
            if (parent === 'service parent') {
              const parkedService = join(originalHome, 'service-prior');
              renameSync(join(originalHome, 'service'), parkedService);
              mkdirSync(join(originalHome, 'service'), { mode: 0o700 });
              renameSync(
                join(parkedService, 'default.json'),
                join(originalHome, 'service', 'default.json'),
              );
              rmSync(parkedService, { recursive: true, force: true });
            } else {
              const parkedHome = `${originalHome}-prior`;
              renameSync(originalHome, parkedHome);
              mkdirSync(join(originalHome, 'service'), {
                recursive: true,
                mode: 0o700,
              });
              renameSync(
                join(parkedHome, 'service', 'default.json'),
                fixture.manifest,
              );
              rmSync(parkedHome, { recursive: true, force: true });
            }
            const after = lstatSync(fixture.manifest);
            expect(after.dev).toBe(before.dev);
            expect(after.ino).toBe(before.ino);
          },
        }),
      ).resolves.toEqual({ kind: 'refused' });
      expect(existsSync(fixture.manifest)).toBe(true);
      expect(lstatSync(fixture.manifest).ino).toBe(before.ino);
      expect(
        existsSync(legacyQuarantine(fixture.home)) &&
          readdirSync(legacyQuarantine(fixture.home)).some(
            (entry) =>
              entry.endsWith('.json') && !entry.endsWith('.receipt.json'),
          ),
      ).toBe(false);
    },
  );

  test('holds profile and registry decisions through rename, then revalidates direct mutations', async () => {
    const stationRoot = root();
    const profile = legacyFixture(stationRoot);
    await expect(
      quarantineLegacyServiceManifest(profile.home, stationRoot, {
        beforeRename: () => {
          mkdirSync(join(stationRoot, 'config'), {
            recursive: true,
            mode: 0o700,
          });
          writeFileSync(
            join(stationRoot, 'config', 'profiles.json'),
            JSON.stringify(profileStore(stationRoot)),
            { mode: 0o600 },
          );
        },
      }),
    ).resolves.toEqual({ kind: 'refused' });
    expect(existsSync(profile.manifest)).toBe(true);

    const registryRoot = root();
    const registry = legacyFixture(registryRoot);
    const birth = lookupProcessBirthFingerprint(process.pid)!;
    await expect(
      quarantineLegacyServiceManifest(registry.home, registryRoot, {
        beforeRename: () =>
          writeFileSync(
            join(registry.home, 'instances.json'),
            JSON.stringify({
              version: 1,
              instances: {
                service: {
                  port: 3141,
                  type: 'service',
                  pid: process.pid,
                  birth,
                },
              },
            }),
            { mode: 0o600 },
          ),
      }),
    ).resolves.toEqual({ kind: 'refused' });
    expect(existsSync(registry.manifest)).toBe(true);
  });

  test('refuses a second valid legacy variant after singleton evidence exists', async () => {
    const stationRoot = root();
    const first = legacyFixture(stationRoot);
    await expect(prepareRuntime(first.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const second = legacyFixture(stationRoot, 'second-variant');
    await expect(prepareRuntime(second.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(readdirSync(legacyQuarantine(second.home))).toHaveLength(3);
    expect(existsSync(second.manifest)).toBe(true);
  });

  test('refuses corrupt singleton evidence even when the service directory is removed', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const receipt = readdirSync(legacyQuarantine(fixture.home)).find((entry) =>
      entry.endsWith('.receipt.json'),
    )!;
    writeFileSync(join(legacyQuarantine(fixture.home), receipt), '{}', {
      mode: 0o600,
    });
    rmSync(join(fixture.home, 'service'), { recursive: true, force: true });
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
  });

  test('refuses temporary evidence and prepared-only evidence without its source', async () => {
    const temporaryRoot = root();
    const temporary = legacyFixture(temporaryRoot);
    mkdirSync(legacyQuarantine(temporary.home), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(legacyQuarantine(temporary.home), '.prepared.tmp'),
      '{}',
      {
        mode: 0o600,
      },
    );
    await expect(
      prepareRuntime(temporary.home, temporaryRoot),
    ).resolves.toEqual({
      kind: 'refused',
    });

    const preparedRoot = root();
    const prepared = legacyFixture(preparedRoot);
    await expect(
      quarantineLegacyServiceManifest(prepared.home, preparedRoot, {
        afterPreparedBeforeRename: () => {
          throw new Error('prepared only');
        },
      }),
    ).rejects.toThrow('prepared only');
    rmSync(join(prepared.home, 'service'), { recursive: true, force: true });
    await expect(prepareRuntime(prepared.home, preparedRoot)).resolves.toEqual({
      kind: 'refused',
    });
  });

  test('refuses unknown entries in prepared and committed legacy evidence namespaces', async () => {
    const preparedRoot = root();
    const prepared = legacyFixture(preparedRoot);
    await expect(
      quarantineLegacyServiceManifest(prepared.home, preparedRoot, {
        afterPreparedBeforeRename: () => {
          throw new Error('prepared event published');
        },
      }),
    ).rejects.toThrow('prepared event published');
    writeFileSync(join(legacyQuarantine(prepared.home), 'unexpected'), 'x', {
      mode: 0o600,
    });
    await expect(prepareRuntime(prepared.home, preparedRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(prepared.manifest)).toBe(true);
    await expect(prepareRuntime(prepared.home, preparedRoot)).resolves.toEqual({
      kind: 'refused',
    });

    const committedRoot = root();
    const committed = legacyFixture(committedRoot);
    await expect(
      prepareRuntime(committed.home, committedRoot),
    ).resolves.toEqual({
      kind: 'new',
    });
    writeFileSync(join(legacyQuarantine(committed.home), '.unknown'), 'x', {
      mode: 0o600,
    });
    await expect(
      prepareRuntime(committed.home, committedRoot),
    ).resolves.toEqual({
      kind: 'refused',
    });
  });

  test('refuses an identical-byte inode swap after final observation', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const raw = readFileSync(fixture.manifest);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterFinalObservationBeforeRename: () => {
          renameSync(fixture.manifest, `${fixture.manifest}.prior`);
          writeFileSync(fixture.manifest, raw, { mode: 0o600 });
        },
      }),
    ).resolves.toEqual({ kind: 'refused' });
    expect(existsSync(fixture.manifest)).toBe(true);
  });

  test('refuses an extra source hard link created after the final observation', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const digest = manifestDigest(fixture.manifest);
    const extra = `${fixture.manifest}.extra-link`;
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterFinalObservationBeforeRename: () => {
          linkSync(fixture.manifest, extra);
        },
      }),
    ).resolves.toEqual({ kind: 'refused' });
    expect(existsSync(fixture.manifest)).toBe(true);
    expect(existsSync(extra)).toBe(true);
    expect(existsSync(quarantineTarget(fixture.home, digest))).toBe(false);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(false);
  });

  test('refuses a digest-keyed quarantine collision and exposes no paths in outcomes', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const raw = readFileSync(fixture.manifest);
    const digest = createHash('sha256').update(raw).digest('hex');
    mkdirSync(legacyQuarantine(fixture.home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(
        legacyQuarantine(fixture.home),
        `legacy-service-default-${digest}.json`,
      ),
      'different bytes',
      { mode: 0o600 },
    );
    const result = await prepareRuntime(fixture.home, stationRoot);
    expect(result).toEqual({ kind: 'refused' });
    expect(JSON.stringify(result)).not.toContain(stationRoot);
  });

  test('recovers a rename-before-receipt crash and remains idempotent', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterRenameBeforeCommit: () => {
          throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot),
    ).resolves.toEqual({
      kind: 'recovered',
    });
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot),
    ).resolves.toEqual({
      kind: 'already',
    });
  });

  test('exercises every immutable prepared and committed receipt publication boundary', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const digest = manifestDigest(fixture.manifest);
    const prepared = preparedReceiptPath(fixture.home, digest);
    const committed = committedReceiptPath(fixture.home, digest);
    const observed: string[] = [];

    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        beforePreparedFsync: () => {
          const entries = readdirSync(legacyQuarantine(fixture.home));
          expect(entries).toHaveLength(1);
          expect(entries[0]).toMatch(/\.receipt\.json\..+\.tmp$/);
          expect(existsSync(prepared)).toBe(false);
          observed.push('prepared-before-fsync');
        },
        afterPreparedFsyncBeforeLink: () => {
          expect(existsSync(prepared)).toBe(false);
          expect(readdirSync(legacyQuarantine(fixture.home))).toHaveLength(1);
          observed.push('prepared-after-fsync');
        },
        afterPreparedLinkBeforeDirectoryFsync: () => {
          expect(existsSync(prepared)).toBe(true);
          expect(lstatSync(prepared).nlink).toBe(2);
          expect(readdirSync(legacyQuarantine(fixture.home))).toHaveLength(2);
          observed.push('prepared-after-link');
        },
        afterCommittedFsyncBeforeLink: () => {
          expect(existsSync(committed)).toBe(false);
          expect(readdirSync(legacyQuarantine(fixture.home))).toHaveLength(3);
          observed.push('committed-after-fsync');
        },
        afterCommittedLinkBeforeDirectoryFsync: () => {
          expect(existsSync(committed)).toBe(true);
          expect(lstatSync(committed).nlink).toBe(2);
          expect(readdirSync(legacyQuarantine(fixture.home))).toHaveLength(4);
          observed.push('committed-after-link');
        },
      }),
    ).resolves.toEqual({ kind: 'new' });
    expect(observed).toEqual([
      'prepared-before-fsync',
      'prepared-after-fsync',
      'prepared-after-link',
      'committed-after-fsync',
      'committed-after-link',
    ]);
    expect(lstatSync(prepared).nlink).toBe(1);
    expect(lstatSync(committed).nlink).toBe(1);
  });

  test.each([
    'afterRenameBeforeCommit',
    'afterCommittedFsyncBeforeLink',
    'afterCommittedLinkBeforeDirectoryFsync',
  ] as const)(
    'refuses a target hard link injected at %s and leaves fail-closed evidence',
    async (boundary) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      const digest = manifestDigest(fixture.manifest);
      const target = quarantineTarget(fixture.home, digest);
      const extra = `${target}.external-link`;
      const mutateTarget = () => linkSync(target, extra);
      const hooks =
        boundary === 'afterRenameBeforeCommit'
          ? { afterRenameBeforeCommit: mutateTarget }
          : boundary === 'afterCommittedFsyncBeforeLink'
            ? { afterCommittedFsyncBeforeLink: mutateTarget }
            : { afterCommittedLinkBeforeDirectoryFsync: mutateTarget };

      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, hooks),
      ).resolves.toEqual({ kind: 'refused' });
      expect(lstatSync(target).nlink).toBeGreaterThan(1);
      expect(existsSync(extra)).toBe(true);
      // A retained prepared or committed marker cannot turn a later retry into
      // an `already`/`recovered` success because inspection re-opens the same
      // now-linked target.
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
    },
  );

  test.each([
    ['partial/torn owned temporary before fsync', '{'],
    ['complete owned temporary after fsync before link', undefined],
  ] as const)(
    'cleans %s and resumes the safe source-only state',
    async (_, content) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      const digest = manifestDigest(fixture.manifest);
      mkdirSync(legacyQuarantine(fixture.home), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        ownedTemporaryPath(fixture.home, digest, 'receipt'),
        content ?? `${JSON.stringify(preparedReceipt(fixture.manifest))}\n`,
        { mode: 0o600 },
      );

      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'new',
      });
      expect(existsSync(fixture.manifest)).toBe(false);
      expect(
        existsSync(ownedTemporaryPath(fixture.home, digest, 'receipt')),
      ).toBe(false);
      expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
    },
  );

  test('cleans an exact orphan temporary alongside a final prepared receipt', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const digest = manifestDigest(fixture.manifest);
    mkdirSync(legacyQuarantine(fixture.home), { recursive: true, mode: 0o700 });
    writeFileSync(
      preparedReceiptPath(fixture.home, digest),
      `${JSON.stringify(preparedReceipt(fixture.manifest))}\n`,
      { mode: 0o600 },
    );
    const temporary = ownedTemporaryPath(fixture.home, digest, 'receipt');
    linkSync(preparedReceiptPath(fixture.home, digest), temporary);
    expect(lstatSync(temporary).nlink).toBe(2);

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    expect(existsSync(fixture.manifest)).toBe(false);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
  });

  test('cleans an exact orphan temporary alongside committed evidence without reopening it', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const target = readdirSync(legacyQuarantine(fixture.home)).find(
      (entry) =>
        entry.endsWith('.json') &&
        !entry.endsWith('.receipt.json') &&
        !entry.endsWith('.committed.json'),
    )!;
    const digest = target.slice(
      'legacy-service-default-'.length,
      -'.json'.length,
    );
    const temporary = ownedTemporaryPath(fixture.home, digest, 'committed');
    linkSync(committedReceiptPath(fixture.home, digest), temporary);
    expect(lstatSync(temporary).nlink).toBe(2);

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'already',
    });
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
  });

  test('cleans an exact prepared final/temp replay before recovering a target-only move', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const digest = manifestDigest(fixture.manifest);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterRenameBeforeCommit: () => {
          throw new Error('target-only prepared replay');
        },
      }),
    ).rejects.toThrow('target-only prepared replay');
    const prepared = preparedReceiptPath(fixture.home, digest);
    const temporary = ownedTemporaryPath(fixture.home, digest, 'receipt');
    linkSync(prepared, temporary);
    expect(lstatSync(prepared).nlink).toBe(2);

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'recovered',
    });
    expect(existsSync(temporary)).toBe(false);
    expect(lstatSync(prepared).nlink).toBe(1);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
  });

  test('refuses separate or externally linked recognized receipt temporaries', async () => {
    const mismatchRoot = root();
    const mismatch = legacyFixture(mismatchRoot);
    const mismatchDigest = manifestDigest(mismatch.manifest);
    mkdirSync(legacyQuarantine(mismatch.home), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      preparedReceiptPath(mismatch.home, mismatchDigest),
      `${JSON.stringify(preparedReceipt(mismatch.manifest))}\n`,
      { mode: 0o600 },
    );
    const separate = ownedTemporaryPath(
      mismatch.home,
      mismatchDigest,
      'receipt',
    );
    writeFileSync(separate, '{separate inode}', { mode: 0o600 });
    await expect(prepareRuntime(mismatch.home, mismatchRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(mismatch.manifest)).toBe(true);
    expect(existsSync(separate)).toBe(true);

    const externalRoot = root();
    const external = legacyFixture(externalRoot);
    const externalDigest = manifestDigest(external.manifest);
    mkdirSync(legacyQuarantine(external.home), {
      recursive: true,
      mode: 0o700,
    });
    const linked = ownedTemporaryPath(external.home, externalDigest, 'receipt');
    writeFileSync(linked, '{external link}', { mode: 0o600 });
    linkSync(linked, join(external.home, 'outside-temporary-link'));
    expect(lstatSync(linked).nlink).toBe(2);
    await expect(prepareRuntime(external.home, externalRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(external.manifest)).toBe(true);
    expect(existsSync(linked)).toBe(true);
  });

  test('refuses committed evidence whose target retains an extra hard link', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const digest = manifestDigest(fixture.manifest);
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    const target = quarantineTarget(fixture.home, digest);
    const extra = `${target}.extra-link`;
    linkSync(target, extra);
    expect(lstatSync(target).nlink).toBe(2);

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(fixture.manifest)).toBe(false);
    expect(existsSync(extra)).toBe(true);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
  });

  test('refuses a persistent prepared receipt with a hard link outside quarantine', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterPreparedBeforeRename: () => {
          throw new Error('prepared receipt for hard-link refusal');
        },
      }),
    ).rejects.toThrow('prepared receipt for hard-link refusal');
    const digest = manifestDigest(fixture.manifest);
    const prepared = preparedReceiptPath(fixture.home, digest);
    const outside = join(fixture.home, 'prepared-receipt-outside-link');
    linkSync(prepared, outside);
    expect(lstatSync(prepared).nlink).toBe(2);

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(fixture.manifest)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(false);
  });

  test.each(['prepared receipt', 'committed marker'] as const)(
    'refuses already evidence when its %s has an external hard link',
    async (record) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      const digest = manifestDigest(fixture.manifest);
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'new',
      });
      const persistent =
        record === 'prepared receipt'
          ? preparedReceiptPath(fixture.home, digest)
          : committedReceiptPath(fixture.home, digest);
      const outside = join(fixture.home, `${record.replace(' ', '-')}-link`);
      linkSync(persistent, outside);
      expect(lstatSync(persistent).nlink).toBe(2);

      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(existsSync(fixture.manifest)).toBe(false);
      expect(existsSync(outside)).toBe(true);
    },
  );

  test('refuses unknown or digest-mismatched temporary evidence without deleting it', async () => {
    const unknownRoot = root();
    const unknown = legacyFixture(unknownRoot);
    const unknownDigest = manifestDigest(unknown.manifest);
    mkdirSync(legacyQuarantine(unknown.home), { recursive: true, mode: 0o700 });
    const invalidName = join(
      legacyQuarantine(unknown.home),
      `.legacy-service-default-${unknownDigest}.receipt.json.not-a-uuid.tmp`,
    );
    writeFileSync(invalidName, '{', { mode: 0o600 });
    await expect(prepareRuntime(unknown.home, unknownRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(invalidName)).toBe(true);
    expect(existsSync(unknown.manifest)).toBe(true);

    const mismatchRoot = root();
    const mismatch = legacyFixture(mismatchRoot);
    mkdirSync(legacyQuarantine(mismatch.home), {
      recursive: true,
      mode: 0o700,
    });
    const mismatched = ownedTemporaryPath(
      mismatch.home,
      'a'.repeat(64),
      'receipt',
    );
    writeFileSync(mismatched, '{', { mode: 0o600 });
    await expect(prepareRuntime(mismatch.home, mismatchRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(mismatched)).toBe(true);
    expect(existsSync(mismatch.manifest)).toBe(true);
  });

  test('refuses oversized sparse manifests, receipts, and recognized temporaries before reading them', async () => {
    const manifestRoot = root();
    const manifest = legacyFixture(manifestRoot);
    truncateSync(manifest.manifest, 64 * 1024 + 1);
    expect(lstatSync(manifest.manifest).size).toBe(64 * 1024 + 1);
    await expect(prepareRuntime(manifest.home, manifestRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(manifest.manifest)).toBe(true);

    const receiptRoot = root();
    const receipt = legacyFixture(receiptRoot);
    await expect(
      quarantineLegacyServiceManifest(receipt.home, receiptRoot, {
        afterPreparedBeforeRename: () => {
          throw new Error('prepared oversized receipt');
        },
      }),
    ).rejects.toThrow('prepared oversized receipt');
    const receiptDigest = manifestDigest(receipt.manifest);
    const prepared = preparedReceiptPath(receipt.home, receiptDigest);
    truncateSync(prepared, 2 * 1024 + 1);
    await expect(prepareRuntime(receipt.home, receiptRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(receipt.manifest)).toBe(true);

    const temporaryRoot = root();
    const temporary = legacyFixture(temporaryRoot);
    const temporaryDigest = manifestDigest(temporary.manifest);
    mkdirSync(legacyQuarantine(temporary.home), {
      recursive: true,
      mode: 0o700,
    });
    const ownedTemporary = ownedTemporaryPath(
      temporary.home,
      temporaryDigest,
      'receipt',
    );
    writeFileSync(ownedTemporary, '{', { mode: 0o600 });
    truncateSync(ownedTemporary, 2 * 1024 + 1);
    await expect(
      prepareRuntime(temporary.home, temporaryRoot),
    ).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(temporary.manifest)).toBe(true);
    expect(existsSync(ownedTemporary)).toBe(true);
  });

  test('caps matching temporary evidence before inspecting its contents', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const digest = manifestDigest(fixture.manifest);
    mkdirSync(legacyQuarantine(fixture.home), { recursive: true, mode: 0o700 });
    for (let index = 0; index < 5; index += 1) {
      const uuid = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      writeFileSync(
        ownedTemporaryPath(fixture.home, digest, 'receipt', uuid),
        Buffer.alloc(2 * 1024 + 1),
        { mode: 0o600 },
      );
    }

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'refused',
    });
    expect(existsSync(fixture.manifest)).toBe(true);
    expect(readdirSync(legacyQuarantine(fixture.home))).toHaveLength(5);
  });

  test('replays exactly one same-inode dual-name prepared move and commits it', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterPreparedBeforeRename: () => {
          throw new Error('prepared for dual-name replay');
        },
      }),
    ).rejects.toThrow('prepared for dual-name replay');
    const digest = manifestDigest(fixture.manifest);
    const target = quarantineTarget(fixture.home, digest);
    linkSync(fixture.manifest, target);
    const sourceBefore = lstatSync(fixture.manifest);
    const targetBefore = lstatSync(target);
    expect(sourceBefore.ino).toBe(targetBefore.ino);
    expect(sourceBefore.nlink).toBe(2);
    expect(manifestDigest(target)).toBe(digest);

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'recovered',
    });
    const targetAfter = lstatSync(target);
    expect(existsSync(fixture.manifest)).toBe(false);
    expect(targetAfter.nlink).toBe(1);
    expect(targetAfter.ino).toBe(targetBefore.ino);
    expect(manifestDigest(target)).toBe(digest);
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
  });

  test.each(['profile', 'birth-live service'] as const)(
    'refuses a prepared dual-name recovery when a current %s authorizes it without unlinking',
    async (authority) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          afterPreparedBeforeRename: () => {
            throw new Error('prepared dual-name authority check');
          },
        }),
      ).rejects.toThrow('prepared dual-name authority check');
      const digest = manifestDigest(fixture.manifest);
      const target = quarantineTarget(fixture.home, digest);
      linkSync(fixture.manifest, target);
      if (authority === 'profile') authorizeLegacyService(stationRoot);
      else publishLiveLegacyService(fixture.home);

      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(existsSync(fixture.manifest)).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(lstatSync(fixture.manifest).nlink).toBe(2);
      expect(lstatSync(target).nlink).toBe(2);
      expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(
        false,
      );
    },
  );

  test.each(['profile', 'birth-live service'] as const)(
    'refuses target-only recovery when a new %s authorizes it',
    async (authority) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      const digest = manifestDigest(fixture.manifest);
      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          afterRenameBeforeCommit: () => {
            throw new Error('target-only authority check');
          },
        }),
      ).rejects.toThrow('target-only authority check');
      const target = quarantineTarget(fixture.home, digest);
      expect(existsSync(fixture.manifest)).toBe(false);
      expect(existsSync(target)).toBe(true);
      if (authority === 'profile') authorizeLegacyService(stationRoot);
      else publishLiveLegacyService(fixture.home);

      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(existsSync(target)).toBe(true);
      expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(
        false,
      );
    },
  );

  test('recovers target-only evidence when no current authority owns it', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    await expect(
      quarantineLegacyServiceManifest(fixture.home, stationRoot, {
        afterRenameBeforeCommit: () => {
          throw new Error('target-only normal recovery');
        },
      }),
    ).rejects.toThrow('target-only normal recovery');
    const target = readdirSync(legacyQuarantine(fixture.home)).find(
      (entry) =>
        entry.endsWith('.json') &&
        !entry.endsWith('.receipt.json') &&
        !entry.endsWith('.committed.json'),
    )!;
    const digest = target.slice(
      'legacy-service-default-'.length,
      -'.json'.length,
    );

    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'recovered',
    });
    expect(existsSync(committedReceiptPath(fixture.home, digest))).toBe(true);
  });

  test.each([
    'different digest',
    'same digest, different inode',
    'more than two links',
  ] as const)(
    'refuses a synthetic dual-name replay with %s',
    async (variant) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          afterPreparedBeforeRename: () => {
            throw new Error('prepared for invalid dual-name replay');
          },
        }),
      ).rejects.toThrow('prepared for invalid dual-name replay');
      const digest = manifestDigest(fixture.manifest);
      const target = quarantineTarget(fixture.home, digest);
      if (variant === 'different digest') {
        writeFileSync(target, '{"different":true}', { mode: 0o600 });
      } else if (variant === 'same digest, different inode') {
        writeFileSync(target, readFileSync(fixture.manifest), { mode: 0o600 });
        expect(lstatSync(target).ino).not.toBe(lstatSync(fixture.manifest).ino);
      } else {
        linkSync(fixture.manifest, target);
        linkSync(fixture.manifest, `${fixture.manifest}.third-link`);
        expect(lstatSync(fixture.manifest).nlink).toBe(3);
      }

      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'refused',
      });
      expect(existsSync(fixture.manifest)).toBe(true);
    },
  );

  test.each(['beforePreparedFsync', 'afterPreparedBeforeRename'] as const)(
    'resumes exact source plus prepared event after %s interruption',
    async (hook) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          [hook]: () => {
            throw new Error(`simulated ${hook}`);
          },
        }),
      ).rejects.toThrow(`simulated ${hook}`);
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'new',
      });
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'already',
      });
    },
  );

  test.each([
    'afterRenameBeforeSourceFsync',
    'afterSourceFsyncBeforeTargetFsync',
    'afterRenameBeforeCommit',
  ] as const)(
    'recovers an exact prepared move after %s interruption',
    async (hook) => {
      const stationRoot = root();
      const fixture = legacyFixture(stationRoot);
      await expect(
        quarantineLegacyServiceManifest(fixture.home, stationRoot, {
          [hook]: () => {
            throw new Error(`simulated ${hook}`);
          },
        }),
      ).rejects.toThrow(`simulated ${hook}`);
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'recovered',
      });
      await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
        kind: 'already',
      });
    },
  );

  test('allows unrelated validated orchestration quarantine siblings', async () => {
    const stationRoot = root();
    const fixture = legacyFixture(stationRoot);
    const orchestration = join(fixture.home, 'quarantine', 'orchestration');
    mkdirSync(orchestration, { recursive: true, mode: 0o700 });
    writeFileSync(join(orchestration, 'kept-event.json'), '{}', {
      mode: 0o600,
    });
    await expect(prepareRuntime(fixture.home, stationRoot)).resolves.toEqual({
      kind: 'new',
    });
    expect(existsSync(join(orchestration, 'kept-event.json'))).toBe(true);
  });

  test('keeps bridge registry liveness birth-aware', () => {
    const home = root();
    const birth = lookupProcessBirthFingerprint(process.pid)!;
    upsertInstance(
      'reused',
      { port: 38141, type: 'sidecar', pid: process.pid, birth: 'old' },
      home,
    );
    upsertInstance(
      'live',
      { port: 38142, type: 'sidecar', pid: process.pid, birth },
      home,
    );
    expect(readRegistryInstances(home)).toEqual([
      expect.objectContaining({ id: 'live', pidAlive: true }),
    ]);
  });

  test('reports EPERM as live-or-ambiguous rather than a dead bridge owner', () => {
    const home = root();
    upsertInstance(
      'protected-sidecar',
      { port: 38141, type: 'sidecar', pid: process.pid, birth: 'old' },
      home,
    );

    expect(
      readRegistryInstances(home, {
        processProbe: unavailableProcessProbe('EPERM'),
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'protected-sidecar',
        pidAlive: true,
      }),
    ]);
  });
});
