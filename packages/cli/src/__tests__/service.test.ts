import * as nodeFs from 'node:fs';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { ServiceFs } from '../commands/service.js';

const buildApplication = vi.fn();
const collectInstanceStatus = vi.fn();
const isBuildStale = vi.fn();
const resolveBuildPaths = vi.fn();
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
  WINDOWS_INTERACTIVE_TASK_PRIORITY: 5,
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-target-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
    const unitPath = join(baseDir, 'installed.plist');
    const registration = {
      label: 'io.kontourai.station.service-test',
      platform: 'darwin' as const,
      unitPath,
    };
    launchdRegistration.mockReturnValue(registration);
    installLaunchd.mockImplementation((instanceId, input) => ({
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
    }));
    const run = vi.fn((command: string) =>
      command === 'plutil'
        ? { status: 0, stdout: JSON.stringify({ ProcessType: 'Background' }) }
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
    writeFileSync(
      unitPath,
      '<plist><dict><key>ProcessType</key><string>Background</string></dict></plist>',
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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

  test('reads and migrates a legacy-labelled manifest on a real upgrade instead of throwing (#1983)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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

  test('reinstalls over its OWN live service entry (#3064 regression guard)', async () => {
    // Once the supervisor publishes a real pid (#3064), the #3047 live-owner
    // pre-check would refuse every reinstall of a RUNNING service — the
    // ordinary upgrade path — unless ownership is type-aware. A live
    // service-typed entry at this id is this unit's own supervisor, which
    // the backend install protocol stops and replaces itself.
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    // Replaced, not merged: the retired generation's liveness must not ride
    // into the new record (#3047), while its origin policy is preserved.
    expect(entry.pid).toBeUndefined();
    expect(entry.birth).toBeUndefined();
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
  });

  test('replaces a dead CLI entry with a clean service record — nothing inherited (#3047)', async () => {
    // The chimera pin at the wiring level: a crashed CLI instance's leftover
    // entry must not block the install, and the resulting service entry must
    // carry NONE of the dead entry's fields (pid/birth/checkout/status) —
    // an inherited pid is exactly what flipped Desktop's ownership decision.
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
      env: { ALLOWED_ORIGINS: '' },
    });
    expect(entry.pid).toBeUndefined();
    expect(entry.birth).toBeUndefined();
  });

  test('rejects a manifest whose allowedOrigins field is malformed (#1672)', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(uninstallWindowsService).toHaveBeenCalledOnce();
  });

  test('converges the exact Windows instance before reinstalling its task', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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

    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
      installWindowsService.mock.invocationCallOrder[1],
    );
  });

  test('reconciles an orphan registration without a manifest on status and uninstall', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
  });

  test('reports active or enabled registrations without a manifest as unhealthy orphans', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const unit of [
      { active: true, present: false },
      { active: false, enabled: true, present: false },
    ]) {
      const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
        port: 3242,
        type: 'service',
        uiPort: 5274,
      },
      scheduling: {
        expected: 'ProcessType=Interactive',
        reason: 'plutil unavailable',
        status: 'unknown',
      },
      unit,
    });
    expect(process.exitCode).toBe(1);
    log.mockRestore();
  });

  test('treats a systemd operator override as healthy without a reinstall remedy', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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

  test('rolls back the backend when manifest publication fails', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
    await runServiceCommand(['uninstall'], lifecycle(baseDir), {
      platform: 'darwin',
    });
    expect(uninstallLaunchd).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({ instanceName: 'service-test' });
  });

  test('starts an installed service and prints its post-action JSON status', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
      const missingBase = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
    const baseDir = mkdtempSync(join(tmpdir(), 'station-service-test-'));
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
