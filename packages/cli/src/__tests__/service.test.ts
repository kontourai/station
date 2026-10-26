import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as nodeFs from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, win32 } from 'node:path';
import {
  readInstanceRegistry,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import {
  ensureStationHomeSchemaSync,
  STATION_HOME_SCHEMA_FILE,
} from '@kontourai/station-shared/station-home-schema';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import type { CollectedInstanceStatus } from '../commands/lifecycle.js';
import type { ServiceFs } from '../commands/service.js';
import { plutilJson } from './helpers/launchd-plist-fixture.js';

const makeTempDir = trackTempDirs();

const buildApplication = vi.fn();
const collectInstanceStatus = vi.fn();
const isBuildStale = vi.fn();
const resolveBuildPaths = vi.fn();
const checkSourceBuildStamp = vi.fn();
const stop = vi.fn();
const installLaunchd = vi.fn();
const launchdRegistration = vi.fn();
const legacyLaunchdRegistrations = vi.fn();
const launchdStatus = vi.fn();
const startLaunchd = vi.fn();
const stopLaunchd = vi.fn();
const uninstallLaunchd = vi.fn();
const installSystemd = vi.fn();
const systemdRegistration = vi.fn();
const systemdStatus = vi.fn();
const startSystemd = vi.fn();
const stopSystemd = vi.fn();
const uninstallSystemd = vi.fn();
const installWindowsService = vi.fn();
const assertWindowsServiceExecutionTrusted = vi.fn();
const startWindowsService = vi.fn();
const stopWindowsService = vi.fn();
const uninstallWindowsService = vi.fn();
const windowsRegistration = vi.fn();
const windowsServiceStatus = vi.fn();
const superviseService = vi.fn();

vi.mock('../commands/lifecycle.js', () => ({
  buildApplication,
  collectInstanceStatus,
  isBuildStale,
  resolveBuildPaths,
  checkSourceBuildStamp,
  describeSourceBuildStampProblem: () => null,
  sourceBuildStampNeedsRebuild: () => false,
  stop,
}));
vi.mock('../commands/service-launchd.js', () => ({
  LAUNCHD_INTERACTIVE_PROCESS_TYPE: 'Interactive',
  installLaunchd,
  launchdRegistration,
  legacyLaunchdRegistrations,
  launchdStatus,
  startLaunchd,
  stopLaunchd,
  uninstallLaunchd,
}));
vi.mock('../commands/service-systemd.js', () => ({
  installSystemd,
  systemdRegistration,
  systemdStatus,
  startSystemd,
  stopSystemd,
  uninstallSystemd,
}));
vi.mock('../commands/service-windows.js', () => ({
  WINDOWS_TASK_SETTINGS_EXPECTED:
    'Priority=5, ExecutionTimeLimit=PT0S, RestartCount=255, RestartInterval=PT1M, DisallowStartIfOnBatteries=False, StopIfGoingOnBatteries=False',
  windowsTaskSettingsObservation: () => '',
  assertWindowsServiceExecutionTrusted,
  installWindowsService,
  startWindowsService,
  stopWindowsService,
  uninstallWindowsService,
  windowsRegistration,
  windowsServiceStatus,
}));
vi.mock('../commands/service-run.js', () => ({ superviseService }));
vi.mock('@kontourai/station-shared/node-runtime', () => ({
  assertSupportedNodeVersion: vi.fn(),
}));

const lifecycle = (baseDir: string) => ({
  baseDir,
  homeSource: '--base' as const,
  host: '127.0.0.1',
  instanceName: 'service-test',
  serverPort: 3242,
  uiPort: 5274,
});

// Service installation validates the ancestry of the directory containing the
// Node executable. Keep these unit tests independent of the host runner's Node
// layout (for example, GitHub's hosted tool cache) while retaining the real
// filesystem for manifest behavior.
const serviceFs = {
  ...nodeFs,
  realpathSync: (path: nodeFs.PathLike) =>
    path === process.execPath ? '/usr/bin/node' : nodeFs.realpathSync(path),
} as unknown as ServiceFs;

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  isBuildStale.mockReturnValue(false);
  checkSourceBuildStamp.mockReturnValue({ status: 'current' });
  resolveBuildPaths.mockReturnValue({ server: 'dist-server', ui: 'dist-ui' });
  collectInstanceStatus.mockResolvedValue({
    found: true,
    healthy: true,
    instanceId: 'service-test',
    server: { pid: 10, reachable: true },
    ui: { pid: 11, reachable: true },
  });
  installLaunchd.mockImplementation((instanceId, input) => ({
    host: input.lifecycle.host,
    installedAt: '',
    instanceId,
    label: `io.kontourai.station.${instanceId}`,
    nodePath: input.nodePath,
    platform: 'darwin',
    repoPath: input.repoPath,
    serverPort: input.lifecycle.serverPort,
    uiPort: input.lifecycle.uiPort,
    unitPath: `/tmp/${instanceId}.plist`,
  }));
  launchdRegistration.mockImplementation((instanceId) => ({
    label: `io.kontourai.station.${instanceId}`,
    platform: 'darwin',
    unitPath: `/tmp/${instanceId}.plist`,
  }));
  legacyLaunchdRegistrations.mockImplementation((instanceId) => [
    {
      label: `ai.kontour.command-station.${instanceId}`,
      platform: 'darwin',
      unitPath: `/tmp/legacy-command-${instanceId}.plist`,
    },
    {
      label: `ai.kontour.station.${instanceId}`,
      platform: 'darwin',
      unitPath: `/tmp/legacy-${instanceId}.plist`,
    },
  ]);
  systemdRegistration.mockImplementation((instanceId) => ({
    platform: 'linux',
    unitName: `station-${instanceId}.service`,
    unitPath: `/tmp/station-${instanceId}.service`,
  }));
  windowsRegistration.mockImplementation((instanceId) => ({
    platform: 'win32',
    taskName: `\\KontourStation-${instanceId}`,
    unitPath: `/tmp/${instanceId}.cmd`,
  }));
  installWindowsService.mockImplementation((instanceId, input) => ({
    host: input.lifecycle.host,
    installedAt: '',
    instanceId,
    nodePath: input.nodePath,
    platform: 'win32',
    repoPath: input.repoPath,
    serverPort: input.lifecycle.serverPort,
    taskName: `\\KontourStation-${instanceId}`,
    uiPort: input.lifecycle.uiPort,
    unitPath: `/tmp/${instanceId}.cmd`,
  }));
  launchdStatus.mockReturnValue({ active: true, present: true });
  windowsServiceStatus.mockReturnValue({
    active: true,
    enabled: true,
    present: true,
  });
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

describe('station service dispatch', () => {
  test('sanitizes the Node directory and default PATH entries with ancestry checks', async () => {
    const { captureServicePath } = await import('../commands/service.js');
    const safeInfo = nodeFs.lstatSync('/');
    const unsafeFs = {
      ...nodeFs,
      lstatSync: (path: nodeFs.PathLike) => {
        const value = String(path);
        return Object.assign(Object.create(safeInfo), safeInfo, {
          isDirectory: () => true,
          mode: value === '/opt/unsafe' ? 0o040770 : 0o040755,
          uid: process.getuid?.() ?? safeInfo.uid,
        });
      },
      realpathSync: (path: nodeFs.PathLike) =>
        path === process.execPath ? '/opt/unsafe/bin/node' : String(path),
    } as unknown as ServiceFs;

    expect(() =>
      captureServicePath(
        () => ({ status: 0, stdout: '/usr/bin:/bin\n' }),
        unsafeFs,
      ),
    ).toThrow('Unsafe Node executable directory');

    const unsafeDefaultFs = {
      ...unsafeFs,
      lstatSync: (path: nodeFs.PathLike) => {
        const value = String(path);
        return Object.assign(Object.create(safeInfo), safeInfo, {
          isDirectory: () => true,
          mode: value === '/usr/sbin' ? 0o040777 : 0o040755,
          uid: process.getuid?.() ?? safeInfo.uid,
        });
      },
      realpathSync: (path: nodeFs.PathLike) =>
        path === process.execPath ? '/opt/safe/node' : String(path),
    } as unknown as ServiceFs;
    expect(
      captureServicePath(
        () => ({ status: 0, stdout: '/usr/bin:/bin\n' }),
        unsafeDefaultFs,
      ).split(':'),
    ).not.toContain('/usr/sbin');
  });

  test('dispatches Windows services and rejects ephemeral service commands', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    await runServiceCommand(['status'], lifecycle(baseDir), {
      platform: 'win32',
    });
    expect(windowsServiceStatus).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: '\\KontourStation-service-test' }),
      expect.any(Object),
    );
    for (const action of [
      'install',
      'start',
      'status',
      'stop',
      'uninstall',
      'run',
    ]) {
      await expect(
        runServiceCommand(
          [action],
          { ...lifecycle(baseDir), homeSource: '--temp-home' },
          { platform: 'darwin' },
        ),
      ).rejects.toThrow('--temp-home cannot be used with service commands');
    }
  });

  test('inspects the exact configured service home for target diagnostics', async () => {
    const { inspectServiceInstallation } = await import(
      '../commands/service.js'
    );
    const baseDir = makeTempDir('station-service-target-');
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(serviceDir, 'service-test.json'),
      `${JSON.stringify({
        host: '127.0.0.1',
        installedAt: '2026-08-02T00:00:00.000Z',
        instanceId: 'service-test',
        nodePath: '/usr/bin/node',
        platform: 'win32',
        repoPath: '/opt/station',
        serverPort: 3242,
        taskName: '\\KontourStation-service-test',
        uiPort: 5274,
        unitPath: '/tmp/service-test.cmd',
      })}\n`,
      { mode: 0o600 },
    );

    const inspected = inspectServiceInstallation(lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
    });

    expect(inspected).toMatchObject({
      instanceId: 'service-test',
      manifest: {
        platform: 'win32',
        taskName: '\\KontourStation-service-test',
      },
      unit: { active: true, present: true },
    });
    expect(windowsServiceStatus).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: '\\KontourStation-service-test' }),
      expect.any(Object),
    );
  });

  test('rejects the normalized dogfood identity before every service action', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const action of [
        'install',
        'start',
        'status',
        'stop',
        'uninstall',
        'run',
      ]) {
        await expect(
          runServiceCommand(
            [action],
            { ...lifecycle(baseDir), instanceName: ' DOGFOOD ' },
            { platform },
          ),
        ).rejects.toThrow('reserved for Station dogfood infrastructure');
      }
    }

    await expect(
      runServiceCommand(
        ['status'],
        { ...lifecycle(baseDir), instanceName: 'dog-food' },
        { platform: 'darwin' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      runServiceCommand(
        ['status'],
        { ...lifecycle(baseDir), instanceName: 'dogfood-2' },
        { platform: 'darwin' },
      ),
    ).resolves.toBeUndefined();
  });

  test('refuses a safe manifest that targets the reserved dogfood unit', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        host: '127.0.0.1',
        installedAt: '',
        instanceId: 'service-test',
        nodePath: '/node',
        platform: 'linux',
        repoPath: '/repo',
        serverPort: 3242,
        uiPort: 5274,
        unitName: 'station-dogfood.service',
        unitPath: '/home/user/.config/systemd/user/station-dogfood.service',
      }),
      { mode: 0o600 },
    );

    await expect(
      runServiceCommand(['uninstall'], lifecycle(baseDir), {
        platform: 'linux',
      }),
    ).rejects.toThrow(/manifest conflict.*reserved dogfood identity/u);
    expect(uninstallSystemd).not.toHaveBeenCalled();
    expect(statSync(manifestPath).isFile()).toBe(true);
  });

  test('reports a corrupt pre-existing manifest clearly', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, 'service-test.json'), '{broken', {
      mode: 0o600,
    });

    await expect(
      runServiceCommand(['status'], lifecycle(baseDir), {
        platform: 'darwin',
      }),
    ).rejects.toThrow(/Invalid Station service manifest.*JSON/u);
  });

  test('writes a private manifest and makes reinstall idempotent', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { mode: 0o777 });
    chmodSync(serviceDir, 0o777);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      platform: 'darwin',
      run,
    });
    expect(statSync(join(baseDir, STATION_HOME_SCHEMA_FILE)).isFile()).toBe(
      true,
    );
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      platform: 'darwin',
      run,
    });

    const manifestPath = join(baseDir, 'service', 'service-test.json');
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(statSync(serviceDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
      installedAt: '2026-07-21T12:00:00.000Z',
      instanceId: 'service-test',
      platform: 'darwin',
    });
    expect(installLaunchd).toHaveBeenCalledTimes(2);
  });

  test('persists allowed origins, preserves them across a flagless reinstall, and replaces or clears on request (#1672)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const deps = {
      fs: serviceFs,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      platform: 'darwin' as const,
      run,
    };
    const manifestPath = join(baseDir, 'service', 'service-test.json');
    const origin = 'https://kontour.example.ts.net';

    // Fresh install with the flag: persisted AND rendered into the unit
    // (the installer receives it via lifecycle).
    await runServiceCommand(
      ['install'],
      { ...lifecycle(baseDir), allowedOrigins: [origin] },
      deps,
    );
    expect(
      JSON.parse(readFileSync(manifestPath, 'utf8')).allowedOrigins,
    ).toEqual([origin]);
    expect(
      readInstanceRegistry(baseDir).instances['service-test'],
    ).toMatchObject({
      env: { ALLOWED_ORIGINS: origin },
      port: 3242,
      type: 'service',
      uiPort: 5274,
    });
    expect(
      installLaunchd.mock.calls.at(-1)?.[1].lifecycle.allowedOrigins,
    ).toEqual([origin]);

    // THE permanence rule: a plain reinstall (no flag) preserves the stored
    // origins into both the new manifest and the newly rendered unit.
    await runServiceCommand(['install'], lifecycle(baseDir), deps);
    expect(
      JSON.parse(readFileSync(manifestPath, 'utf8')).allowedOrigins,
    ).toEqual([origin]);
    expect(
      installLaunchd.mock.calls.at(-1)?.[1].lifecycle.allowedOrigins,
    ).toEqual([origin]);

    // Explicit flags replace the stored set.
    const replacement = 'https://other.example.ts.net';
    await runServiceCommand(
      ['install'],
      { ...lifecycle(baseDir), allowedOrigins: [replacement] },
      deps,
    );
    expect(
      JSON.parse(readFileSync(manifestPath, 'utf8')).allowedOrigins,
    ).toEqual([replacement]);

    // --clear-allowed-origins empties the registry and its manifest mirror.
    await runServiceCommand(
      ['install'],
      { ...lifecycle(baseDir), clearAllowedOrigins: true },
      deps,
    );
    const cleared = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(cleared.allowedOrigins).toEqual([]);
    expect(
      readInstanceRegistry(baseDir).instances['service-test']?.env
        ?.ALLOWED_ORIGINS,
    ).toBe('');
    expect(
      installLaunchd.mock.calls.at(-1)?.[1].lifecycle.allowedOrigins,
    ).toEqual([]);
  });

  test('re-validates manifest-sourced origins at install so a hand-edited manifest cannot reach unit content (#1672)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const deps = {
      fs: serviceFs,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      platform: 'darwin' as const,
      run,
    };
    const manifestPath = join(baseDir, 'service', 'service-test.json');

    // Seed a legitimate install, then hand-edit the manifest with a value
    // that passes the shape check (array of strings) but is NOT a bare
    // origin — the exact payload that would otherwise render unchecked into
    // the regenerated unit.
    await runServiceCommand(
      ['install'],
      { ...lifecycle(baseDir), allowedOrigins: ['https://ok.example'] },
      deps,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.allowedOrigins = ['https://evil.example/path"><injected>'];
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

    // Registry authority (#1672 under the instance registry): the legitimate
    // install above wrote the safe origin to instances.json, which is now the
    // durable source. A flagless reinstall reads the REGISTRY, ignores the
    // hand-edited manifest entirely, and re-derives the safe origin — so the
    // injected value can never reach the regenerated unit. The rendered unit
    // and the manifest mirror both carry only the safe value.
    installLaunchd.mockClear();
    await runServiceCommand(['install'], lifecycle(baseDir), deps);
    // The renderer saw only the safe registry-sourced origin, never the
    // injected manifest value.
    expect(installLaunchd).toHaveBeenCalledWith(
      'service-test',
      expect.objectContaining({
        lifecycle: expect.objectContaining({
          allowedOrigins: ['https://ok.example'],
        }),
      }),
    );
    // The manifest mirror is overwritten back to the safe value.
    expect(
      JSON.parse(readFileSync(manifestPath, 'utf8')).allowedOrigins,
    ).toEqual(['https://ok.example']);
  });

  test('re-validates manifest origins during the pre-registry migration bridge, failing closed before any backend mutation (#1672)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const deps = {
      fs: serviceFs,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      platform: 'darwin' as const,
      run,
    };
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { mode: 0o700 });
    const manifestPath = join(serviceDir, 'service-test.json');
    // A shape-valid manifest from a pre-registry install (NO registry entry
    // exists yet), hand-edited with a value that passes the manifest shape
    // check (array of strings) but is NOT a bare origin.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        allowedOrigins: ['https://evil.example/path"><injected>'],
        host: '127.0.0.1',
        installedAt: '2026-08-02T12:00:00.000Z',
        instanceId: 'service-test',
        label: 'io.kontourai.station.service-test',
        nodePath: '/usr/bin/node',
        platform: 'darwin',
        repoPath: '/repo',
        serverPort: 3242,
        uiPort: 5274,
        unitPath: '/tmp/service-test.plist',
      }),
      { mode: 0o600 },
    );

    const installCallsBefore = installLaunchd.mock.calls.length;
    // registryEntry === null → the migration bridge reads the manifest origins
    // and re-validates them, failing closed before the renderer runs.
    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), deps),
    ).rejects.toThrow(/bare origin/);
    expect(installLaunchd.mock.calls.length).toBe(installCallsBefore);
  });

  test('a dead foreign entry no longer suppresses the manifest migration bridge (#3047)', async () => {
    // On main, ANY registry entry suppressed manifest-origin seeding (the
    // chain read `registryEntry === null`), so a home holding only a dead
    // CLI entry installed with []. Origin policy derives from service-typed
    // priors only; a foreign entry is invisible to the bridge — including
    // its fail-closed re-validation, which now also applies here.
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    upsertInstance(
      'service-test',
      { port: 4000, type: 'worktree', pid: 2 ** 31 - 1 },
      baseDir,
    );
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { mode: 0o700 });
    writeFileSync(
      join(serviceDir, 'service-test.json'),
      JSON.stringify({
        allowedOrigins: ['https://paired.example'],
        host: '127.0.0.1',
        installedAt: '2026-08-02T12:00:00.000Z',
        instanceId: 'service-test',
        label: 'io.kontourai.station.service-test',
        nodePath: '/usr/bin/node',
        platform: 'darwin',
        repoPath: '/repo',
        serverPort: 3242,
        uiPort: 5274,
        unitPath: '/tmp/service-test.plist',
      }),
      { mode: 0o600 },
    );

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
    });

    expect(
      readInstanceRegistry(baseDir).instances['service-test'],
    ).toMatchObject({
      type: 'service',
      env: { ALLOWED_ORIGINS: 'https://paired.example' },
    });
  });

  test('service status prints the persisted origins line (#1672)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const deps = {
      fs: serviceFs,
      now: () => new Date('2026-08-02T12:00:00.000Z'),
      platform: 'darwin' as const,
      run,
    };
    await runServiceCommand(
      ['install'],
      {
        ...lifecycle(baseDir),
        allowedOrigins: ['https://kontour.example.ts.net'],
      },
      deps,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status'], lifecycle(baseDir), deps);
      expect(log.mock.calls.map((call) => call[0])).toContain(
        'origins        https://kontour.example.ts.net',
      );
    } finally {
      log.mockRestore();
    }
  });

  test('reports stale launchd scheduling in text and JSON without changing the registration', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    // Installed from a shell without STATION_ROOT, so the recorded root is
    // the one a pasted reinstall derives and the command needs no prefix.
    vi.stubEnv('STATION_ROOT', '');
    const baseDir = makeTempDir('station-service-test-');
    const unitPath = join(baseDir, 'installed.plist');
    const registration = {
      label: 'io.kontourai.station.service-test',
      platform: 'darwin' as const,
      unitPath,
    };
    launchdRegistration.mockReturnValue(registration);
    const { renderLaunchdPlist } = await vi.importActual<
      typeof import('../commands/service-launchd.js')
    >('../commands/service-launchd.js');
    installLaunchd.mockImplementation((instanceId, input) => {
      // The real writer's plist, so the remedy reads the unit's own command.
      writeFileSync(
        unitPath,
        renderLaunchdPlist({
          ...input,
          instanceId,
          label: registration.label,
        }),
      );
      return {
        host: input.lifecycle.host,
        installedAt: '',
        instanceId,
        label: registration.label,
        nodePath: input.nodePath,
        platform: 'darwin',
        repoPath: input.repoPath,
        serverPort: input.lifecycle.serverPort,
        uiPort: input.lifecycle.uiPort,
        unitPath,
      };
    });
    const run = vi.fn((command: string, args: string[]) =>
      command === 'plutil'
        ? { status: 0, stdout: plutilJson(args.at(-1) as string) }
        : { status: 0, stdout: '/usr/bin:/bin\n' },
    );
    await runServiceCommand(
      ['install'],
      {
        ...lifecycle(baseDir),
        allowedOrigins: ['https://station.example.test'],
        features: 'agent-mode,voice',
        host: '0.0.0.0',
        serverPort: 4242,
        uiPort: 5275,
      },
      {
        fs: serviceFs,
        platform: 'darwin',
        run,
      },
    );
    // A unit installed before the Interactive policy.
    writeFileSync(
      unitPath,
      readFileSync(unitPath, 'utf8').replace(
        '<key>ProcessType</key><string>Interactive</string>',
        '<key>ProcessType</key><string>Background</string>',
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      installLaunchd.mockClear();
      startLaunchd.mockClear();
      stopLaunchd.mockClear();
      await runServiceCommand(['status'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run,
      });
      expect(log.mock.calls.flat().join('\n')).toContain(
        'scheduling     stale (ProcessType=Background, expected ProcessType=Interactive)',
      );
      expect(log.mock.calls.flat().join('\n')).toContain(
        `run: station service install --instance=service-test --base=${baseDir} --port=4242 --ui-port=5275 --host=0.0.0.0 --features=agent-mode,voice --allowed-origin=https://station.example.test`,
      );
      expect(installLaunchd).not.toHaveBeenCalled();
      expect(startLaunchd).not.toHaveBeenCalled();
      expect(stopLaunchd).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run,
      });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).scheduling).toEqual(
        {
          expected: 'ProcessType=Interactive',
          observed: 'ProcessType=Background',
          status: 'stale',
        },
      );
      expect(process.exitCode).toBe(1);
      expect(readFileSync(unitPath, 'utf8')).toContain('Background');
    } finally {
      log.mockRestore();
    }
  });

  test('status --json never serializes registry secrets, only identity and allowed origins (#1983)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    // A registry entry whose env carries an operator secret alongside the
    // origins policy. Status output must never disclose the secret.
    upsertInstance(
      'service-test',
      {
        port: 3242,
        uiPort: 5274,
        type: 'service',
        // Legacy registries may still contain this predecessor field. The
        // projection must redact it as completely as env-carried secrets.
        homeCapability: 'home-capability-must-not-leak',
        env: { API_TOKEN: 'super-secret-value', ALLOWED_ORIGINS: 'https://ok' },
      } as any,
      baseDir,
    );
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run,
      });
      const raw = String(log.mock.calls.at(-1)?.[0]);
      // The raw secret and its key never appear anywhere in the output.
      expect(raw).not.toContain('API_TOKEN');
      expect(raw).not.toContain('super-secret-value');
      expect(raw).not.toContain('homeCapability');
      expect(raw).not.toContain('home-capability-must-not-leak');
      const parsed = JSON.parse(raw);
      // Identity is still reported, and env is projected to allowedOrigins only.
      expect(parsed.registry).toMatchObject({
        port: 3242,
        uiPort: 5274,
        type: 'service',
        allowedOrigins: ['https://ok'],
      });
      expect(parsed.registry.env).toBeUndefined();
      expect(parsed.registry.homeCapability).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  test('status shows a launcher-run archive update that needs an operator, with its recovery (#2675 D3)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const installRoot = makeTempDir('station-service-install-');
    mkdirSync(join(installRoot, 'runtime'), { recursive: true });
    // The launcher's record after its last failed restore: it runs no
    // Station, so this is the only place the state can be read.
    writeFileSync(
      join(installRoot, 'runtime', 'service-state.json'),
      JSON.stringify({
        protocol: 1,
        activeVersion: '1.0.0',
        update: {
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          status: 'needs-operator',
          reason: 'candidate-exited:3',
          attempts: 1,
          restoreAttempts: 3,
          finishedAt: '2026-09-27T12:00:00.000Z',
        },
      }),
    );
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { mode: 0o700, recursive: true });
    launchdRegistration.mockReturnValue({
      label: 'io.kontourai.station.service-test',
      platform: 'darwin',
      unitPath: '/tmp/io.kontourai.station.service-test.plist',
    });
    writeFileSync(
      join(serviceDir, 'service-test.json'),
      JSON.stringify({
        host: '127.0.0.1',
        installedAt: '2026-09-01T00:00:00.000Z',
        instanceId: 'service-test',
        kind: 'archive',
        installRoot,
        label: 'io.kontourai.station.service-test',
        nodePath: join(installRoot, 'current', 'runtime', 'bin', 'node'),
        platform: 'darwin',
        repoPath: join(installRoot, 'current'),
        serverPort: 3242,
        uiPort: 5274,
        unitPath: '/tmp/io.kontourai.station.service-test.plist',
      }),
      { mode: 0o600 },
    );
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run,
      });
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain(
        'update         NEEDS OPERATOR: the update to 1.1.0 could not be rolled back; restoring the home failed 3 times (candidate-exited:3).',
      );
      expect(text).toContain(
        'station service stop --instance=service-test && station service start --instance=service-test',
      );
      log.mockClear();
      await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run,
      });
      expect(
        JSON.parse(String(log.mock.calls.at(-1)?.[0])).update,
      ).toMatchObject({
        state: 'needs-operator',
        restoreAttempts: 3,
        targetVersion: '1.1.0',
      });
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
    }
  });

  test('reads and migrates a legacy-labelled manifest on a real upgrade instead of throwing (#1983)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { mode: 0o700, recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    // Post-rename registration reports the NEW command-station identity...
    launchdRegistration.mockReturnValue({
      label: 'io.kontourai.station.service-test',
      platform: 'darwin',
      unitPath: '/tmp/io.kontourai.station.service-test.plist',
    });
    // ...while a prior legacy install left an OLD label on disk. Both retired
    // generations are offered, so a manifest at either one migrates.
    legacyLaunchdRegistrations.mockReturnValue([
      {
        label: 'ai.kontour.command-station.service-test',
        platform: 'darwin',
        unitPath: '/tmp/ai.kontour.command-station.service-test.plist',
      },
      {
        label: 'ai.kontour.station.service-test',
        platform: 'darwin',
        unitPath: '/tmp/ai.kontour.station.service-test.plist',
      },
    ]);
    installLaunchd.mockImplementation((instanceId, input) => ({
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      label: 'io.kontourai.station.service-test',
      nodePath: input.nodePath,
      platform: 'darwin',
      repoPath: input.repoPath,
      serverPort: input.lifecycle.serverPort,
      uiPort: input.lifecycle.uiPort,
      unitPath: '/tmp/io.kontourai.station.service-test.plist',
    }));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        allowedOrigins: ['https://legacy.example'],
        host: '127.0.0.1',
        installedAt: '2026-01-01T00:00:00.000Z',
        instanceId: 'service-test',
        label: 'ai.kontour.station.service-test',
        nodePath: '/usr/bin/node',
        platform: 'darwin',
        repoPath: '/repo',
        serverPort: 3242,
        uiPort: 5274,
        unitPath: '/tmp/ai.kontour.station.service-test.plist',
      }),
      { mode: 0o600 },
    );

    // A legacy manifest must NOT throw a manifest conflict; install migrates it.
    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        now: () => new Date('2026-08-02T12:00:00.000Z'),
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).resolves.toBeDefined();

    expect(installLaunchd).toHaveBeenCalled();
    // The rewritten manifest carries the migrated io.kontourai label.
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).label).toBe(
      'io.kontourai.station.service-test',
    );
    // The legacy manifest origins are migrated into the registry (env preserved).
    expect(
      readInstanceRegistry(baseDir).instances['service-test']?.env
        ?.ALLOWED_ORIGINS,
    ).toBe('https://legacy.example');
  });

  test('does not persist a registry origin change when the backend install fails (#1983)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    installLaunchd.mockImplementationOnce(() => {
      throw new Error('backend install boom');
    });

    await expect(
      runServiceCommand(
        ['install'],
        { ...lifecycle(baseDir), allowedOrigins: ['https://new.example'] },
        {
          fs: serviceFs,
          platform: 'darwin',
          run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
        },
      ),
    ).rejects.toThrow('backend install boom');

    // A failed install never persists a new origin policy: instances.json is
    // untouched, so a later flagless reinstall cannot activate it.
    expect(readInstanceRegistry(baseDir).instances).toEqual({});
  });

  test('refuses install while a live process owns the instance id (#3047)', async () => {
    // The default×default path: `station start` registered this id from some
    // checkout and is still running. Installing used to upsert-merge over
    // that entry, producing a `type: 'service'` chimera carrying the CLI
    // process's pid/birth — which Desktop's home-ownership decision read as
    // a live service. The pre-check refuses BEFORE any backend mutation.
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    upsertInstance(
      'service-test',
      {
        port: 4000,
        type: 'worktree',
        pid: process.pid,
        checkout: '/other/checkout',
      },
      baseDir,
    );

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow(/owned by a live process/);

    // Refused before the backend was touched, and the live owner's entry
    // survives byte-for-byte.
    expect(installLaunchd).not.toHaveBeenCalled();
    expect(readInstanceRegistry(baseDir).instances['service-test']).toEqual({
      port: 4000,
      type: 'worktree',
      pid: process.pid,
      checkout: '/other/checkout',
    });
  });

  // #2961 (ADR 0020 D4): a home has one live host. A live Desktop sidecar
  // holds it under a DIFFERENT id, which the per-id #3047 guard never saw.
  const liveDesktopSidecar = (baseDir: string) =>
    upsertInstance(
      'desktop-sidecar-4242',
      {
        port: 38141,
        type: 'sidecar',
        status: 'running',
        pid: process.pid,
        birth: lookupProcessBirthFingerprint(process.pid)!,
      },
      baseDir,
    );

  test('refuses install while a live Desktop sidecar owns the home (#2961)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    liveDesktopSidecar(baseDir);
    const before = readInstanceRegistry(baseDir);

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow(
      `Station service 'service-test' cannot own Station home ${baseDir}: it is in use by Station Desktop's built-in server (registry id 'desktop-sidecar-4242', pid ${process.pid}). Quit Station Desktop so the background service can own this home, or install the service for a different home.`,
    );
    expect(installLaunchd).not.toHaveBeenCalled();
    expect(readInstanceRegistry(baseDir)).toEqual(before);
  });

  test('fences a fresh install before backend start races a Desktop claim (#2961)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { superviseService: realSupervisor } = await vi.importActual<
      typeof import('../commands/service-run.js')
    >('../commands/service-run.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const installBackend = installLaunchd.getMockImplementation()!;
    let host: ChildProcess | undefined;
    let hostPort: Promise<number> | undefined;
    const start = vi.fn(async () => {
      host = spawn(
        process.execPath,
        [
          '-e',
          "require('node:http').createServer((req,res) => res.end('service-host')).listen(0,'127.0.0.1', function() {console.log(this.address().port)});",
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      hostPort = once(host.stdout!, 'data').then(([data]) =>
        Number(String(data).trim()),
      );
    });
    let supervision: Promise<void> | undefined;
    const supervisorExit = vi.fn();
    const supervisorStop = vi.fn();
    installLaunchd.mockImplementationOnce((instanceId, input) => {
      // Real supervisor starts at the OS-backend seam, before install returns.
      supervision = realSupervisor(lifecycle(baseDir), {
        start,
        stop: supervisorStop,
        exit: supervisorExit,
        onSignal: vi.fn(),
        needsBuildForInstance: () => false,
        collect: vi.fn(
          async (): Promise<CollectedInstanceStatus> => ({
            found: true,
            healthy: true,
            bootId: 'boot',
            sha: 'sha',
            instanceId: 'service-test',
            server: {
              pid: host?.pid ?? null,
              probe: 'ok',
              listening: true,
              reachable: true,
            },
            ui: {
              pid: host?.pid ?? null,
              probe: 'ok',
              listening: true,
              reachable: true,
            },
          }),
        ),
        setTimer: vi.fn(() => 1 as never),
      });
      const sidecar = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'src-server/tools/instance-registry-bridge.ts',
          'claimSidecar',
        ],
        {
          windowsHide: true,
          encoding: 'utf8',
          input: JSON.stringify({
            home: baseDir,
            id: 'racing-desktop',
            instance: { type: 'sidecar', port: 38141, status: 'starting' },
          }),
        },
      );
      expect(sidecar.status).toBe(0);
      expect(
        JSON.parse(sidecar.stdout).claimed,
        'backend must already be fenced against Desktop',
      ).toBe(false);
      return installBackend(instanceId, input);
    });
    try {
      await runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      });
      await supervision;
      const port = await hostPort!;
      expect(port).toBeGreaterThan(0);
      expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
        'service-host',
      );
      expect(start).toHaveBeenCalledTimes(1);
      expect(supervisorExit).not.toHaveBeenCalled();
      expect(supervisorStop).not.toHaveBeenCalled();
      expect(Object.keys(readInstanceRegistry(baseDir).instances)).toEqual([
        'service-test',
      ]);
    } finally {
      if (host) {
        const exited = once(host, 'exit');
        host.kill();
        await exited;
      }
    }
  });

  // station#2689: from a source checkout the launcher selects the development
  // channel and exports the checkout's derived dev identity, so a home left to
  // its default is that dev instance's home. The entry-point suite
  // (service-dev-home-entry-points.test.ts) drives these through the real
  // parsers; this block pins the service-layer rule itself.
  describe('development-home identity (station#2689)', () => {
    const devInstanceId = 'dev-release-0d57e82-1a2b3c4d';
    const devLifecycle = (baseDir: string, instanceName?: string) => ({
      ...lifecycle(baseDir),
      homeSource: 'default' as const,
      instanceName,
    });
    const install = async (
      input: ReturnType<typeof devLifecycle> | ReturnType<typeof lifecycle>,
    ) => {
      const { runServiceCommand } = await import('../commands/service.js');
      return runServiceCommand(['install'], input, {
        fs: serviceFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }).then(
        () => null,
        (error: Error) => error,
      );
    };

    beforeEach(() => {
      vi.stubEnv('STATION_CHANNEL', 'development');
      vi.stubEnv('STATION_INSTANCE_ID', devInstanceId);
      // Readiness must observe whichever instance id this install resolved.
      collectInstanceStatus.mockImplementation(async (instanceId: string) => ({
        found: true,
        healthy: true,
        instanceId,
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      }));
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test('refuses an explicit non-dev instance on the implicit dev home before touching it', async () => {
      const devHome = join(
        makeTempDir('station-service-test-'),
        'instances',
        'dev',
        devInstanceId,
      );

      const failure = await install(devLifecycle(devHome, 'default'));

      expect(
        failure,
        'install must refuse the borrowed dev home',
      ).toBeInstanceOf(Error);
      expect(failure!.message).toBe(
        [
          `Refusing to install Station user service default into this source checkout's development home ${devHome}.`,
          `That home belongs to the development instance ${devInstanceId}; it was chosen because no --home, --base, or STATION_HOME was given.`,
          `  --instance=${devInstanceId}  names the service after the home it runs in.`,
          `  --instance=default --base=${devHome}  keeps an existing default service where it is.`,
          '  --instance=default --home=<dir>  moves the default service to its own durable home (data in the current home is not copied).',
        ].join('\n'),
      );
      // Refused before the home schema was established or a backend touched.
      expect(nodeFs.existsSync(devHome)).toBe(false);
      expect(installLaunchd).not.toHaveBeenCalled();
    });

    test('without --instance the service takes the dev id, including a port-derived id', async () => {
      await install(devLifecycle(makeTempDir('station-service-test-')));
      expect(installLaunchd).toHaveBeenLastCalledWith(
        devInstanceId,
        expect.anything(),
      );
      // Custom ports would otherwise hash to `instance-<hash>`.
      await install({
        ...devLifecycle(makeTempDir('station-service-test-')),
        serverPort: 45_111,
        uiPort: 45_222,
      });
      expect(installLaunchd).toHaveBeenLastCalledWith(
        devInstanceId,
        expect.objectContaining({
          lifecycle: expect.objectContaining({
            serverPort: 45_111,
            uiPort: 45_222,
          }),
        }),
      );
    });

    test('keeps explicit dev id, explicit home, and non-dev channel installs as named', async () => {
      await install(
        devLifecycle(makeTempDir('station-service-test-'), devInstanceId),
      );
      expect(installLaunchd).toHaveBeenLastCalledWith(
        devInstanceId,
        expect.anything(),
      );

      await install({
        ...lifecycle(makeTempDir('station-service-test-')),
        instanceName: 'default',
      });
      expect(installLaunchd).toHaveBeenLastCalledWith(
        'default',
        expect.anything(),
      );

      vi.stubEnv('STATION_CHANNEL', 'stable');
      await install(
        devLifecycle(makeTempDir('station-service-test-'), 'default'),
      );
      expect(installLaunchd).toHaveBeenLastCalledWith(
        'default',
        expect.anything(),
      );
      expect(installLaunchd).toHaveBeenCalledTimes(3);
    });

    test.each(['worktree', 'service'] as const)(
      'refuses when a live %s entry already owns the same dev home under the lifecycle id',
      async (type) => {
        // `./station start` from this checkout, or another checkout's service
        // in a shared dev home, holds it as `default`; the dev-id service would
        // be a second writer on it.
        const devHome = makeTempDir('station-service-test-');
        const { CWD, resolveLifecycleInstanceId } = await import(
          '../commands/helpers.js'
        );
        const lifecycleId = resolveLifecycleInstanceId({
          cwd: CWD,
          projectHome: devHome,
          serverPort: 3242,
          uiPort: 5274,
        });
        ensureStationHomeSchemaSync(devHome);
        upsertInstance(
          lifecycleId,
          { port: 4000, type, pid: process.pid, checkout: '/co' },
          devHome,
        );

        const failure = await install(devLifecycle(devHome));

        expect(failure?.message).toBe(
          `Station home ${devHome} is in use by instance '${lifecycleId}' (pid ${process.pid}, type '${type}', from /co), which service '${devInstanceId}' would share. Stop it first (\`station stop --instance=${lifecycleId}\` from its checkout).`,
        );
        expect(installLaunchd).not.toHaveBeenCalled();
      },
    );
  });

  test('reinstalls over its OWN live service entry (#3064 regression guard)', async () => {
    // Once the supervisor publishes a real pid (#3064), the #3047 live-owner
    // pre-check would refuse every reinstall of a RUNNING service — the
    // ordinary upgrade path — unless ownership is type-aware. A live
    // service-typed entry at this id is this unit's own supervisor, which
    // the backend install protocol stops and replaces itself.
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    upsertInstance(
      'service-test',
      {
        port: 3242,
        type: 'service',
        pid: process.pid,
        // The REAL fingerprint, not a placeholder: a wrong birth makes
        // birthProvesReuse report pid reuse, the entry stops reading as a
        // live owner, and the guard under test is never reached. Injection
        // proved that — removing `adoptTypes` left this test green.
        birth: lookupProcessBirthFingerprint(process.pid) ?? undefined,
        status: 'running',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      baseDir,
    );

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
    });

    expect(installLaunchd).toHaveBeenCalled();
    const entry = readInstanceRegistry(baseDir).instances['service-test'];
    // Policy publication must not erase a supervisor that is still live:
    // it may have claimed while the backend was being installed.
    expect(entry.pid).toBe(process.pid);
    expect(entry.birth).toBe(lookupProcessBirthFingerprint(process.pid));
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
  });

  test('replaces a dead CLI entry with a clean service record — nothing inherited (#3047)', async () => {
    // The chimera pin at the wiring level: a crashed CLI instance's leftover
    // entry must not block the install, and the resulting service entry must
    // carry NONE of the dead entry's fields (pid/birth/checkout/status) —
    // an inherited pid is exactly what flipped Desktop's ownership decision.
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    upsertInstance(
      'service-test',
      {
        port: 4000,
        type: 'worktree',
        pid: 2 ** 31 - 1,
        birth: 'stale-birth',
        checkout: '/dead/checkout',
        status: 'running',
        // Env inheritance is the same chimera class through a different
        // field: a foreign entry's env must neither seed ALLOWED_ORIGINS
        // nor be carried into the service record.
        env: { ALLOWED_ORIGINS: 'https://stale.example' },
      },
      baseDir,
    );

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
    });

    const entry = readInstanceRegistry(baseDir).instances['service-test'];
    expect(entry).toEqual({
      port: 3242,
      uiPort: 5274,
      type: 'service',
      status: 'installing',
      pid: process.pid,
      birth: lookupProcessBirthFingerprint(process.pid),
      env: { ALLOWED_ORIGINS: '' },
    });
    expect(entry.checkout).toBeUndefined();
  });

  test('rejects a manifest whose allowedOrigins field is malformed (#1672)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { mode: 0o700, recursive: true });
    writeFileSync(
      join(serviceDir, 'service-test.json'),
      JSON.stringify({
        allowedOrigins: 'https://not-an-array.example',
        host: '127.0.0.1',
        installedAt: '2026-08-02T12:00:00.000Z',
        instanceId: 'service-test',
        label: 'io.kontourai.station.service-test',
        nodePath: '/usr/bin/node',
        platform: 'darwin',
        repoPath: '/repo',
        serverPort: 3242,
        uiPort: 5274,
        unitPath: '/tmp/service-test.plist',
      }),
      { mode: 0o600 },
    );
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await expect(
      runServiceCommand(['status'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'darwin',
        run,
      }),
    ).rejects.toThrow(/Invalid Station service manifest/);
  });

  test('installs, starts, stops, and uninstalls the Windows backend', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
      run,
    });
    expect(statSync(join(baseDir, STATION_HOME_SCHEMA_FILE)).isFile()).toBe(
      true,
    );
    await runServiceCommand(['start'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
      run,
    });
    windowsServiceStatus.mockReturnValue({
      active: false,
      enabled: true,
      present: true,
    });
    collectInstanceStatus.mockResolvedValueOnce({
      found: false,
      healthy: false,
      instanceId: 'service-test',
      server: { pid: null, reachable: false },
      ui: { pid: null, reachable: false },
    });
    await runServiceCommand(['stop'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
      run,
      sleep: vi.fn(),
    });
    await runServiceCommand(['uninstall'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
      run,
    });
    expect(installWindowsService).toHaveBeenCalledOnce();
    expect(startWindowsService).not.toHaveBeenCalled();
    expect(stopWindowsService).not.toHaveBeenCalled();
    // uninstall retains its explicit lifecycle cleanup; idempotent `stop`
    // itself did not invoke the Windows platform Adapter above.
    expect(stop).toHaveBeenCalledWith({
      instanceName: 'service-test',
      stateHome: baseDir,
    });
    expect(uninstallWindowsService).toHaveBeenCalledOnce();
  });

  test('converges the exact Windows instance before reinstalling its task', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
      run,
    });
    let active = true;
    stop.mockImplementation(() => {
      active = false;
    });
    collectInstanceStatus
      .mockResolvedValueOnce({
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      })
      .mockResolvedValueOnce({
        found: false,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: null, reachable: false },
        ui: { pid: null, reachable: false },
      });
    windowsServiceStatus.mockImplementation(() => ({
      active,
      enabled: true,
      present: true,
    }));

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'win32',
      run,
      sleep: vi.fn(),
    });

    expect(stop).toHaveBeenCalledWith({
      instanceName: 'service-test',
      stateHome: baseDir,
    });
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      installWindowsService.mock.invocationCallOrder[1],
    );
  });

  test('reconciles an orphan registration without a manifest on status and uninstall', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
      platform: 'darwin',
    });
    // An orphan registration (a backend job with no manifest and no prior
    // install) has no registry entry: the registry is written only by install,
    // so status truthfully reports registry: null rather than synthesizing one.
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      healthy: false,
      installed: true,
      registry: null,
    });
    expect(process.exitCode).toBe(1);

    await runServiceCommand(['uninstall'], lifecycle(baseDir), {
      platform: 'darwin',
    });
    expect(uninstallLaunchd).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'io.kontourai.station.service-test' }),
      expect.any(Object),
    );
    expect(stop).toHaveBeenCalledWith({
      instanceName: 'service-test',
      stateHome: baseDir,
    });
  });

  test('reports active or enabled registrations without a manifest as unhealthy orphans', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const unit of [
      { active: true, present: false },
      { active: false, enabled: true, present: false },
    ]) {
      const baseDir = makeTempDir('station-service-test-');
      launchdStatus.mockReturnValue(unit);
      await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
        platform: 'darwin',
      });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        healthy: false,
        installed: true,
        manifest: null,
        unit,
      });
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
    }
    log.mockRestore();
  });

  test('fails closed when scheduling policy cannot be read', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn((command: string) =>
      command === 'plutil'
        ? { status: 1, stderr: 'plutil unavailable' }
        : { status: 0, stdout: '/usr/bin:/bin\n' },
    );
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });
    const manifest = JSON.parse(
      readFileSync(join(baseDir, 'service', 'service-test.json'), 'utf8'),
    );
    const unit = {
      active: true,
      error: null,
      label: 'io.kontourai.station.service-test',
      present: true,
    };
    const instanceStatus = {
      bootId: 'boot-1',
      found: true,
      healthy: true,
      instanceId: 'service-test',
      server: { listening: true, pid: 10, probe: 'ok', reachable: true },
      sha: 'sha-1',
      ui: { listening: true, pid: 11, probe: 'ok', reachable: true },
    };
    launchdStatus.mockReturnValue(unit);
    collectInstanceStatus.mockResolvedValue(instanceStatus);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      healthy: false,
      installed: true,
      instance: instanceStatus,
      manifest,
      registry: {
        allowedOrigins: [],
        pid: process.pid,
        status: 'installing',
        port: 3242,
        type: 'service',
        uiPort: 5274,
      },
      scheduling: {
        expected: 'ProcessType=Interactive',
        reason: 'plutil unavailable',
        status: 'unknown',
      },
      // The same unreadable plist leaves the captured PATH unknown too.
      servicePath: {
        missing: [],
        reason: 'the installed unit could not be read: plutil unavailable',
        stale: [],
        status: 'unknown',
      },
      unit,
    });
    expect(process.exitCode).toBe(1);
    log.mockRestore();
  });

  test('treats a systemd operator override as healthy without a reinstall remedy', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const unitPath = join(baseDir, 'station-service-test.service');
    const registration = {
      platform: 'linux' as const,
      unitName: 'station-service-test.service',
      unitPath,
    };
    systemdRegistration.mockReturnValue(registration);
    installSystemd.mockImplementation((instanceId, input) => ({
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      nodePath: input.nodePath,
      platform: 'linux',
      repoPath: input.repoPath,
      serverPort: input.lifecycle.serverPort,
      uiPort: input.lifecycle.uiPort,
      unitName: registration.unitName,
      unitPath,
    }));
    systemdStatus.mockReturnValue({
      active: true,
      enabled: true,
      present: true,
    });
    const run = vi.fn((_command: string, args: string[]) => ({
      status: 0,
      stdout:
        args[1] === 'cat'
          ? `# ${unitPath}\n[Service]\nExecStart=/station\n# /etc/systemd/user/station-.service.d/override.conf\n[Service]\nNice=10\n`
          : '/usr/bin:/bin\n',
    }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'linux',
      run,
    });
    writeFileSync(unitPath, '[Service]\nExecStart=/station\n');
    const overridePath = '/etc/systemd/user/station-.service.d/override.conf';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'linux',
        run,
      });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        healthy: true,
        scheduling: {
          observed: `Nice=10 (from ${overridePath})`,
          status: 'operator-override',
        },
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });

  // #2663: the unit's PATH is frozen at install. These drive `service status`
  // against the unit the real systemd/launchd writer renders, with the login
  // shell answering in the exact marker shape `collectServicePathCandidates`
  // asks for.
  describe('service PATH drift (#2663)', () => {
    const loginShellAnswer = (path: string) => ({
      status: 0,
      stdout: `__STATION_SERVICE_PATH__${path}__STATION_SERVICE_PATH__\n`,
    });

    async function installLinuxService(
      baseDir: string,
      loginPath: () => string,
    ) {
      vi.stubEnv('STATION_ROOT', '');
      const { renderSystemdUnit } = await vi.importActual<
        typeof import('../commands/service-systemd.js')
      >('../commands/service-systemd.js');
      const unitPath = join(baseDir, 'station-service-test.service');
      const registration = {
        platform: 'linux' as const,
        unitName: 'station-service-test.service',
        unitPath,
      };
      systemdRegistration.mockReturnValue(registration);
      installSystemd.mockImplementation((instanceId, input) => {
        writeFileSync(
          unitPath,
          renderSystemdUnit({
            instanceId,
            lifecycle: input.lifecycle,
            nodePath: input.nodePath,
            repoPath: input.repoPath,
            servicePath: input.servicePath,
          }),
        );
        return {
          host: input.lifecycle.host,
          installedAt: '',
          instanceId,
          nodePath: input.nodePath,
          platform: 'linux',
          repoPath: input.repoPath,
          serverPort: input.lifecycle.serverPort,
          uiPort: input.lifecycle.uiPort,
          unitName: registration.unitName,
          unitPath,
        };
      });
      systemdStatus.mockReturnValue({
        active: true,
        enabled: true,
        present: true,
      });
      const run = vi.fn(
        (
          command: string,
          args: string[],
          _options?: Record<string, unknown>,
        ) => {
          if (command === 'systemctl' && args[1] === 'cat') {
            return {
              status: 0,
              stdout: `# ${unitPath}\n${readFileSync(unitPath, 'utf8')}`,
            };
          }
          if (args[0] === '-l' && args[1] === '-c') {
            return loginShellAnswer(loginPath());
          }
          return { status: 0, stdout: '' };
        },
      );
      await runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'linux',
        run,
      });
      return { run, unitPath };
    }

    let runServiceCommand: typeof import('../commands/service.js').runServiceCommand;
    beforeEach(async () => {
      ({ runServiceCommand } = await import('../commands/service.js'));
    });

    test('names login-shell directories the installed systemd unit lacks, and unit directories it no longer has', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const localBin = join(makeTempDir('station-service-home-'), '.local-bin');
      mkdirSync(localBin);
      const oldGeneration = makeTempDir('station-service-hm-old-');
      let loginPath = `${oldGeneration}:/usr/bin:/bin`;
      const { run, unitPath } = await installLinuxService(
        baseDir,
        () => loginPath,
      );
      const realLocalBin = nodeFs.realpathSync(localBin);
      const realOldGeneration = nodeFs.realpathSync(oldGeneration);
      // The fixture is the writer's own output: the unit carries the PATH the
      // install captured, and not the directory added afterwards.
      expect(readFileSync(unitPath, 'utf8')).toContain(realOldGeneration);
      expect(readFileSync(unitPath, 'utf8')).not.toContain(realLocalBin);

      loginPath = `${localBin}:/usr/bin:/bin`;
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        const text = log.mock.calls.flat().join('\n');
        expect(text).toContain(
          'service PATH   drifted (captured at install; a reinstall would capture a different PATH now)',
        );
        expect(text).toContain(
          `               missing from the unit: ${realLocalBin}`,
        );
        expect(text).toContain(
          `               no longer captured: ${realOldGeneration}`,
        );
        expect(text).toContain(
          '               run: station service install --instance=service-test',
        );
        // Drift is advice, not a health failure.
        expect(process.exitCode).toBeUndefined();

        await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        expect(
          JSON.parse(String(log.mock.calls.at(-1)?.[0])).servicePath,
        ).toEqual({
          missing: [realLocalBin],
          stale: [realOldGeneration],
          status: 'drifted',
        });
        expect(process.exitCode).toBeUndefined();
      } finally {
        log.mockRestore();
      }
    });

    test('reports current when the login-shell PATH still matches the unit', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const localBin = makeTempDir('station-service-bin-');
      const { run } = await installLinuxService(
        baseDir,
        () => `${localBin}:/usr/bin:/bin`,
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        const text = log.mock.calls.flat().join('\n');
        expect(text).toContain(
          'service PATH   current (matches your login-shell PATH)',
        );
        expect(text).not.toContain('missing from the unit');
      } finally {
        log.mockRestore();
      }
    });

    test('claims nothing when the login shell cannot be run and PATH is empty', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const localBin = makeTempDir('station-service-bin-');
      const { run } = await installLinuxService(
        baseDir,
        () => `${localBin}:/usr/bin:/bin`,
      );
      const { defaultRun } = await import('../commands/service.js');
      // The real spawn of a shell that does not exist, with no PATH to fall
      // back on: the comparison has no login-shell answer to stand on.
      vi.stubEnv('SHELL', join(baseDir, 'no-such-shell'));
      vi.stubEnv('PATH', '');
      const absentShellRun = vi.fn(
        (command: string, args: string[], options?: Record<string, unknown>) =>
          args[0] === '-l' && args[1] === '-c'
            ? defaultRun(command, args, options)
            : run(command, args),
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run: absentShellRun,
        });
        expect(
          absentShellRun.mock.calls.some(
            ([command]) => command === join(baseDir, 'no-such-shell'),
          ),
        ).toBe(true);
        expect(
          JSON.parse(String(log.mock.calls.at(-1)?.[0])).servicePath,
        ).toEqual({
          missing: [],
          reason: 'your login shell did not report its PATH',
          stale: [],
          status: 'unknown',
        });
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run: absentShellRun,
        });
        const text = log.mock.calls.flat().join('\n');
        expect(text).toContain(
          'service PATH   unknown (your login shell did not report its PATH)',
        );
        expect(text).not.toContain('missing from the unit');
      } finally {
        log.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    test('reports a reordering of the same directories, since order decides which binary wins', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const first = makeTempDir('station-service-first-');
      const second = makeTempDir('station-service-second-');
      let loginPath = `${first}:${second}:/usr/bin:/bin`;
      const { run } = await installLinuxService(baseDir, () => loginPath);
      loginPath = `${second}:${first}:/usr/bin:/bin`;
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        const realFirst = nodeFs.realpathSync(first);
        const realSecond = nodeFs.realpathSync(second);
        // Shared position 2: the real Node directory (dirname of realpath(execPath)) leads both.
        const drift = JSON.parse(
          String(log.mock.calls.at(-1)?.[0]),
        ).servicePath;
        expect(drift).toEqual({
          missing: [],
          reordered: { current: realSecond, position: 1, unit: realFirst },
          stale: [],
          status: 'drifted',
        });
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        const text = log.mock.calls.flat().join('\n');
        expect(text).toContain(
          `               same directories in a different order (first difference at shared position 2: the unit has ${realFirst}, a reinstall would put ${realSecond})`,
        );
        expect(text).not.toContain('current (matches your login-shell PATH)');
      } finally {
        log.mockRestore();
      }
    });

    test('round-trips PATH directories containing a space, a quote and a backslash through the real unit', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const awkward = join(
        makeTempDir('station-service-home-'),
        'we ird"dir\\x',
      );
      mkdirSync(awkward);
      const { run, unitPath } = await installLinuxService(
        baseDir,
        () => `${awkward}:/usr/bin:/bin`,
      );
      // The writer's own escaping, not a hand-made fixture.
      expect(readFileSync(unitPath, 'utf8')).toContain('we ird\\"dir\\\\x');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        expect(
          JSON.parse(String(log.mock.calls.at(-1)?.[0])).servicePath,
        ).toEqual({ missing: [], stale: [], status: 'current' });
      } finally {
        log.mockRestore();
      }
    });

    test('treats a spawn error beside status 0 (a timed-out shell) as no answer', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const localBin = makeTempDir('station-service-bin-');
      const { run } = await installLinuxService(
        baseDir,
        () => `${localBin}:/usr/bin:/bin`,
      );
      const timedOutRun = vi.fn((command: string, args: string[]) =>
        args[0] === '-l' && args[1] === '-c'
          ? {
              ...loginShellAnswer('/usr/bin:/bin'),
              error: Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), {
                code: 'ETIMEDOUT',
              }),
            }
          : run(command, args),
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run: timedOutRun,
        });
        expect(
          JSON.parse(String(log.mock.calls.at(-1)?.[0])).servicePath,
        ).toMatchObject({
          reason: 'your login shell did not report its PATH',
          status: 'unknown',
        });
      } finally {
        log.mockRestore();
      }
    });

    test('bounds the status login shell with a SIGKILL timeout', async () => {
      const baseDir = makeTempDir('station-service-test-');
      const localBin = makeTempDir('station-service-bin-');
      const { run } = await installLinuxService(
        baseDir,
        () => `${localBin}:/usr/bin:/bin`,
      );
      run.mockClear();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
      } finally {
        log.mockRestore();
      }
      const shellCalls = run.mock.calls.filter(
        ([, args]) => args[0] === '-l' && args[1] === '-c',
      );
      expect(shellCalls).toHaveLength(1);
      expect(shellCalls[0][2]).toMatchObject({
        killSignal: 'SIGKILL',
        timeout: 5_000,
      });
    });

    test.skipIf(process.platform === 'win32')(
      'a login shell that ignores SIGTERM is still stopped at the cap',
      async () => {
        const { defaultRun } = await import('../commands/service.js');
        const { collectServicePathCandidates } = await import(
          '../commands/service-path.js'
        );
        const shell = join(makeTempDir('station-service-shell-'), 'stubborn');
        // Ignored dispositions survive exec, so the sleeping process itself
        // ignores TERM and only SIGKILL ends it before 10s.
        writeFileSync(shell, "#!/bin/sh\ntrap '' TERM\nexec sleep 10\n");
        chmodSync(shell, 0o755);
        vi.stubEnv('SHELL', shell);
        const started = Date.now();
        const result = collectServicePathCandidates(defaultRun, serviceFs, {
          timeoutMs: 300,
        });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(result.loginShell).toBe(false);
      },
      15_000,
    );

    test('prefixes the recorded STATION_ROOT and prints the shared remedy once', async () => {
      const root = makeTempDir('station-service-root-');
      const baseDir = makeTempDir('station-service-test-');
      const localBin = makeTempDir('station-service-bin-');
      const oldGeneration = makeTempDir('station-service-hm-old-');
      let loginPath = `${oldGeneration}:/usr/bin:/bin`;
      const { run: installRun, unitPath } = await installLinuxService(
        baseDir,
        () => loginPath,
      );
      // installLinuxService installs from a shell without STATION_ROOT; redo
      // the install from one that carries an operator root.
      vi.stubEnv('STATION_ROOT', root);
      await runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'linux',
        run: installRun,
      });
      expect(readFileSync(unitPath, 'utf8')).toContain(
        `Environment="STATION_ROOT=${root}"`,
      );
      // The operator reads status from a shell without it.
      vi.stubEnv('STATION_ROOT', '');
      loginPath = `${localBin}:/usr/bin:/bin`;
      // A Nice= in the main fragment makes scheduling stale too.
      const run = vi.fn((command: string, args: string[]) =>
        command === 'systemctl' && args[1] === 'cat'
          ? {
              status: 0,
              stdout: `# ${unitPath}\n${readFileSync(unitPath, 'utf8')}\n[Service]\nNice=10\n`,
            }
          : installRun(command, args),
      );
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        const lines = log.mock.calls.flat().map(String);
        expect(lines).toContain(
          'scheduling     stale (Nice=10, expected systemd defaults)',
        );
        expect(lines.join('\n')).toContain('service PATH   drifted');
        const runLines = lines.filter((line) => line.includes('run: '));
        expect(runLines).toEqual([
          `               run: STATION_ROOT=${root} station service install --instance=service-test --base=${baseDir} --port=3242 --ui-port=5274 --host=127.0.0.1`,
        ]);
      } finally {
        log.mockRestore();
      }
    });

    test('explains a missing remedy when drift is found but the root cannot be reproduced', async () => {
      const baseDir = join(
        makeTempDir('station-service-root-'),
        'instances',
        'blue',
      );
      mkdirSync(baseDir, { mode: 0o700, recursive: true });
      const localBin = makeTempDir('station-service-bin-');
      let loginPath = '/usr/bin:/bin';
      const { run, unitPath } = await installLinuxService(
        baseDir,
        () => loginPath,
      );
      // A unit written before the root was recorded: a reinstall of this
      // instances/ home would now set STATION_ROOT, which a pasted command
      // cannot undo. The remedy reads the unit (#4189), so the unit is what
      // lacks it.
      const unit = readFileSync(unitPath, 'utf8');
      expect(unit).toMatch(/^Environment="STATION_ROOT=.+"$/mu);
      writeFileSync(
        unitPath,
        unit.replace(/^Environment="STATION_ROOT=.*"\n/mu, ''),
      );
      loginPath = `${localBin}:/usr/bin:/bin`;
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(['status'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'linux',
          run,
        });
        const text = log.mock.calls.flat().join('\n');
        expect(text).toContain('service PATH   drifted');
        // #4196: it names the installed unit to inspect, not a manifest.
        expect(text).toContain(
          `               reinstall command unavailable: the installed unit ${unitPath} carries no STATION_ROOT, but a reinstall of this home would set STATION_ROOT=`,
        );
        expect(text).not.toContain('run: ');
      } finally {
        log.mockRestore();
      }
    });

    test.skipIf(process.platform !== 'darwin')(
      'reads the PATH out of the real launchd plist with plutil',
      async () => {
        const { defaultRun } = await import('../commands/service.js');
        const { renderLaunchdPlist } = await vi.importActual<
          typeof import('../commands/service-launchd.js')
        >('../commands/service-launchd.js');
        const baseDir = makeTempDir('station-service-test-');
        const unitPath = join(baseDir, 'installed.plist');
        const registration = {
          label: 'io.kontourai.station.service-test',
          platform: 'darwin' as const,
          unitPath,
        };
        launchdRegistration.mockReturnValue(registration);
        installLaunchd.mockImplementation((instanceId, input) => {
          writeFileSync(
            unitPath,
            renderLaunchdPlist({
              instanceId,
              label: registration.label,
              lifecycle: input.lifecycle,
              nodePath: input.nodePath,
              repoPath: input.repoPath,
              servicePath: input.servicePath,
            }),
          );
          return {
            host: input.lifecycle.host,
            installedAt: '',
            instanceId,
            label: registration.label,
            nodePath: input.nodePath,
            platform: 'darwin',
            repoPath: input.repoPath,
            serverPort: input.lifecycle.serverPort,
            uiPort: input.lifecycle.uiPort,
            unitPath,
          };
        });
        const addedLater = makeTempDir('station-service-bin-');
        let loginPath = '/usr/bin:/bin';
        const run = vi.fn(
          (
            command: string,
            args: string[],
            options?: Record<string, unknown>,
          ) =>
            command === 'plutil'
              ? defaultRun(command, args, options)
              : args[0] === '-l' && args[1] === '-c'
                ? loginShellAnswer(loginPath)
                : { status: 0, stdout: '' },
        );
        await runServiceCommand(['install'], lifecycle(baseDir), {
          fs: serviceFs,
          platform: 'darwin',
          run,
        });
        loginPath = `${addedLater}:/usr/bin:/bin`;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
            fs: serviceFs,
            platform: 'darwin',
            run,
          });
          expect(
            JSON.parse(String(log.mock.calls.at(-1)?.[0])).servicePath,
          ).toEqual({
            missing: [nodeFs.realpathSync(addedLater)],
            stale: [],
            status: 'drifted',
          });
        } finally {
          log.mockRestore();
        }
      },
    );
  });

  test('rolls back the backend when manifest publication fails', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const manifestPath = join(baseDir, 'service', 'service-test.json');
    const failingFs = {
      ...serviceFs,
      writeFileSync: (path: nodeFs.PathLike) => {
        nodeFs.writeFileSync(path, '{partial', { mode: 0o600 });
        throw new Error('disk full');
      },
    } as unknown as ServiceFs;

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: failingFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow('disk full');
    expect(uninstallLaunchd).toHaveBeenCalledWith(
      expect.objectContaining({ instanceId: 'service-test' }),
      expect.any(Object),
    );
    expect(nodeFs.existsSync(manifestPath)).toBe(false);
    expect(
      nodeFs
        .readdirSync(join(baseDir, 'service'))
        .some((name) => name.endsWith('.tmp')),
    ).toBe(false);
  });

  test('restores a working backend and preserves its manifest when reinstall publication fails', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    const priorManifest = {
      host: '127.0.0.1',
      installedAt: '2026-07-21T12:00:00.000Z',
      instanceId: 'service-test',
      label: 'io.kontourai.station.service-test',
      nodePath: '/prior-node',
      platform: 'darwin',
      repoPath: '/prior-repo',
      serverPort: 3141,
      uiPort: 3000,
      unitPath: '/tmp/service-test.plist',
    };
    writeFileSync(manifestPath, JSON.stringify(priorManifest), { mode: 0o600 });
    const rollback = vi.fn();
    installLaunchd.mockImplementationOnce((instanceId, input) => ({
      ...priorManifest,
      instanceId,
      nodePath: input.nodePath,
      repoPath: input.repoPath,
      rollback,
    }));
    const failingFs = {
      ...serviceFs,
      writeFileSync: () => {
        throw new Error('disk full');
      },
    } as unknown as ServiceFs;

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: failingFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow('disk full');
    expect(rollback).toHaveBeenCalledOnce();
    expect(uninstallLaunchd).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(
      priorManifest,
    );
  });

  test('restores the prior manifest and backend when post-rename ACL hardening fails', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    const priorManifest = {
      host: '127.0.0.1',
      installedAt: '2026-07-21T12:00:00.000Z',
      instanceId: 'service-test',
      label: 'io.kontourai.station.service-test',
      nodePath: '/prior-node',
      platform: 'darwin',
      repoPath: '/prior-repo',
      serverPort: 3141,
      uiPort: 3000,
      unitPath: '/tmp/service-test.plist',
    };
    const priorContent = `${JSON.stringify(priorManifest)}\n`;
    writeFileSync(manifestPath, priorContent, { mode: 0o600 });
    const rollback = vi.fn();
    installLaunchd.mockImplementationOnce((instanceId, input) => ({
      ...priorManifest,
      instanceId,
      nodePath: input.nodePath,
      repoPath: input.repoPath,
      rollback,
    }));
    let hardenCalls = 0;

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        hardenWindowsPaths: () => {
          hardenCalls += 1;
          if (hardenCalls === 1) throw new Error('post-rename ACL failure');
        },
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow('post-rename ACL failure');
    expect(rollback).toHaveBeenCalledOnce();
    expect(readFileSync(manifestPath, 'utf8')).toBe(priorContent);
    expect(hardenCalls).toBe(2);
  });

  test('returns an idempotent install receipt that restores backend and prior manifest', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    const priorManifestText = `${JSON.stringify({
      host: '127.0.0.1',
      installedAt: '2026-07-21T12:00:00.000Z',
      instanceId: 'service-test',
      label: 'io.kontourai.station.service-test',
      nodePath: '/prior-node',
      platform: 'darwin',
      repoPath: '/prior-repo',
      serverPort: 3141,
      uiPort: 3000,
      unitPath: '/tmp/service-test.plist',
    })}\n`;
    writeFileSync(manifestPath, priorManifestText, { mode: 0o600 });
    const rollback = vi.fn();
    installLaunchd.mockImplementationOnce((instanceId, input) => ({
      host: '127.0.0.1',
      installedAt: '',
      instanceId,
      label: `io.kontourai.station.${instanceId}`,
      nodePath: input.nodePath,
      platform: 'darwin',
      repoPath: input.repoPath,
      rollback,
      serverPort: input.lifecycle.serverPort,
      uiPort: input.lifecycle.uiPort,
      unitPath: `/tmp/${instanceId}.plist`,
    }));

    const receipt = await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
    });
    expect(readFileSync(manifestPath, 'utf8')).not.toBe(priorManifestText);
    await Promise.all([receipt?.rollback(), receipt?.rollback()]);
    expect(rollback).toHaveBeenCalledOnce();
    expect(readFileSync(manifestPath, 'utf8')).toBe(priorManifestText);
  });

  test('waits for this instance server and UI identity before reporting install success', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const sleep = vi.fn();
    collectInstanceStatus
      .mockResolvedValueOnce({
        found: true,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: false },
      })
      .mockResolvedValueOnce({
        found: true,
        healthy: true,
        instanceId: 'another-instance',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      })
      .mockResolvedValueOnce({
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      });

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      installReadinessAttempts: 3,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      sleep,
    });

    expect(collectInstanceStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  test('finishes a stale build before installing, so readiness starts with an adoptable build', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    isBuildStale.mockReturnValueOnce(true);
    let releaseBuild: (() => void) | undefined;
    buildApplication.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseBuild = resolve;
        }),
    );

    const install = runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
    });
    await Promise.resolve();

    expect(installLaunchd).not.toHaveBeenCalled();
    expect(buildApplication).toHaveBeenCalledWith({
      baseDir,
      instanceName: 'service-test',
      serverPort: 3242,
      uiPort: 5274,
    });

    releaseBuild?.();
    await install;
    expect(installLaunchd).toHaveBeenCalledOnce();
  });

  test('pre-build targets the RESOLVED service identity, not a default guess', async () => {
    // With no explicit instance name the service identity is derived (a
    // generated hash for custom home/ports) — building 'default' artifacts
    // would put the real instance's cold build back inside the readiness
    // window (#2561 sol review HIGH).
    const { runServiceCommand } = await import('../commands/service.js');
    const { resolveLifecycleInstanceId } = await import(
      '../commands/helpers.js'
    );
    const baseDir = makeTempDir('station-service-test-');
    const anonymous = { ...lifecycle(baseDir), instanceName: undefined };
    const expectedId = resolveLifecycleInstanceId({
      cwd: process.cwd(),
      instanceName: undefined,
      projectHome: baseDir,
      serverPort: 3242,
      uiPort: 5274,
    });
    expect(expectedId).not.toBe('default');
    collectInstanceStatus.mockResolvedValue({
      found: true,
      healthy: true,
      instanceId: expectedId,
      server: { pid: 10, reachable: true },
      ui: { pid: 11, reachable: true },
    });
    const prepared: string[] = [];

    await runServiceCommand(['install'], anonymous, {
      fs: serviceFs,
      platform: 'darwin',
      prepareServiceBuild: async (_lifecycle, instanceId) => {
        prepared.push(instanceId);
      },
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      sleep: vi.fn(),
    });

    expect(prepared).toEqual([expectedId]);
  });

  test('honors the readiness hard cap when a generation stays wedged', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    let elapsedMs = 0;
    const sleep = vi.fn((milliseconds: number) => {
      elapsedMs += milliseconds;
    });
    collectInstanceStatus.mockResolvedValue({
      found: true,
      healthy: false,
      instanceId: 'service-test',
      server: { pid: 10, reachable: false },
      ui: { pid: 11, reachable: false },
    });

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        installReadinessAttempts: 100,
        installReadinessTimeoutMs: 120,
        monotonicNow: () => elapsedMs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
        sleep,
      }),
    ).rejects.toThrow(
      'did not become server-and-UI identity healthy with a newly started generation within 120ms',
    );

    expect(collectInstanceStatus).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(120);
  });

  test('requires a new boot identity before a reinstall reports readiness', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });
    const sleep = vi.fn();
    collectInstanceStatus
      .mockResolvedValueOnce({
        bootId: 'prior-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      })
      .mockResolvedValueOnce({
        bootId: 'prior-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      })
      .mockResolvedValueOnce({
        bootId: 'replacement-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 12, reachable: true },
        ui: { pid: 13, reachable: true },
      });

    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      installReadinessAttempts: 2,
      platform: 'darwin',
      run,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(collectInstanceStatus).toHaveBeenCalledTimes(4);
  });

  test('compensates backend and prior manifest when service readiness times out', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    const priorManifestText = `${JSON.stringify({
      host: '127.0.0.1',
      installedAt: '2026-07-21T12:00:00.000Z',
      instanceId: 'service-test',
      label: 'io.kontourai.station.service-test',
      nodePath: '/prior-node',
      platform: 'darwin',
      repoPath: '/prior-repo',
      serverPort: 3141,
      uiPort: 3000,
      unitPath: '/tmp/service-test.plist',
    })}\n`;
    writeFileSync(manifestPath, priorManifestText, { mode: 0o600 });
    const rollback = vi.fn();
    installLaunchd.mockImplementationOnce((instanceId, input) => ({
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      label: `io.kontourai.station.${instanceId}`,
      nodePath: input.nodePath,
      platform: 'darwin',
      repoPath: input.repoPath,
      rollback,
      serverPort: input.lifecycle.serverPort,
      uiPort: input.lifecycle.uiPort,
      unitPath: `/tmp/${instanceId}.plist`,
    }));
    collectInstanceStatus.mockResolvedValue({
      found: true,
      healthy: false,
      instanceId: 'service-test',
      server: { pid: 10, reachable: false },
      ui: { pid: 11, reachable: false },
    });
    const sleep = vi.fn();

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        installReadinessAttempts: 2,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
        sleep,
      }),
    ).rejects.toThrow('did not become server-and-UI identity healthy');

    expect(rollback).toHaveBeenCalledOnce();
    expect(readFileSync(manifestPath, 'utf8')).toBe(priorManifestText);
    expect(sleep).toHaveBeenCalledOnce();
  });

  test('attempts a replacement generation when readiness and compensation both fail', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const rollback = vi.fn(() => {
      throw new Error('old generation drain timed out');
    });
    installLaunchd
      .mockImplementationOnce((instanceId, input) => ({
        host: input.lifecycle.host,
        installedAt: '',
        instanceId,
        label: `io.kontourai.station.${instanceId}`,
        nodePath: input.nodePath,
        platform: 'darwin',
        repoPath: input.repoPath,
        rollback,
        serverPort: input.lifecycle.serverPort,
        uiPort: input.lifecycle.uiPort,
        unitPath: `/tmp/${instanceId}.plist`,
      }))
      .mockImplementationOnce((instanceId, input) => ({
        host: input.lifecycle.host,
        installedAt: '',
        instanceId,
        label: `io.kontourai.station.${instanceId}`,
        nodePath: input.nodePath,
        platform: 'darwin',
        repoPath: input.repoPath,
        serverPort: input.lifecycle.serverPort,
        uiPort: input.lifecycle.uiPort,
        unitPath: `/tmp/${instanceId}.plist`,
      }));
    collectInstanceStatus
      .mockResolvedValueOnce({
        found: true,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: 10, reachable: false },
        ui: { pid: 11, reachable: false },
      })
      .mockResolvedValueOnce({
        bootId: 'recovery-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 12, reachable: true },
        ui: { pid: 13, reachable: true },
      })
      .mockResolvedValueOnce({
        bootId: 'recovery-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 12, reachable: true },
        ui: { pid: 13, reachable: true },
      });

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        installReadinessAttempts: 1,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow(
      'Emergency recovery attempted. A replacement Station generation is running (boot ID recovery-boot).',
    );

    expect(rollback).toHaveBeenCalledOnce();
    expect(installLaunchd).toHaveBeenCalledTimes(2);
  });

  test('stops a running Windows replacement and restores the active prior generation after readiness times out', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true });
    const manifestPath = join(serviceDir, 'service-test.json');
    const priorManifestText = `${JSON.stringify({
      host: '127.0.0.1',
      installedAt: '2026-07-21T12:00:00.000Z',
      instanceId: 'service-test',
      nodePath: '/prior-node',
      platform: 'win32',
      repoPath: '/prior-repo',
      serverPort: 3141,
      taskName: '\\KontourStation-service-test',
      uiPort: 3000,
      unitPath: '/tmp/service-test.cmd',
    })}\n`;
    writeFileSync(manifestPath, priorManifestText, { mode: 0o600 });
    let taskActive = true;
    const restore = vi.fn();
    windowsServiceStatus.mockImplementation(() => ({
      active: taskActive,
      enabled: true,
      present: true,
    }));
    stopWindowsService.mockImplementation(() => {
      taskActive = false;
    });
    installWindowsService.mockImplementationOnce((instanceId, input) => ({
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      nodePath: input.nodePath,
      platform: 'win32',
      repoPath: input.repoPath,
      rollback: restore,
      serverPort: input.lifecycle.serverPort,
      taskName: `\\KontourStation-${instanceId}`,
      uiPort: input.lifecycle.uiPort,
      unitPath: `/tmp/${instanceId}.cmd`,
    }));
    collectInstanceStatus
      // Capture the prior generation before replacement.
      .mockResolvedValueOnce({
        bootId: 'prior-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 10, reachable: true },
        ui: { pid: 11, reachable: true },
      })
      // The prior task and managed process have disappeared before replace.
      .mockResolvedValueOnce({
        found: false,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: null, reachable: false },
        ui: { pid: null, reachable: false },
      })
      // Readiness observes a live but unhealthy replacement generation.
      .mockResolvedValueOnce({
        bootId: 'replacement-boot',
        found: true,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: 12, reachable: false },
        ui: { pid: 13, reachable: false },
      })
      // Compensation records that generation, then waits for it to disappear.
      .mockResolvedValueOnce({
        bootId: 'replacement-boot',
        found: true,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: 12, reachable: false },
        ui: { pid: 13, reachable: false },
      })
      .mockResolvedValueOnce({
        found: false,
        healthy: false,
        instanceId: 'service-test',
        server: { pid: null, reachable: false },
        ui: { pid: null, reachable: false },
      })
      // Restoration of an active prior task must establish a new generation.
      .mockResolvedValueOnce({
        bootId: 'restored-boot',
        found: true,
        healthy: true,
        instanceId: 'service-test',
        server: { pid: 14, reachable: true },
        ui: { pid: 15, reachable: true },
      });

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        fs: serviceFs,
        installReadinessAttempts: 1,
        platform: 'win32',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      }),
    ).rejects.toThrow('did not become server-and-UI identity healthy');

    expect(restore).toHaveBeenCalledOnce();
    expect(stopWindowsService).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(readFileSync(manifestPath, 'utf8')).toBe(priorManifestText);
  });

  test('surfaces backend probe execution errors and exits non-zero', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    launchdStatus.mockReturnValue({
      active: null,
      error: 'launchctl print failed: backend unavailable',
      present: false,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runServiceCommand(['status'], lifecycle(baseDir), {
      platform: 'darwin',
    });

    expect(process.exitCode).toBe(1);
    expect(log.mock.calls.flat().join('\n')).toContain('backend unavailable');
  });

  test('preserves the manifest and instance when backend uninstall fails', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
    });
    uninstallLaunchd.mockImplementationOnce(() => {
      throw new Error('bootout failed; launchd job remains loaded');
    });

    await expect(
      runServiceCommand(['uninstall'], lifecycle(baseDir), {
        platform: 'darwin',
      }),
    ).rejects.toThrow('job remains loaded');
    expect(
      statSync(join(baseDir, 'service', 'service-test.json')).isFile(),
    ).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  test('returns non-zero JSON status for an installed unhealthy service', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });
    collectInstanceStatus.mockResolvedValue({
      found: true,
      healthy: false,
      instanceId: 'service-test',
      server: { pid: 10, reachable: true },
      ui: { pid: 11, reachable: false },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runServiceCommand(['status', '--json'], lifecycle(baseDir), {
      platform: 'darwin',
      run,
    });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      healthy: false,
      installed: true,
    });
  });

  test('uninstall converges when no manifest exists', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    await runServiceCommand(['uninstall'], lifecycle(baseDir), {
      platform: 'darwin',
    });
    expect(uninstallLaunchd).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({
      instanceName: 'service-test',
      stateHome: baseDir,
    });
  });

  test('starts an installed service and prints its post-action JSON status', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });

    await runServiceCommand(['start', '--json'], lifecycle(baseDir), {
      platform: 'darwin',
      run,
    });

    expect(startLaunchd).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      installed: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  test('stops a stranded live identity even when its supervisor reports inactive', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });
    launchdStatus.mockReturnValue({ active: false, present: true });
    // An inactive supervisor does not prove the old Station identity is gone.
    // The stopped desired state requires both facts, so reconciliation still
    // issues the platform stop and reports the unresolved live identity.
    await runServiceCommand(['stop', '--json'], lifecycle(baseDir), {
      platform: 'darwin',
      run,
    });
    expect(stopLaunchd).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    launchdStatus.mockReturnValue({ active: true, present: true });
    await runServiceCommand(['stop'], lifecycle(baseDir), {
      platform: 'darwin',
      run,
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    launchdStatus.mockReturnValue({ active: false, present: false });
    collectInstanceStatus.mockResolvedValue({
      found: false,
      healthy: false,
      instanceId: 'service-test',
      server: { pid: null, reachable: false },
      ui: { pid: null, reachable: false },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const action of ['start', 'stop'] as const) {
      const missingBase = makeTempDir('station-service-test-');
      await runServiceCommand([action], lifecycle(missingBase), {
        platform: 'darwin',
      });
      // Start/stop cross the reconciler seam even when the manifest is absent;
      // only its typed coherent-absence outcome owns this user guidance.
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(
        `Cannot ${action} Station user service service-test: no service manifest found at ${join(missingBase, 'service', 'service-test.json')}. Run \`station service install\` first.`,
      );
      process.exitCode = undefined;
    }
    error.mockRestore();
  });

  test('keeps a missing-manifest backend probe failure generic', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    launchdStatus.mockReturnValue({
      active: null,
      error: 'launchctl unavailable',
      present: false,
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runServiceCommand(['start'], lifecycle(baseDir), {
      platform: 'darwin',
    });
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('start reconciliation failed:'),
    );
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('no service manifest found'),
    );
    error.mockRestore();
  });

  test('fails closed when a post-action backend probe is unknown', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      fs: serviceFs,
      platform: 'darwin',
      run,
    });
    launchdStatus.mockReturnValue({
      active: null,
      error: 'launchctl unavailable',
      present: true,
    });

    await runServiceCommand(['start', '--json'], lifecycle(baseDir), {
      platform: 'darwin',
      run,
    });

    expect(process.exitCode).toBe(1);
  });
});

/**
 * #2675: a prebuilt archive keeps an instance's lifecycle record in the
 * Station root of the home the supervisor runs with (`service run
 * --base=<home>`). Every status read the service command makes must look
 * there too, or an install from --home=<raw dir> never observes its own
 * service and rolls back, and status reports it absent.
 */
describe('service reads archive lifecycle state from the service home', () => {
  // The exact .station-release.json the portable archive builder embeds.
  const release = {
    schemaVersion: 2,
    sha: 'a'.repeat(40),
    ref: 'v0.0.0',
    createdAt: '2026-09-26T00:00:00.000Z',
    channel: 'stable',
    releaseChannel: 'stable',
    prerelease: false,
  };

  async function archiveStatusModel() {
    const { resolveLifecycleCodeRoot, resolveLifecycleStateLocation } =
      await import('../commands/lifecycle-code-root.js');
    const archive = makeTempDir('station-service-archive-');
    writeFileSync(
      join(archive, '.station-release.json'),
      JSON.stringify(release),
    );
    writeFileSync(
      join(archive, '.station-prebuilt-archive'),
      'station-prebuilt-archive-v1\n',
    );
    const codeRoot = resolveLifecycleCodeRoot(archive);
    // What a bare command would search: some other home's root.
    const ambientHome = makeTempDir('station-service-ambient-home-');
    const recordPath = (home: string, instanceId: string) =>
      join(
        resolveLifecycleStateLocation(codeRoot, home).instanceStateDir,
        `${instanceId}.json`,
      );
    // The real lookup rule over the real location resolver: found only in
    // the directory the given (or defaulted) home selects.
    collectInstanceStatus.mockImplementation(
      async (instanceId: string, options?: { projectHome?: string }) => {
        const path = recordPath(
          options?.projectHome ?? ambientHome,
          instanceId,
        );
        return nodeFs.existsSync(path)
          ? {
              found: true,
              healthy: true,
              instanceId,
              bootId: JSON.parse(readFileSync(path, 'utf8')).bootId,
              server: { pid: 10, reachable: true },
              ui: { pid: 11, reachable: true },
            }
          : {
              found: false,
              healthy: false,
              instanceId,
              server: { pid: null, reachable: false },
              ui: { pid: null, reachable: false },
            };
      },
    );
    return { recordPath };
  }

  /** The record the supervisor writes when the service starts. */
  function superviseInto(path: string, bootId = 'boot-1'): void {
    nodeFs.mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ bootId }));
  }

  const darwinManifest = (instanceId: string, input: any) => ({
    host: input.lifecycle.host,
    installedAt: '',
    instanceId,
    label: `io.kontourai.station.${instanceId}`,
    nodePath: input.nodePath,
    platform: 'darwin' as const,
    repoPath: input.repoPath,
    serverPort: input.lifecycle.serverPort,
    uiPort: input.lifecycle.uiPort,
    unitPath: `/tmp/${instanceId}.plist`,
  });

  test('a Windows reinstall waits for the old generation under a non-default --home to exit', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { recordPath } = await archiveStatusModel();
    const home = makeTempDir('station-service-raw-home-');
    const record = recordPath(home, 'service-test');
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));
    // Was the old generation's record still present when the backend
    // replaced its wrapper?
    const oldGenerationAliveAtInstall: boolean[] = [];
    const defaultInstall = installWindowsService.getMockImplementation()!;
    installWindowsService.mockImplementation((instanceId, input) => {
      oldGenerationAliveAtInstall.push(nodeFs.existsSync(record));
      superviseInto(record, `boot-${oldGenerationAliveAtInstall.length}`);
      return defaultInstall(instanceId, input);
    });
    windowsServiceStatus.mockReturnValue({
      active: false,
      enabled: true,
      present: true,
    });
    await runServiceCommand(['install'], lifecycle(home), {
      fs: serviceFs,
      platform: 'win32',
      run,
      sleep: vi.fn(),
    });

    // `stop` signals the managed processes; they exit a poll later, as
    // Task Scheduler's child does.
    let stopped = false;
    stop.mockImplementation(() => {
      stopped = true;
    });
    const sleep = vi.fn(async () => {
      if (stopped) nodeFs.rmSync(record, { force: true });
    });
    await runServiceCommand(['install'], lifecycle(home), {
      fs: serviceFs,
      platform: 'win32',
      run,
      sleep,
    });

    expect(stop).toHaveBeenCalledWith({
      instanceName: 'service-test',
      stateHome: home,
    });
    // The stop poll saw the old record, waited, and replaced the wrapper
    // only once it was gone.
    expect(oldGenerationAliveAtInstall).toEqual([false, false]);
    expect(sleep).toHaveBeenCalled();
  });

  test('a darwin reinstall under a non-default --home stops the old generation and waits for a new boot', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { recordPath } = await archiveStatusModel();
    const home = makeTempDir('station-service-raw-home-');
    const record = recordPath(home, 'service-test');
    installLaunchd.mockImplementation((instanceId, input) => {
      superviseInto(record, 'boot-old');
      return darwinManifest(instanceId, input);
    });
    await runServiceCommand(['install'], lifecycle(home), {
      fs: serviceFs,
      installReadinessAttempts: 2,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      sleep: vi.fn(),
    });

    // The reinstall's launchd swap leaves the old generation answering at
    // first; the new boot publishes a poll later.
    let reinstallInput: any;
    installLaunchd.mockImplementation((instanceId, input) => {
      reinstallInput = input;
      return darwinManifest(instanceId, input);
    });
    const sleep = vi.fn(async () => superviseInto(record, 'boot-new'));
    await runServiceCommand(['install'], lifecycle(home), {
      fs: serviceFs,
      installReadinessAttempts: 3,
      platform: 'darwin',
      run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
      sleep,
    });

    // The prior instance was found under the home, so launchd was handed
    // the owned instance to stop ...
    expect(reinstallInput.stopOwnedInstance).toBeTypeOf('function');
    reinstallInput.stopOwnedInstance();
    expect(stop).toHaveBeenLastCalledWith({
      instanceName: 'service-test',
      stateHome: home,
    });
    // ... and readiness refused the old boot until a new one answered.
    expect(sleep).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(record, 'utf8')).bootId).toBe('boot-new');
  });

  test('install readiness observes the service under a non-default --home', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { recordPath } = await archiveStatusModel();
    const home = makeTempDir('station-service-raw-home-');
    installLaunchd.mockImplementation((instanceId, input) => {
      superviseInto(recordPath(home, instanceId));
      return {
        host: input.lifecycle.host,
        installedAt: '',
        instanceId,
        label: `io.kontourai.station.${instanceId}`,
        nodePath: input.nodePath,
        platform: 'darwin',
        repoPath: input.repoPath,
        serverPort: input.lifecycle.serverPort,
        uiPort: input.lifecycle.uiPort,
        unitPath: `/tmp/${instanceId}.plist`,
      };
    });

    await expect(
      runServiceCommand(['install'], lifecycle(home), {
        fs: serviceFs,
        installReadinessAttempts: 2,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' })),
        sleep: vi.fn(),
      }),
    ).resolves.toBeDefined();
    expect(recordPath(home, 'service-test')).toBe(
      join(home, 'state', 'stable', 'instances', 'service-test.json'),
    );
  });

  test('status reports the service found under a non-default --home', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { recordPath } = await archiveStatusModel();
    const home = makeTempDir('station-service-raw-home-');
    ensureStationHomeSchemaSync(home);
    superviseInto(recordPath(home, 'service-test'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status', '--json'], lifecycle(home), {
        fs: serviceFs,
        platform: 'darwin',
        run: vi.fn(() => ({ status: 0, stdout: '' })),
      });
      expect(
        JSON.parse(String(log.mock.calls.at(-1)?.[0])).instance,
      ).toMatchObject({ found: true, healthy: true });
    } finally {
      log.mockRestore();
    }
  });
});

describe('what an installed service runs (#2675 slice C)', () => {
  beforeEach(() => {
    // Earlier tests in this file leave their own systemd doubles behind.
    systemdRegistration.mockReset();
    systemdRegistration.mockImplementation((instanceId) => ({
      platform: 'linux',
      unitName: `station-${instanceId}.service`,
      unitPath: `/tmp/station-${instanceId}.service`,
    }));
    installSystemd.mockReset();
    installSystemd.mockImplementation((instanceId, input) => ({
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      kind: input.kind,
      nodePath: input.nodePath,
      platform: 'linux',
      repoPath: input.repoPath,
      serverPort: input.lifecycle.serverPort,
      uiPort: input.lifecycle.uiPort,
      unitName: `station-${instanceId}.service`,
      unitPath: `/tmp/station-${instanceId}.service`,
    }));
    systemdStatus.mockReset();
    systemdStatus.mockReturnValue({
      active: true,
      enabled: true,
      present: true,
    });
  });

  /** install.sh's layout: `<installRoot>/versions/<v>`, marker, `current`. */
  function installerArchive() {
    const root = makeTempDir('station-service-archive-install-');
    const installRoot = join(root, 'installs', 'stable');
    const version = join(installRoot, 'versions', '1.2.3');
    mkdirSync(join(version, 'runtime', 'bin'), { recursive: true });
    writeFileSync(join(version, 'runtime', 'bin', 'node'), '');
    mkdirSync(join(version, 'bin'), { recursive: true });
    writeFileSync(
      join(version, 'bin', 'station-launcher.mjs'),
      '// launcher v1\n',
    );
    writeFileSync(
      join(version, '.station-prebuilt-archive'),
      'station-prebuilt-archive-v1\n',
    );
    writeFileSync(
      join(version, '.station-release.json'),
      JSON.stringify({
        schemaVersion: 2,
        sha: 'a'.repeat(40),
        ref: 'v1.2.3',
        createdAt: '2026-09-26T00:00:00.000Z',
        channel: 'stable',
        releaseChannel: 'stable',
        prerelease: false,
      }),
    );
    writeFileSync(
      join(installRoot, '.station-portable-install-root'),
      'station-portable-install-root-v1\n',
    );
    nodeFs.symlinkSync(version, join(installRoot, 'current'));
    return {
      installRoot: nodeFs.realpathSync(installRoot),
      version: nodeFs.realpathSync(version),
    };
  }

  test('an installer-owned archive version installs a unit that runs current, with current on its PATH', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { resolveLifecycleCodeRoot } = await import(
      '../commands/lifecycle-code-root.js'
    );
    const { installRoot, version } = installerArchive();
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));

    await runServiceCommand(['install'], lifecycle(baseDir), {
      codeRoot: resolveLifecycleCodeRoot(version),
      fs: serviceFs,
      platform: 'linux',
      run,
    });

    const current = join(installRoot, 'current');
    expect(installSystemd).toHaveBeenCalledWith(
      'service-test',
      expect.objectContaining({
        kind: 'archive',
        installRoot,
        nodePath: join(current, 'runtime', 'bin', 'node'),
        repoPath: current,
      }),
    );
    const [, input] = installSystemd.mock.calls[0];
    expect(input.servicePath.split(':')[0]).toBe(
      join(current, 'runtime', 'bin'),
    );
    expect(input.servicePath).not.toContain(version);
    // #2675 D: the fixed launcher the unit runs was copied out of the version.
    expect(
      nodeFs.readFileSync(
        join(installRoot, 'runtime', 'station-launcher.mjs'),
        'utf8',
      ),
    ).toBe('// launcher v1\n');
  });

  test('on Windows the task runs the launcher with a node.exe frozen beside it (#2675 W3)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { resolveLifecycleCodeRoot } = await import(
      '../commands/lifecycle-code-root.js'
    );
    const { installRoot, version } = installerArchive();
    writeFileSync(join(version, 'runtime', 'node.exe'), 'node.exe v1');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '' }));

    await runServiceCommand(['install'], lifecycle(baseDir), {
      codeRoot: resolveLifecycleCodeRoot(version),
      fs: serviceFs,
      platform: 'win32',
      run,
    });

    expect(installWindowsService).toHaveBeenCalledWith(
      'service-test',
      expect.objectContaining({
        kind: 'archive',
        installRoot,
        nodePath: win32.join(installRoot, 'runtime', 'node.exe'),
      }),
    );
    expect(readFileSync(join(installRoot, 'runtime', 'node.exe'), 'utf8')).toBe(
      'node.exe v1',
    );
    expect(
      readFileSync(
        join(installRoot, 'runtime', 'station-launcher.mjs'),
        'utf8',
      ),
    ).toBe('// launcher v1\n');
  });

  test('stops a Windows launcher service from its wrapper down, and waits for the launcher (#2675 W3)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { resolveLifecycleCodeRoot } = await import(
      '../commands/lifecycle-code-root.js'
    );
    const { installRoot, version } = installerArchive();
    writeFileSync(join(version, 'runtime', 'node.exe'), 'node.exe v1');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '' }));
    installWindowsService.mockImplementationOnce((instanceId, input) => ({
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      kind: input.kind,
      installRoot: input.installRoot,
      nodePath: input.nodePath,
      platform: 'win32',
      repoPath: input.repoPath,
      serverPort: input.lifecycle.serverPort,
      taskName: `\\KontourStation-${instanceId}`,
      uiPort: input.lifecycle.uiPort,
      unitPath: `/tmp/${instanceId}.cmd`,
    }));
    await runServiceCommand(['install'], lifecycle(baseDir), {
      codeRoot: resolveLifecycleCodeRoot(version),
      fs: serviceFs,
      platform: 'win32',
      run,
    });

    // A live launcher holds the lock, with its pid and start time.
    const launcher = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    const pid = launcher.pid as number;
    const lock = join(installRoot, 'runtime', 'service-state.lock');
    writeFileSync(
      lock,
      `${JSON.stringify({ pid, birth: lookupProcessBirthFingerprint(pid), token: 't' })}\n`,
    );
    const order: string[] = [];
    // `/End` ends the wrapper; the launcher notices, stops Station in order
    // and exits, releasing its lock, a little later.
    stopWindowsService.mockImplementation(() => {
      order.push('end-task');
      setTimeout(() => {
        nodeFs.rmSync(lock, { force: true });
        launcher.kill('SIGKILL');
      }, 300);
    });
    stop.mockImplementation(() => {
      order.push(nodeFs.existsSync(lock) ? 'stop-while-launcher-runs' : 'stop');
    });
    windowsServiceStatus.mockReturnValue({
      active: true,
      enabled: true,
      present: true,
    });
    stopWindowsService.mockClear();
    stop.mockClear();
    order.length = 0;
    const sleep = vi.fn(
      (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 50))),
    );
    windowsServiceStatus
      .mockReturnValueOnce({ active: true, enabled: true, present: true })
      .mockReturnValue({ active: false, enabled: true, present: true });
    collectInstanceStatus.mockResolvedValue({
      found: false,
      healthy: false,
      instanceId: 'service-test',
      server: { pid: null, reachable: false },
      ui: { pid: null, reachable: false },
    });
    try {
      await runServiceCommand(['stop'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'win32',
        run,
        sleep,
      });
    } finally {
      launcher.kill('SIGKILL');
    }
    // Stopping Station first would read to the launcher as a crash, which
    // it answers by starting Station again.
    expect(order).toEqual(['end-task', 'stop']);
  });

  test('ends a launcher that outlived its stop budget only when its start time proves the pid (#2675 W3)', async () => {
    const { waitForServiceLauncherExit } = await import(
      '../commands/service.js'
    );
    const installRoot = makeTempDir('station-launcher-lock-');
    mkdirSync(join(installRoot, 'runtime'));
    // A live process stands in for the launcher that holds the lock.
    const holder = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    );
    const pid = holder.pid as number;
    writeFileSync(
      join(installRoot, 'runtime', 'service-state.lock'),
      `${JSON.stringify({ pid, birth: 'recorded-birth', token: 't' })}\n`,
    );
    const kill = vi.fn();
    try {
      // Its start time cannot be read: nothing proves the pid is still the
      // launcher's, so it is not signalled and the stop is refused.
      await expect(
        waitForServiceLauncherExit(installRoot, {}, serviceFs, {
          deadlineMs: 0,
          birthOf: () => null,
          kill,
        }),
      ).rejects.toThrow(
        `The Station service launcher (pid ${pid}, lock ${join(installRoot, 'runtime', 'service-state.lock')}) did not stop within 0s, and its start time could not be read`,
      );
      expect(kill).not.toHaveBeenCalled();
      // Proven by its start time: it is ended.
      await waitForServiceLauncherExit(installRoot, {}, serviceFs, {
        deadlineMs: 0,
        birthOf: () => 'recorded-birth',
        kill,
      });
      expect(kill).toHaveBeenCalledWith(pid);
      // Another start time: the pid was reused, the lock is stale, nothing
      // is signalled and there is nothing to wait for.
      kill.mockClear();
      await waitForServiceLauncherExit(installRoot, {}, serviceFs, {
        deadlineMs: 0,
        birthOf: () => 'another-birth',
        kill,
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      holder.kill('SIGKILL');
    }
  });

  test('refuses to install from an inactive installer version, before touching the backend', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { resolveLifecycleCodeRoot } = await import(
      '../commands/lifecycle-code-root.js'
    );
    const { installRoot, version } = installerArchive();
    const next = join(installRoot, 'versions', '1.2.4');
    mkdirSync(next);
    nodeFs.rmSync(join(installRoot, 'current'));
    nodeFs.symlinkSync(next, join(installRoot, 'current'));
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));

    await expect(
      runServiceCommand(['install'], lifecycle(baseDir), {
        codeRoot: resolveLifecycleCodeRoot(version),
        fs: serviceFs,
        platform: 'linux',
        run,
      }),
    ).rejects.toThrow(
      `Cannot install a Station service from ${version}: it is not the version ${join(installRoot, 'current')} names`,
    );
    expect(installSystemd).not.toHaveBeenCalled();
  });

  test('a source checkout installs from its physical path with the resolved Node.js, as before', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { resolveLifecycleCodeRoot } = await import(
      '../commands/lifecycle-code-root.js'
    );
    const checkout = makeTempDir('station-service-checkout-');
    const baseDir = makeTempDir('station-service-test-');
    ensureStationHomeSchemaSync(baseDir);
    const run = vi.fn(() => ({ status: 0, stdout: '/usr/bin:/bin\n' }));

    await runServiceCommand(['install'], lifecycle(baseDir), {
      codeRoot: resolveLifecycleCodeRoot(checkout),
      fs: serviceFs,
      platform: 'linux',
      run,
    });

    const [, input] = installSystemd.mock.calls[0];
    expect(input).toMatchObject({
      kind: 'source',
      nodePath: '/usr/bin/node',
      repoPath: nodeFs.realpathSync(checkout),
    });
    expect(input).not.toHaveProperty('installRoot');
    expect(input.servicePath.split(':')[0]).toBe('/usr/bin');
  });

  test.each([
    { name: 'an unknown kind', fields: { kind: 'container' } },
    {
      name: 'an install root on a source service',
      fields: { kind: 'source', installRoot: '/srv/installs/stable' },
    },
    {
      name: 'an install root that is not a path',
      fields: { kind: 'archive', installRoot: 7 },
    },
  ])('rejects a manifest with $name', async ({ fields }) => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = makeTempDir('station-service-test-');
    const serviceDir = join(baseDir, 'service');
    mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
    const manifestPath = join(serviceDir, 'service-test.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        host: '127.0.0.1',
        installedAt: '2026-07-21T12:00:00.000Z',
        instanceId: 'service-test',
        nodePath: '/usr/bin/node',
        platform: 'linux',
        repoPath: '/srv/station',
        serverPort: 3242,
        uiPort: 5274,
        unitName: 'station-service-test.service',
        unitPath: '/tmp/station-service-test.service',
        ...fields,
      }),
      { mode: 0o600 },
    );
    await expect(
      runServiceCommand(['status'], lifecycle(baseDir), {
        fs: serviceFs,
        platform: 'linux',
        run: vi.fn(() => ({ status: 0, stdout: '' })),
      }),
    ).rejects.toThrow(`Invalid Station service manifest: ${manifestPath}`);
  });
});

describe('service status remedy reproduces the installed unit (#4189)', () => {
  beforeEach(() => {
    collectInstanceStatus.mockResolvedValue({
      found: true,
      healthy: true,
      instanceId: 'default',
      server: { pid: 10, reachable: true },
      ui: { pid: 11, reachable: true },
    });
  });

  const loginShellAnswer = (path: string) => ({
    status: 0,
    stdout: `__STATION_SERVICE_PATH__${path}__STATION_SERVICE_PATH__\n`,
  });

  /**
   * install.sh's nightly layout under one STATION_ROOT: the channel home
   * `instances/nightly`, a second home `instances/default`, and the install
   * root with the install state it writes (schema 4).
   */
  function nightlyArchiveInstall() {
    const root = nodeFs.realpathSync(makeTempDir('station-service-root-'));
    const channelHome = join(root, 'instances', 'nightly');
    const installedHome = join(root, 'instances', 'default');
    for (const home of [channelHome, installedHome]) {
      mkdirSync(home, { mode: 0o700, recursive: true });
      ensureStationHomeSchemaSync(home);
    }
    const installRoot = join(root, 'installs', 'nightly');
    mkdirSync(join(installRoot, 'runtime'), { recursive: true });
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      JSON.stringify({
        schemaVersion: 4,
        channel: 'nightly',
        releaseChannel: 'nightly',
        installRoot,
        stationRoot: root,
        stationHome: channelHome,
        manifestUrl: 'https://releases.example.test/nightly.json',
        serverPort: 38141,
        uiPort: 38000,
      }),
    );
    // What resolveServiceCodeLocation yields for this install's `current`.
    const location = {
      kind: 'archive' as const,
      installRoot,
      nodePath: join(installRoot, 'current', 'runtime', 'bin', 'node'),
      repoPath: join(installRoot, 'current'),
    };
    return { channelHome, installedHome, location, root };
  }

  const channelDefaults = (home: string) => ({
    baseDir: home,
    homeSource: '--base' as const,
    host: '127.0.0.1',
    instanceName: 'default',
    serverPort: 38141,
    uiPort: 38000,
  });
  const installedSettings = (home: string) => ({
    ...channelDefaults(home),
    allowedOrigins: ['https://station-host.example.test'],
    serverPort: 3141,
    uiPort: 3000,
  });

  /**
   * One machine-wide unit, installed first from the channel home with the
   * channel's defaults and then again from another home with its own
   * settings: the channel home keeps a manifest that no longer describes
   * the unit. Status then runs from the channel home, as a channel launcher
   * does when no --base is given.
   */
  async function statusAfterReinstallElsewhere(
    platform: 'darwin' | 'linux',
    // false: only the second install, so no home holds a stale manifest.
    installFromChannelFirst = true,
  ): Promise<{
    channelHome: string;
    dependencies: import('../commands/service.js').ServiceDependencies;
    installedHome: string;
    staleManifest: any;
    text: string;
    unitPath: string;
  }> {
    vi.stubEnv('STATION_ROOT', '');
    const { runServiceCommand } = await import('../commands/service.js');
    const { channelHome, installedHome, location } = nightlyArchiveInstall();
    const unitDir = makeTempDir('station-service-units-');
    const unitPath = join(
      unitDir,
      platform === 'linux'
        ? 'station-default.service'
        : 'io.kontourai.station.default.plist',
    );
    if (platform === 'linux') {
      const { renderSystemdUnit } = await vi.importActual<
        typeof import('../commands/service-systemd.js')
      >('../commands/service-systemd.js');
      systemdRegistration.mockReturnValue({
        platform: 'linux',
        unitName: 'station-default.service',
        unitPath,
      });
      installSystemd.mockImplementation((instanceId, input) => {
        writeFileSync(
          unitPath,
          renderSystemdUnit({
            ...location,
            instanceId,
            lifecycle: input.lifecycle,
            servicePath: input.servicePath,
          }),
        );
        return {
          ...location,
          host: input.lifecycle.host,
          installedAt: '',
          instanceId,
          platform: 'linux',
          serverPort: input.lifecycle.serverPort,
          uiPort: input.lifecycle.uiPort,
          unitName: 'station-default.service',
          unitPath,
        };
      });
      systemdStatus.mockReturnValue({
        active: true,
        enabled: true,
        present: true,
      });
    } else {
      const { renderLaunchdPlist } = await vi.importActual<
        typeof import('../commands/service-launchd.js')
      >('../commands/service-launchd.js');
      const label = 'io.kontourai.station.default';
      launchdRegistration.mockReturnValue({
        label,
        platform: 'darwin',
        unitPath,
      });
      legacyLaunchdRegistrations.mockReturnValue([]);
      installLaunchd.mockImplementation((instanceId, input) => {
        writeFileSync(
          unitPath,
          renderLaunchdPlist({
            ...location,
            instanceId,
            label,
            lifecycle: input.lifecycle,
            servicePath: input.servicePath,
          }),
        );
        return {
          ...location,
          host: input.lifecycle.host,
          installedAt: '',
          instanceId,
          label,
          platform: 'darwin',
          serverPort: input.lifecycle.serverPort,
          uiPort: input.lifecycle.uiPort,
          unitPath,
        };
      });
    }
    const addedLater = makeTempDir('station-service-bin-');
    let loginPath = '/usr/bin:/bin';
    const run = vi.fn((command: string, args: string[]) => {
      if (command === 'plutil')
        return { status: 0, stdout: plutilJson(args.at(-1) as string) };
      if (command === 'systemctl' && args[1] === 'cat')
        return {
          status: 0,
          stdout: `# ${unitPath}\n${readFileSync(unitPath, 'utf8')}`,
        };
      if (args[0] === '-l' && args[1] === '-c')
        return loginShellAnswer(loginPath);
      return { status: 0, stdout: '' };
    });
    const dependencies = {
      fs: serviceFs,
      installReadinessTimeoutMs: 2_000,
      platform,
      run,
    };
    if (installFromChannelFirst) {
      await runServiceCommand(['install'], channelDefaults(channelHome), {
        ...dependencies,
      });
    }
    await runServiceCommand(['install'], installedSettings(installedHome), {
      ...dependencies,
    });
    const staleManifest = installFromChannelFirst
      ? JSON.parse(
          readFileSync(join(channelHome, 'service', 'default.json'), 'utf8'),
        )
      : null;
    loginPath = `${addedLater}:/usr/bin:/bin`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status'], channelDefaults(channelHome), {
        ...dependencies,
      });
      return {
        channelHome,
        dependencies,
        installedHome,
        staleManifest,
        text: log.mock.calls.flat().join('\n'),
        unitPath,
      };
    } finally {
      log.mockRestore();
    }
  }

  test.each(['linux', 'darwin'] as const)(
    'on %s the PATH-drift remedy echoes the installed unit under the channel launcher',
    async (platform) => {
      const { installedHome, staleManifest, text } =
        await statusAfterReinstallElsewhere(platform);
      // The premise: the manifest status reads describes the channel defaults.
      expect(staleManifest).toMatchObject({
        allowedOrigins: [],
        baseDir: expect.stringMatching(/instances[/\\]nightly$/u),
        serverPort: 38141,
        uiPort: 38000,
      });
      expect(text).toContain('service PATH   drifted');
      const runLines = text
        .split('\n')
        .filter((line) => line.includes('run: '));
      expect(runLines).toEqual([
        `               run: station-nightly service install --instance=default --base=${installedHome} --port=3141 --ui-port=3000 --host=127.0.0.1 --allowed-origin=https://station-host.example.test`,
      ]);
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'the launchd fixture reads a rendered plist exactly as plutil does',
    async () => {
      const { defaultRun } = await import('../commands/service.js');
      const { renderLaunchdPlist } = await vi.importActual<
        typeof import('../commands/service-launchd.js')
      >('../commands/service-launchd.js');
      const { installedHome, location, root } = nightlyArchiveInstall();
      const plist = join(makeTempDir('station-service-units-'), 'u.plist');
      writeFileSync(
        plist,
        renderLaunchdPlist({
          ...location,
          instanceId: 'default',
          label: 'io.kontourai.station.default',
          lifecycle: {
            ...installedSettings(installedHome),
            features: "a&b,<c>,'d'",
            stationRoot: root,
          },
          servicePath: '/usr/bin:/bin',
        }),
      );
      const real = defaultRun('plutil', ['-convert', 'json', '-o', '-', plist]);
      expect(real.status).toBe(0);
      expect(JSON.parse(plutilJson(plist))).toEqual(
        JSON.parse(String(real.stdout)),
      );
    },
  );

  test.each(['linux', 'darwin'] as const)(
    'on %s status names the stale manifest and reads origins and health from the unit home (#4196)',
    async (platform) => {
      // The first install runs in the channel home; once the instance is
      // reinstalled into instances/default only that home has it running.
      const homes: string[] = [];
      let reinstalled = false;
      collectInstanceStatus.mockImplementation(
        async (instanceId: string, options?: { projectHome?: string }) => {
          homes.push(String(options?.projectHome));
          const inUnitHome = String(options?.projectHome).endsWith(
            join('instances', 'default'),
          );
          reinstalled ||= inUnitHome;
          const running = inUnitHome || !reinstalled;
          return {
            found: running,
            healthy: running,
            instanceId,
            server: { pid: running ? 10 : null, reachable: running },
            ui: { pid: running ? 11 : null, reachable: running },
          };
        },
      );
      const { runServiceCommand } = await import('../commands/service.js');
      const { channelHome, dependencies, installedHome, text, unitPath } =
        await statusAfterReinstallElsewhere(platform);
      const manifestPath = join(channelHome, 'service', 'default.json');
      const lines = text.split('\n');
      expect(lines).toContain(
        `manifest       stale: ${manifestPath} describes an earlier install; the installed unit ${unitPath} runs from ${installedHome}`,
      );
      expect(lines).toContain(
        `               the lines below are read from ${installedHome}; pass --base=${installedHome} to address it`,
      );
      expect(lines).toContain(
        `               to remove only the stale manifest (not \`service uninstall\`, which removes the installed unit): rm -- ${manifestPath}`,
      );
      // Printed, never performed.
      expect(nodeFs.existsSync(manifestPath)).toBe(true);
      // The stale manifest records no origins; the unit runs with one.
      expect(lines).toContain(
        'origins        https://station-host.example.test',
      );
      expect(homes.at(-1)).toBe(installedHome);
      expect(lines).toContain('instance       running');
      expect(lines).toContain('reachability   identity verified');

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await runServiceCommand(
          ['status', '--json'],
          channelDefaults(channelHome),
          { ...dependencies },
        );
        const json = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
        expect(json.staleManifest).toEqual({
          path: manifestPath,
          removeCommand: `rm -- ${manifestPath}`,
          unitHome: installedHome,
          unitManifest: 'present',
          unitPath,
        });
        expect(json.manifest.baseDir).toBe(installedHome);
        log.mockClear();
        // From the unit's own home nothing is stale.
        await runServiceCommand(['status'], installedSettings(installedHome), {
          ...dependencies,
        });
        expect(log.mock.calls.flat().join('\n')).not.toContain(
          'manifest       stale',
        );
      } finally {
        log.mockRestore();
      }
    },
  );

  /** Every console line of one service command, and its exit code. */
  async function capture(
    args: string[],
    settings: ReturnType<typeof channelDefaults> & {
      allowedOrigins?: string[];
    },
    dependencies: import('../commands/service.js').ServiceDependencies,
  ): Promise<{ errors: string; exitCode: unknown; lines: string[] }> {
    const { runServiceCommand } = await import('../commands/service.js');
    process.exitCode = undefined;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runServiceCommand(args, settings, { ...dependencies });
      return {
        errors: error.mock.calls.flat().join('\n'),
        exitCode: process.exitCode,
        lines: log.mock.calls.flat().map(String),
      };
    } finally {
      log.mockRestore();
      error.mockRestore();
      process.exitCode = undefined;
    }
  }

  test.each(['linux', 'darwin'] as const)(
    'on %s a home reached through a symlinked parent is not stale and offers no rm (#4200 review)',
    async (platform) => {
      const { dependencies, installedHome } =
        await statusAfterReinstallElsewhere(platform, false);
      const root = join(installedHome, '..', '..');
      const alias = join(makeTempDir('station-service-alias-'), 'alias');
      nodeFs.symlinkSync(root, alias);
      const aliasHome = join(alias, 'instances', 'default');
      // The probe: the live manifest, reached by another spelling.
      expect(
        nodeFs.realpathSync(join(aliasHome, 'service', 'default.json')),
      ).toBe(
        nodeFs.realpathSync(join(installedHome, 'service', 'default.json')),
      );
      const status = await capture(
        ['status'],
        installedSettings(aliasHome),
        dependencies,
      );
      expect(status.lines.join('\n')).not.toContain('manifest       stale');
      expect(status.lines.join('\n')).not.toContain('rm --');
      const json = await capture(
        ['status', '--json'],
        installedSettings(aliasHome),
        dependencies,
      );
      expect(JSON.parse(String(json.lines.at(-1)))).not.toHaveProperty(
        'staleManifest',
      );
      const start = await capture(
        ['start'],
        installedSettings(aliasHome),
        dependencies,
      );
      expect(start.errors).not.toContain('Refusing');
    },
  );

  test.each(['absent home', 'absent manifest'] as const)(
    'with the unit home manifest %s, status says so and offers no rm (#4200 review)',
    async (variant) => {
      const { channelHome, dependencies, installedHome } =
        await statusAfterReinstallElsewhere('linux');
      if (variant === 'absent home') {
        nodeFs.rmSync(installedHome, { force: true, recursive: true });
      } else {
        nodeFs.rmSync(join(installedHome, 'service', 'default.json'));
      }
      const unitManifestPath = join(installedHome, 'service', 'default.json');
      const manifestPath = join(channelHome, 'service', 'default.json');
      const status = await capture(
        ['status'],
        channelDefaults(channelHome),
        dependencies,
      );
      const text = status.lines.join('\n');
      expect(text).toContain('manifest       stale');
      expect(text).toContain(
        `               ${unitManifestPath} does not exist, so the lines below are read from ${installedHome} without a manifest; pass --base=${installedHome} to address it`,
      );
      expect(text).toContain(
        `               no removal offered: ${manifestPath} is the only manifest that records this service`,
      );
      expect(text).not.toContain('rm --');
      const json = await capture(
        ['status', '--json'],
        channelDefaults(channelHome),
        dependencies,
      );
      expect(JSON.parse(String(json.lines.at(-1))).staleManifest).toMatchObject(
        { removeCommand: null, unitManifest: 'absent' },
      );
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    'with an unreadable unit home service directory, status says so and offers no rm (#4200 review)',
    async () => {
      const { channelHome, dependencies, installedHome } =
        await statusAfterReinstallElsewhere('linux');
      const serviceDir = join(installedHome, 'service');
      nodeFs.chmodSync(serviceDir, 0o000);
      try {
        const status = await capture(
          ['status'],
          channelDefaults(channelHome),
          dependencies,
        );
        const text = status.lines.join('\n');
        expect(text).toContain(
          `               ${join(serviceDir, 'default.json')} could not be read (`,
        );
        expect(text).toContain(
          '               no removal offered until that manifest can be read',
        );
        expect(text).not.toContain('rm --');
      } finally {
        nodeFs.chmodSync(serviceDir, 0o700);
      }
    },
  );

  test('an invalid manifest in the unit home refuses status, as it does in the invoked home (#4200 review)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const { channelHome, dependencies, installedHome } =
      await statusAfterReinstallElsewhere('linux');
    const unitManifestPath = join(installedHome, 'service', 'default.json');
    writeFileSync(unitManifestPath, '{', { mode: 0o600 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        runServiceCommand(['status'], channelDefaults(channelHome), {
          ...dependencies,
        }),
      ).rejects.toThrow(`Invalid Station service manifest ${unitManifestPath}`);
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    ['linux', 'start'],
    ['linux', 'stop'],
    ['linux', 'uninstall'],
    ['darwin', 'start'],
    ['darwin', 'stop'],
    ['darwin', 'uninstall'],
  ] as const)(
    'on %s, %s from a stale manifest home refuses and acts on nothing (#4200 review)',
    async (platform, action) => {
      const { channelHome, dependencies, installedHome, unitPath } =
        await statusAfterReinstallElsewhere(platform);
      const manifestPath = join(channelHome, 'service', 'default.json');
      const unit = readFileSync(unitPath, 'utf8');
      for (const mock of [
        startSystemd,
        stopSystemd,
        uninstallSystemd,
        startLaunchd,
        stopLaunchd,
        uninstallLaunchd,
        stop,
      ])
        mock.mockClear();
      const result = await capture(
        [action],
        channelDefaults(channelHome),
        dependencies,
      );
      expect(result.exitCode).toBe(1);
      expect(result.errors).toBe(
        `Refusing to ${action} Station user service default from ${channelHome}: ${manifestPath} describes an earlier install, and the installed unit ${unitPath} runs from ${installedHome}. Nothing was changed. Pass --base=${installedHome} to ${action} the installed service.`,
      );
      for (const mock of [
        startSystemd,
        stopSystemd,
        uninstallSystemd,
        startLaunchd,
        stopLaunchd,
        uninstallLaunchd,
        stop,
      ])
        expect(mock).not.toHaveBeenCalled();
      expect(readFileSync(unitPath, 'utf8')).toBe(unit);
      expect(nodeFs.existsSync(manifestPath)).toBe(true);
    },
  );

  test('with no manifest in the unit home, the refusal names the escapes that work, and both do (#4200 delta review)', async () => {
    const { channelHome, dependencies, installedHome, unitPath } =
      await statusAfterReinstallElsewhere('linux');
    const unitManifestPath = join(installedHome, 'service', 'default.json');
    nodeFs.rmSync(unitManifestPath);
    const manifestPath = join(channelHome, 'service', 'default.json');
    const refused = await capture(
      ['start'],
      channelDefaults(channelHome),
      dependencies,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.errors).toBe(
      `Refusing to start Station user service default from ${channelHome}: ${manifestPath} describes an earlier install, and the installed unit ${unitPath} runs from ${installedHome}. Nothing was changed. ${unitManifestPath} is missing, so --base=${installedHome} cannot start or stop it either. Either reinstall it from this home with \`service install --instance=default\` (the unit then runs from ${channelHome}), or remove the installed unit with \`service uninstall --instance=default --base=${installedHome}\`.`,
    );
    expect(startSystemd).not.toHaveBeenCalled();

    // Escape 2: uninstall from the unit's home removes the installed unit,
    // and says so rather than calling it absent.
    uninstallSystemd.mockClear();
    const removed = await capture(
      ['uninstall'],
      channelDefaults(installedHome),
      dependencies,
    );
    expect(removed.exitCode).toBeUndefined();
    expect(uninstallSystemd).toHaveBeenCalledTimes(1);
    expect(uninstallSystemd.mock.calls[0]?.[0]).toMatchObject({ unitPath });
    expect(removed.lines).toContain(
      `✓ Uninstalled Station user service default (its unit ${unitPath} had no manifest in ${installedHome})`,
    );

    // Escape 1: install from this home rewrites the unit to run from it,
    // after which nothing here is stale.
    const reinstalled = await capture(
      ['install'],
      channelDefaults(channelHome),
      dependencies,
    );
    expect(reinstalled.exitCode).toBeUndefined();
    expect(readFileSync(unitPath, 'utf8')).toContain(`"--base=${channelHome}"`);
    const status = await capture(
      ['status'],
      channelDefaults(channelHome),
      dependencies,
    );
    expect(status.lines.join('\n')).not.toContain('manifest       stale');
  });

  test('a unit that names no --base is not called stale (#4200 review)', async () => {
    const { channelHome, dependencies, unitPath } =
      await statusAfterReinstallElsewhere('linux');
    // Station always writes --base (renderServiceCommand); a unit without one
    // names no home to compare against.
    const unit = readFileSync(unitPath, 'utf8');
    expect(unit).toMatch(/ "--base=[^"]+"/u);
    writeFileSync(unitPath, unit.replace(/ "--base=[^"]+"/u, ''));
    const status = await capture(
      ['status'],
      channelDefaults(channelHome),
      dependencies,
    );
    expect(status.lines.join('\n')).not.toContain('manifest       stale');
    expect(status.lines.join('\n')).not.toContain('rm --');
  });

  test('an unreadable unit is named by its path in the fallback (#4196)', async () => {
    const { resolveInstalledServiceRemedy } = await import(
      '../commands/service-remedy.js'
    );
    const unitPath = join(
      makeTempDir('station-service-units-'),
      'station-default.service',
    );
    const remedy = resolveInstalledServiceRemedy(
      {
        instanceId: 'default',
        platform: 'linux',
        unitName: 'station-default.service',
        unitPath,
      },
      undefined,
      { fs: serviceFs, run: vi.fn(() => ({ status: 0, stdout: '' })) },
    );
    expect(remedy.command).toBeNull();
    expect(remedy.reason).toContain(
      `the installed unit ${unitPath} could not be read (`,
    );
  });

  test('with no manifest in this home, a stale-scheduling fallback names the installed unit (#4196)', async () => {
    vi.stubEnv('STATION_ROOT', '');
    const { runServiceCommand } = await import('../commands/service.js');
    const { renderSystemdUnit } = await vi.importActual<
      typeof import('../commands/service-systemd.js')
    >('../commands/service-systemd.js');
    const { installedHome, location } = nightlyArchiveInstall();
    const unitPath = join(
      makeTempDir('station-service-units-'),
      'station-default.service',
    );
    // A unit some other home's install wrote; this home has no manifest.
    writeFileSync(
      unitPath,
      renderSystemdUnit({
        ...location,
        instanceId: 'default',
        lifecycle: installedSettings(installedHome),
        servicePath: '/usr/bin:/bin',
      }),
    );
    systemdRegistration.mockReturnValue({
      platform: 'linux',
      unitName: 'station-default.service',
      unitPath,
    });
    systemdStatus.mockReturnValue({
      active: true,
      enabled: true,
      present: true,
    });
    const run = vi.fn((command: string, args: string[]) =>
      command === 'systemctl' && args[1] === 'cat'
        ? {
            status: 0,
            stdout: `# ${unitPath}\n${readFileSync(unitPath, 'utf8')}\n[Service]\nNice=10\n`,
          }
        : { status: 0, stdout: '' },
    );
    const home = makeTempDir('station-service-other-home-');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status'], channelDefaults(home), {
        fs: serviceFs,
        platform: 'linux',
        run,
      });
      const lines = log.mock.calls.flat().map(String);
      expect(lines).toContain(
        'scheduling     stale (Nice=10, expected systemd defaults)',
      );
      expect(lines).toContain(
        `               reinstall command unavailable: no Station service manifest in ${home} records this service. Inspect the installed unit ${unitPath} before reinstalling.`,
      );
    } finally {
      log.mockRestore();
    }
  });

  test('a launcher unit whose install state names no ring gives no command', async () => {
    const { resolveInstalledUnitRemedy } = await import(
      '../commands/service-remedy.js'
    );
    const installRoot = makeTempDir('station-service-unowned-install-');
    const remedy = resolveInstalledUnitRemedy({
      argv: [
        join(installRoot, 'current', 'runtime', 'bin', 'node'),
        join(installRoot, 'runtime', 'station-launcher.mjs'),
        'service',
        'run',
        '--instance=default',
        '--base=/srv/station-home',
        '--port=3141',
        '--ui-port=3000',
        '--host=127.0.0.1',
      ],
      environment: { STATION_ROOT: '' },
      path: '/home/u/.config/systemd/user/station-default.service',
    });
    expect(remedy.command).toBeNull();
    expect(remedy.reason).toContain('does not name its release ring');
  });

  test('a launcher unit recording another STATION_ROOT than its launcher sets gives no command', async () => {
    const { resolveInstalledUnitRemedy } = await import(
      '../commands/service-remedy.js'
    );
    const { installedHome, location, root } = nightlyArchiveInstall();
    const unit = (stationRoot: string) => ({
      argv: [
        location.nodePath,
        join(location.installRoot, 'runtime', 'station-launcher.mjs'),
        'service',
        'run',
        '--instance=default',
        `--base=${installedHome}`,
        '--port=3141',
        '--ui-port=3000',
        '--host=127.0.0.1',
      ],
      environment: { STATION_ROOT: stationRoot },
      path: '/home/u/.config/systemd/user/station-default.service',
    });
    // station-nightly exports the install's own root, so no prefix applies.
    expect(resolveInstalledUnitRemedy(unit(root)).command).toBe(
      `station-nightly service install --instance=default --base=${installedHome} --port=3141 --ui-port=3000 --host=127.0.0.1`,
    );
    const other = makeTempDir('station-service-other-root-');
    const remedy = resolveInstalledUnitRemedy(unit(other));
    expect(remedy.command).toBeNull();
    expect(remedy.reason).toContain(
      `but station-nightly sets STATION_ROOT=${root}`,
    );
  });

  test('a unit argument the remedy cannot reproduce gives no command', async () => {
    const { resolveInstalledUnitRemedy } = await import(
      '../commands/service-remedy.js'
    );
    const remedy = resolveInstalledUnitRemedy({
      argv: [
        '/usr/bin/node',
        '/srv/station/bin/station.mjs',
        'service',
        'run',
        '--instance=default',
        '--base=/srv/station-home',
        '--port=3141',
        '--ui-port=3000',
        '--host=127.0.0.1',
        '--consent-port=3144',
      ],
      environment: {},
      path: '/home/u/.config/systemd/user/station-default.service',
    });
    expect(remedy.command).toBeNull();
    expect(remedy.reason).toContain('--consent-port=3144');
    // #4196: the explanation names the unit to inspect, not a manifest.
    expect(remedy.reason).toContain(
      'the installed unit /home/u/.config/systemd/user/station-default.service runs',
    );
  });

  test('on Windows the scheduling remedy names the channel launcher that owns the archive install', async () => {
    vi.stubEnv('STATION_ROOT', '');
    const { runServiceCommand } = await import('../commands/service.js');
    const { installedHome, location } = nightlyArchiveInstall();
    installWindowsService.mockImplementation((instanceId, input) => ({
      ...location,
      host: input.lifecycle.host,
      installedAt: '',
      instanceId,
      platform: 'win32',
      serverPort: input.lifecycle.serverPort,
      taskName: `\\KontourStation-${instanceId}`,
      uiPort: input.lifecycle.uiPort,
      unitPath: `/tmp/${instanceId}.cmd`,
    }));
    // Task Scheduler's defaults: a task registered before #2970.
    const run = vi.fn((command: string) =>
      /powershell/iu.test(command)
        ? {
            status: 0,
            stdout:
              'Priority=7, ExecutionTimeLimit=PT72H, RestartCount=0, RestartInterval=, DisallowStartIfOnBatteries=True, StopIfGoingOnBatteries=True\n',
          }
        : { status: 0, stdout: '' },
    );
    const dependencies = {
      fs: serviceFs,
      installReadinessTimeoutMs: 2_000,
      platform: 'win32' as const,
      run,
    };
    await runServiceCommand(['install'], installedSettings(installedHome), {
      ...dependencies,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runServiceCommand(['status'], installedSettings(installedHome), {
        ...dependencies,
      });
      const text = log.mock.calls.flat().join('\n');
      expect(text).toContain('scheduling     stale');
      expect(text).toContain(
        `               run: station-nightly service install --instance=default --base=${installedHome} --port=3141 --ui-port=3000 --host=127.0.0.1 --allowed-origin=https://station-host.example.test`,
      );
    } finally {
      log.mockRestore();
    }
  });
});
