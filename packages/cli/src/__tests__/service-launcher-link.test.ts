import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  readInstanceRegistry,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { readServiceUpdateProgress } from '@kontourai/station-shared/service-launcher-protocol';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  createServiceLauncherLink,
  readServiceLauncherContext,
  SERVICE_LAUNCHER_ENV,
  type ServiceLauncherContext,
  serviceUpdatePaths,
  stageServiceUpdate,
  writeServiceUpdateRequest,
} from '../commands/service-launcher-link.js';
import {
  handOffServiceLivenessToLauncher,
  publishServiceLivenessRecord,
} from '../commands/service-liveness.js';
import { superviseService } from '../commands/service-run.js';

const makeTempDir = trackTempDirs();

function linkHarness(
  role: 'active' | 'trial',
  stage = vi.fn(async () => '1.1.0'),
  env?: NodeJS.ProcessEnv,
) {
  const installRoot = makeTempDir('station-link-');
  const context: ServiceLauncherContext = {
    protocol: 1,
    installRoot,
    version: '1.0.0',
    role,
    ...(role === 'trial' ? { updateId: 'u-1' } : {}),
  };
  const sent: unknown[] = [];
  let deliver: (message: unknown) => void = () => undefined;
  let disconnect: () => void = () => undefined;
  const handOffLiveness = vi.fn();
  const gone = vi.fn();
  const link = createServiceLauncherLink(
    {
      context,
      send: (message) => sent.push(message),
      onMessage: (listener) => {
        deliver = listener;
      },
      onDisconnect: (listener) => {
        disconnect = listener;
      },
      handOffLiveness,
      stage,
      log: () => undefined,
      ...(env ? { env } : {}),
    },
    gone,
  );
  const result = () => {
    try {
      return JSON.parse(
        readFileSync(serviceUpdatePaths(installRoot).result, 'utf8'),
      );
    } catch {
      return undefined;
    }
  };
  return {
    installRoot,
    link,
    sent,
    deliver: (message: unknown) => deliver(message),
    disconnect: () => disconnect(),
    handOffLiveness,
    gone,
    stage,
    result,
  };
}

describe('the versioned child of the service launcher (#2675 D)', () => {
  test('reads only a well-formed launcher context', () => {
    expect(readServiceLauncherContext({})).toBeNull();
    expect(
      readServiceLauncherContext({ [SERVICE_LAUNCHER_ENV]: '{"protocol":2}' }),
    ).toBeNull();
    expect(
      readServiceLauncherContext({
        [SERVICE_LAUNCHER_ENV]: JSON.stringify({
          protocol: 1,
          installRoot: '/i',
          version: '1.0.0',
          role: 'active',
        }),
      }),
    ).toMatchObject({ role: 'active', version: '1.0.0' });
  });

  test('an active child stages a queued request once and asks the launcher for a trial', async () => {
    const harness = linkHarness('active');
    const request = writeServiceUpdateRequest(harness.installRoot);
    // A second request while one is queued is refused.
    expect(() => writeServiceUpdateRequest(harness.installRoot)).toThrow(
      /already requested/,
    );
    harness.link.tick();
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.sent).toEqual([
        {
          type: 'request-update',
          targetVersion: '1.1.0',
          requestId: request.id,
        },
      ]),
    );
    expect(harness.stage).toHaveBeenCalledTimes(1);
    expect(existsSync(serviceUpdatePaths(harness.installRoot).request)).toBe(
      false,
    );

    // Accepted: the liveness entry goes to the launcher before the child is
    // stopped, and the launcher is told so.
    harness.deliver({
      type: 'update-accepted',
      updateId: 'u-9',
      launcherPid: 4242,
    });
    expect(harness.handOffLiveness).toHaveBeenCalledWith(4242);
    expect(harness.sent.at(-1)).toEqual({
      type: 'handoff-ready',
      updateId: 'u-9',
    });
    expect(existsSync(serviceUpdatePaths(harness.installRoot).processing)).toBe(
      false,
    );
  });

  test('records a rejected or failed request where the server reads it', async () => {
    const rejected = linkHarness('active');
    const first = writeServiceUpdateRequest(rejected.installRoot);
    rejected.link.tick();
    await vi.waitFor(() => expect(rejected.sent).toHaveLength(1));
    rejected.deliver({ type: 'update-rejected', reason: 'no' });
    expect(rejected.result()).toMatchObject({
      requestId: first.id,
      status: 'rejected',
      reason: 'no',
    });

    const failed = linkHarness(
      'active',
      vi.fn(async () => {
        throw new Error('manifest signature is invalid');
      }),
    );
    const second = writeServiceUpdateRequest(failed.installRoot);
    failed.link.tick();
    await vi.waitFor(() =>
      expect(failed.result()).toMatchObject({
        requestId: second.id,
        status: 'failed',
        reason: 'manifest signature is invalid',
      }),
    );
    expect(failed.sent).toEqual([]);
    // A later request is picked up again.
    writeServiceUpdateRequest(failed.installRoot);
  });

  test('a version already staged is requested without staging it again', async () => {
    const harness = linkHarness('active');
    const staged = join(harness.installRoot, 'versions', '1.2.0');
    mkdirSync(join(staged, 'bin'), { recursive: true });
    writeFileSync(join(staged, 'bin', 'station.mjs'), '');
    writeFileSync(join(staged, '.station-install-complete'), 'abc\n');
    writeServiceUpdateRequest(harness.installRoot, '1.2.0');
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.sent).toMatchObject([
        { type: 'request-update', targetVersion: '1.2.0' },
      ]),
    );
    expect(harness.stage).not.toHaveBeenCalled();
  });

  test('a trial reports prepared, never picks up requests, and stops when the launcher is gone', () => {
    const harness = linkHarness('trial');
    writeServiceUpdateRequest(harness.installRoot);
    harness.link.tick();
    expect(harness.stage).not.toHaveBeenCalled();
    harness.link.onReady();
    expect(harness.sent).toEqual([{ type: 'prepared', updateId: 'u-1' }]);
    harness.disconnect();
    expect(harness.gone).toHaveBeenCalledTimes(1);
  });

  test('hands the liveness entry to the launcher only while this supervisor owns it', () => {
    const home = makeTempDir('station-link-home-');
    upsertInstance(
      'svc',
      {
        port: 3242,
        type: 'service',
        env: { ALLOWED_ORIGINS: 'https://paired.example' },
      },
      home,
    );
    const target = {
      instanceName: 'svc',
      home,
      serverPort: 3242,
      uiPort: 5274,
    };
    // Not published by this process: left alone.
    handOffServiceLivenessToLauncher(target, process.ppid);
    expect(readInstanceRegistry(home).instances.svc.pid).toBeUndefined();

    publishServiceLivenessRecord(target, true);
    handOffServiceLivenessToLauncher(target, process.ppid);
    const entry = readInstanceRegistry(home).instances.svc;
    expect(entry.pid).toBe(process.ppid);
    expect(entry.status).toBe('running');
    expect(entry.env).toEqual({ ALLOWED_ORIGINS: 'https://paired.example' });
    // The retiring supervisor's retract no longer clears it.
    publishServiceLivenessRecord(target, false);
    expect(readInstanceRegistry(home).instances.svc.pid).toBe(process.ppid);
  });

  test('the supervisor reports prepared only after readiness and checks for requests each tick', async () => {
    const order: string[] = [];
    const link = {
      context: {} as ServiceLauncherContext,
      onReady: vi.fn(() => order.push('ready')),
      tick: vi.fn(() => order.push('tick')),
    };
    const ticks: Array<() => void> = [];
    await superviseService(
      {
        baseDir: makeTempDir('station-link-supervisor-'),
        homeSource: '--base',
        host: '127.0.0.1',
        instanceName: 'svc',
        serverPort: 3242,
        uiPort: 5274,
      },
      {
        collect: vi.fn().mockResolvedValue({
          bootId: 'b',
          found: true,
          healthy: true,
          instanceId: 'svc',
          sha: 'abc',
          server: { listening: true, pid: 1, probe: 'ok', reachable: true },
          ui: { listening: true, pid: 2, probe: 'ok', reachable: true },
        }) as never,
        desktopCompanion: { check: vi.fn() },
        exit: vi.fn(),
        launcherLink: link,
        listListeningPids: () => [],
        onSignal: vi.fn(),
        processIsAlive: () => true,
        publishServiceLiveness: vi.fn((live: boolean) => {
          if (live) order.push('published');
        }),
        setTimer: vi.fn((callback: () => void) => {
          ticks.push(callback);
          return 1 as never;
        }),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
    );
    expect(order).toEqual(['published', 'ready', 'tick']);
    ticks.shift()?.();
    await vi.waitFor(() => expect(link.tick).toHaveBeenCalledTimes(2));
  });

  test('`station service update-home` backs up and restores the home it is given', async () => {
    const { runServiceCommand } = await import('../commands/service.js');
    const root = makeTempDir('station-update-home-');
    const home = join(root, 'home');
    ensureStationHomeSchemaSync(home);
    mkdirSync(join(home, 'config'));
    writeFileSync(join(home, 'config', 'app.json'), '{"a":1}\n');
    const backupDir = join(root, 'backup');
    const lifecycle = {
      baseDir: home,
      homeSource: '--base' as const,
      serverPort: 3242,
      uiPort: 5274,
    };
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runServiceCommand(
        ['update-home', 'backup', `--backup-dir=${backupDir}`],
        lifecycle,
        { platform: 'linux' },
      );
      writeFileSync(join(home, 'config', 'app.json'), '{"a":2}\n');
      await runServiceCommand(
        ['update-home', 'restore', `--backup-dir=${backupDir}`],
        lifecycle,
        { platform: 'linux' },
      );
    } finally {
      write.mockRestore();
    }
    expect(readFileSync(join(home, 'config', 'app.json'), 'utf8')).toBe(
      '{"a":1}\n',
    );
    await expect(
      runServiceCommand(
        ['update-home', 'backup', '--backup-dir=relative'],
        lifecycle,
        {
          platform: 'linux',
        },
      ),
    ).rejects.toThrow('--backup-dir must be an absolute path');
  });
});

function stageVersion(installRoot: string, version: string): void {
  const dir = join(installRoot, 'versions', version);
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'station.mjs'), '');
  writeFileSync(join(dir, '.station-install-complete'), 'abc\n');
}

describe('stage and apply as separate requests (#3851)', () => {
  test('a stage request stages and records staged, and never asks the launcher for a trial', async () => {
    const harness = linkHarness('active');
    const request = writeServiceUpdateRequest(harness.installRoot, undefined, {
      mode: 'stage',
    });
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.result()).toMatchObject({
        requestId: request.id,
        status: 'staged',
        version: '1.1.0',
      }),
    );
    expect(harness.stage).toHaveBeenCalledTimes(1);
    // The running version keeps running: nothing was sent to the launcher.
    expect(harness.sent).toEqual([]);
    expect(existsSync(serviceUpdatePaths(harness.installRoot).processing)).toBe(
      false,
    );
  });

  test('a stage request that finds nothing newer reports up-to-date', async () => {
    const harness = linkHarness(
      'active',
      vi.fn(async () => '1.0.0'),
    );
    writeServiceUpdateRequest(harness.installRoot, undefined, {
      mode: 'stage',
    });
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.result()).toMatchObject({ status: 'up-to-date' }),
    );
    expect(harness.sent).toEqual([]);
  });

  test('an apply request trials a staged version without staging anything', async () => {
    const harness = linkHarness('active');
    stageVersion(harness.installRoot, '1.1.0');
    const request = writeServiceUpdateRequest(harness.installRoot, '1.1.0', {
      mode: 'apply',
    });
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.sent).toEqual([
        {
          type: 'request-update',
          targetVersion: '1.1.0',
          requestId: request.id,
        },
      ]),
    );
    expect(harness.stage).not.toHaveBeenCalled();
  });

  test('an apply request for a version that is not staged fails and downloads nothing', async () => {
    const harness = linkHarness('active');
    const request = writeServiceUpdateRequest(harness.installRoot, '1.1.0', {
      mode: 'apply',
    });
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.result()).toMatchObject({
        requestId: request.id,
        status: 'failed',
        reason: expect.stringContaining('not downloaded and verified'),
      }),
    );
    expect(harness.stage).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
  });

  test('a stage removes the staged versions it supersedes, never the running or an older one (review F7)', async () => {
    const harness = linkHarness(
      'active',
      vi.fn(async () => '1.2.0'),
    );
    for (const version of ['0.9.0', '1.0.0', '1.1.0', '1.2.0'])
      stageVersion(harness.installRoot, version);
    mkdirSync(join(harness.installRoot, 'versions', '.stage.123'));
    // Sealed as install.sh leaves a version: read-only.
    const sealed = join(harness.installRoot, 'versions', '1.1.0');
    chmodSync(join(sealed, 'bin'), 0o555);
    chmodSync(sealed, 0o555);
    writeServiceUpdateRequest(harness.installRoot, undefined, {
      mode: 'stage',
    });
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.result()).toMatchObject({
        status: 'staged',
        version: '1.2.0',
      }),
    );
    expect(readdirSync(join(harness.installRoot, 'versions')).sort()).toEqual([
      '.stage.123',
      '0.9.0',
      '1.0.0',
      '1.2.0',
    ]);
  });

  test('an apply request must name its version', () => {
    const installRoot = makeTempDir('station-link-apply-');
    expect(() =>
      writeServiceUpdateRequest(installRoot, undefined, { mode: 'apply' }),
    ).toThrow(/names the staged version/);
  });

  test('staging records the installer’s phases and the bytes downloaded so far', async () => {
    const installRoot = makeTempDir('station-stage-progress-');
    const versionDir = join(installRoot, 'versions', '1.0.0');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      JSON.stringify({ channel: 'stable', manifestUrl: 'https://x.invalid/m' }),
    );
    const archive = join(installRoot, 'download.tgz');
    // install.sh's stage-only protocol, with the download grown in two steps
    // the sampler can observe.
    writeFileSync(
      join(versionDir, 'install.sh'),
      [
        'echo "Downloading..."',
        'echo STATION_STAGE_DOWNLOAD_SIZE=1000',
        `echo "STATION_STAGE_DOWNLOAD_FILE=${archive}"`,
        'echo STATION_STAGE_PHASE=downloading',
        `head -c 400 /dev/zero > '${archive}'`,
        'sleep 1.2',
        `head -c 1000 /dev/zero > '${archive}'`,
        'sleep 1.2',
        'echo STATION_STAGE_PHASE=verifying',
        'echo STATION_STAGE_PHASE=installing',
        'echo STATION_STAGED_VERSION=1.1.0',
        '',
      ].join('\n'),
    );
    const reports: unknown[] = [];
    await expect(
      stageServiceUpdate({
        installRoot,
        version: '1.0.0',
        env: { PATH: process.env.PATH },
        onProgress: (report) => reports.push(report),
      }),
    ).resolves.toBe('1.1.0');
    const downloads = reports.filter(
      (report) => (report as { phase: string }).phase === 'downloading',
    );
    expect(downloads).toContainEqual({
      phase: 'downloading',
      downloadedBytes: 400,
      totalBytes: 1000,
    });
    expect(downloads).toContainEqual({
      phase: 'downloading',
      downloadedBytes: 1000,
      totalBytes: 1000,
    });
    expect(reports.slice(-2)).toEqual([
      { phase: 'verifying' },
      { phase: 'installing' },
    ]);
  });

  test('while staging the server reads the step the child recorded, then staged', async () => {
    let finish: (version: string) => void = () => undefined;
    let report:
      | ((value: {
          phase: 'downloading';
          downloadedBytes: number;
          totalBytes: number;
        }) => void)
      | undefined;
    const harness = linkHarness(
      'active',
      vi.fn(
        (input: { onProgress?: (value: never) => void }) =>
          new Promise<string>((resolve) => {
            report = input.onProgress as typeof report;
            finish = resolve;
          }),
      ) as never,
    );
    stageVersion(harness.installRoot, '1.1.0');
    const request = writeServiceUpdateRequest(harness.installRoot, undefined, {
      mode: 'stage',
    });
    harness.link.tick();
    await vi.waitFor(() => expect(report).toBeDefined());
    report?.({ phase: 'downloading', downloadedBytes: 250, totalBytes: 1000 });
    expect(readServiceUpdateProgress(harness.installRoot)).toEqual({
      state: 'staging',
      requestId: request.id,
      intent: 'stage',
      stagePhase: 'downloading',
      downloadedBytes: 250,
      totalBytes: 1000,
    });
    finish('1.1.0');
    await vi.waitFor(() =>
      expect(readServiceUpdateProgress(harness.installRoot)).toMatchObject({
        state: 'staged',
        requestId: request.id,
        version: '1.1.0',
      }),
    );
    expect(
      existsSync(serviceUpdatePaths(harness.installRoot).stageProgress),
    ).toBe(false);
  });
});

describe('staging and interrupted requests (#2675 D review F5, F8)', () => {
  test('staging passes install.sh none of the installer switches the service environment carries', async () => {
    const installRoot = makeTempDir('station-stage-env-');
    const versionDir = join(installRoot, 'versions', '1.0.0');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      JSON.stringify({
        channel: 'stable',
        stationRoot: '/station',
        stationHome: '/station/home',
        manifestUrl: 'https://example.invalid/manifest.json',
      }),
    );
    const dump = join(installRoot, 'env.txt');
    writeFileSync(
      join(versionDir, 'install.sh'),
      `env > '${dump}'\necho STATION_STAGED_VERSION=1.1.0\n`,
    );
    const env = {
      PATH: process.env.PATH,
      STATION_INSTALL_NO_START: '1',
      STATION_INSTALL_ALLOW_ROLLBACK: '1',
      STATION_INSTALL_ASSET_URL: 'https://attacker.invalid/a.tgz',
      STATION_INSTALL_SERVER_PORT: '9999',
      STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: 'https://attacker.invalid/key',
      STATION_VERSION: 'v0.0.1',
      // The service CLI's bootstrap launch facts, not install ports.
      STATION_SERVER_PORT: '18141',
      STATION_PORT: '18141',
      STATION_UI_PORT: '18000',
      STATION_CONSENT_PORT: '18144',
      STATION_INSTANCE_ID: 'stable',
      KEEP_ME: 'yes',
    };
    await expect(
      stageServiceUpdate({ installRoot, version: '1.0.0', env }),
    ).resolves.toBe('1.1.0');
    const seen = Object.fromEntries(
      readFileSync(dump, 'utf8')
        .trim()
        .split('\n')
        .map((line) => [
          line.slice(0, line.indexOf('=')),
          line.slice(line.indexOf('=') + 1),
        ]),
    );
    expect(
      Object.keys(seen)
        .filter((key) => key.startsWith('STATION_INSTALL_'))
        .sort(),
    ).toEqual([
      'STATION_INSTALL_PUBLIC_MANIFEST_URL',
      'STATION_INSTALL_ROOT',
      'STATION_INSTALL_STAGE_ONLY',
    ]);
    expect(seen.STATION_INSTALL_PUBLIC_MANIFEST_URL).toBe(
      'https://example.invalid/manifest.json',
    );
    expect(seen.STATION_VERSION).toBeUndefined();
    for (const key of [
      'STATION_SERVER_PORT',
      'STATION_PORT',
      'STATION_UI_PORT',
      'STATION_CONSENT_PORT',
      'STATION_INSTANCE_ID',
    ]) {
      expect(seen, key).not.toHaveProperty(key);
    }
    expect(seen.KEEP_ME).toBe('yes');

    // install.sh's own test mode carries its test-only verifier override.
    await stageServiceUpdate({
      installRoot,
      version: '1.0.0',
      env: {
        ...env,
        STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
      },
    });
    expect(readFileSync(dump, 'utf8')).toContain(
      'STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL=https://attacker.invalid/key',
    );
    expect(readFileSync(dump, 'utf8')).not.toContain(
      'STATION_INSTALL_NO_START',
    );
  });

  test('on Windows the service stages with the version’s install.ps1 through the system PowerShell (#2675 W3)', async () => {
    const installRoot = makeTempDir('station-stage-win32-');
    const versionDir = join(installRoot, 'versions', '1.0.0');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      JSON.stringify({ channel: 'stable', manifestUrl: 'https://x.invalid/m' }),
    );
    // No PowerShell here: the spawn fails, naming what it would have run.
    const error = (await stageServiceUpdate({
      installRoot,
      version: '1.0.0',
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PATH: '' },
    }).catch((caught: unknown) => caught)) as NodeJS.ErrnoException & {
      spawnargs: string[];
    };
    expect(error.path).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(error.spawnargs).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(versionDir, 'install.ps1'),
      'install',
    ]);
  });

  test('a claim the launcher accepted is only cleared; any other is answered as failed', () => {
    const installRoot = makeTempDir('station-link-orphan-');
    const paths = serviceUpdatePaths(installRoot);
    mkdirSync(paths.runtime, { recursive: true });
    const accepted = '66666666-6666-4666-8666-666666666666';
    writeFileSync(
      paths.processing,
      JSON.stringify({ id: accepted, requestedAt: 'now' }),
    );
    writeFileSync(
      paths.state,
      JSON.stringify({
        protocol: 1,
        activeVersion: '1.0.0',
        update: { requestId: accepted, status: 'pending' },
      }),
    );
    const make = () =>
      createServiceLauncherLink(
        {
          context: {
            protocol: 1,
            installRoot,
            version: '1.0.0',
            role: 'active',
          },
          send: () => undefined,
          onMessage: () => undefined,
          onDisconnect: () => undefined,
          handOffLiveness: () => undefined,
          log: () => undefined,
        },
        () => undefined,
      );
    make();
    expect(existsSync(paths.processing)).toBe(false);
    expect(existsSync(paths.result)).toBe(false);

    const orphan = '77777777-7777-4777-8777-777777777777';
    writeFileSync(
      paths.processing,
      JSON.stringify({ id: orphan, requestedAt: 'now' }),
    );
    make();
    expect(existsSync(paths.processing)).toBe(false);
    expect(JSON.parse(readFileSync(paths.result, 'utf8'))).toMatchObject({
      requestId: orphan,
      status: 'failed',
    });
    expect(() => writeServiceUpdateRequest(installRoot)).not.toThrow();
  });
});

describe('staging under the managed update limit (#4522)', () => {
  const MIRROR = 'https://mirror.example.test/station/t0ken/';

  /** An install whose install.sh records its environment, and a policy. */
  function stagingFixture(ring: string, updates: Record<string, unknown>) {
    const installRoot = makeTempDir('station-stage-managed-');
    const versionDir = join(installRoot, 'versions', '1.0.0');
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      JSON.stringify({
        channel: ring === 'nightly' ? 'nightly' : 'stable',
        releaseChannel: ring,
        manifestUrl: `https://github.com/kontourai/station/releases/download/portable-${ring}/station-portable-${ring}-manifest.json`,
      }),
    );
    const dump = join(installRoot, 'env.txt');
    writeFileSync(
      join(versionDir, 'install.sh'),
      `env > '${dump}'\necho STATION_STAGED_VERSION=1.1.0\n`,
    );
    const policy = join(installRoot, 'policy.json');
    writeFileSync(
      policy,
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        limits: { updates },
      }),
    );
    const env = {
      PATH: process.env.PATH,
      STATION_MANAGED_POLICY_TEST_FILE: policy,
    };
    const seen = () =>
      Object.fromEntries(
        readFileSync(dump, 'utf8')
          .trim()
          .split('\n')
          .map((line) => [
            line.slice(0, line.indexOf('=')),
            line.slice(line.indexOf('=') + 1),
          ]),
      );
    return { installRoot, env, dump, seen };
  }

  test('off: nothing is staged and the installer never runs', async () => {
    const { installRoot, env, dump } = stagingFixture('stable', {
      mode: 'off',
    });
    await expect(
      stageServiceUpdate({ installRoot, version: '1.0.0', env }),
    ).rejects.toThrow(
      "This machine's managed policy turns off Station updates.",
    );
    expect(existsSync(dump)).toBe(false);
  });

  test('a mirror: the installer reads the mirror’s manifest and downloads from the mirror only', async () => {
    const { installRoot, env, seen } = stagingFixture('stable', {
      feedUrl: MIRROR,
    });
    await expect(
      stageServiceUpdate({
        installRoot,
        version: '1.0.0',
        env,
        platform: 'linux',
      }),
    ).resolves.toBe('1.1.0');
    expect(seen()).toMatchObject({
      STATION_INSTALL_PUBLIC_MANIFEST_URL: `${MIRROR}portable-stable/station-portable-stable-manifest.json`,
      STATION_INSTALL_MIRROR_URL: MIRROR,
    });
    expect(JSON.stringify(seen())).not.toContain('github.com');
  });

  test('a mirror refuses a manifest named another way, and the Windows installer', async () => {
    const fixture = stagingFixture('stable', { feedUrl: MIRROR });
    await expect(
      stageServiceUpdate({
        installRoot: fixture.installRoot,
        version: '1.0.0',
        env: {
          ...fixture.env,
          STATION_INSTALL_PUBLIC_MANIFEST_URL:
            'https://github.com/kontourai/station/releases/download/portable-stable/station-portable-stable-manifest.json',
        },
        platform: 'linux',
      }),
    ).rejects.toThrow(/unset STATION_INSTALL_PUBLIC_MANIFEST_URL/);
    await expect(
      stageServiceUpdate({
        installRoot: fixture.installRoot,
        version: '1.0.0',
        env: fixture.env,
        platform: 'win32',
      }),
    ).rejects.toThrow(/Windows installer cannot update from a mirror yet/);
    expect(existsSync(fixture.dump)).toBe(false);
  });

  test('allowNightly: false refuses a nightly ring and stages another', async () => {
    const nightly = stagingFixture('nightly', { allowNightly: false });
    await expect(
      stageServiceUpdate({
        installRoot: nightly.installRoot,
        version: '1.0.0',
        env: nightly.env,
      }),
    ).rejects.toThrow(
      "This machine's managed policy makes the nightly channel unavailable.",
    );
    expect(existsSync(nightly.dump)).toBe(false);
    const stable = stagingFixture('stable', { allowNightly: false });
    await expect(
      stageServiceUpdate({
        installRoot: stable.installRoot,
        version: '1.0.0',
        env: stable.env,
      }),
    ).resolves.toBe('1.1.0');
  });

  test('an unusable policy refuses the stage', async () => {
    const { installRoot, env, dump } = stagingFixture('stable', {});
    writeFileSync(env.STATION_MANAGED_POLICY_TEST_FILE, '{"schemaVersion":');
    await expect(
      stageServiceUpdate({ installRoot, version: '1.0.0', env }),
    ).rejects.toThrow(/STATION_MANAGED_POLICY_INVALID/);
    expect(existsSync(dump)).toBe(false);
  });

  /** A staged 1.2.0 in a link harness, whose policy is written afterwards. */
  function stagedLink(state: Record<string, unknown> | null) {
    const policyDir = makeTempDir('station-link-policy-');
    const policy = join(policyDir, 'policy.json');
    const env = { PATH: process.env.PATH, STATION_MANAGED_POLICY_TEST_FILE: policy };
    const harness = linkHarness('active', vi.fn(async () => '1.2.0'), env);
    if (state)
      writeFileSync(
        join(harness.installRoot, '.station-release-state.json'),
        JSON.stringify(state),
      );
    const staged = join(harness.installRoot, 'versions', '1.2.0');
    mkdirSync(join(staged, 'bin'), { recursive: true });
    writeFileSync(join(staged, 'bin', 'station.mjs'), '');
    writeFileSync(join(staged, '.station-install-complete'), 'abc\n');
    const installPolicy = (updates: Record<string, unknown>) =>
      writeFileSync(
        policy,
        JSON.stringify({
          schemaVersion: 1,
          organization: 'Acme',
          limits: { updates },
        }),
      );
    return { ...harness, installPolicy };
  }

  test.each([
    ['apply', { mode: 'apply' as const }],
    ['update', {}],
  ])(
    'off installed after a version was staged: an %s request for it is refused and nothing is requested',
    async (_name, options) => {
      const harness = stagedLink({ channel: 'stable', releaseChannel: 'stable' });
      harness.installPolicy({ mode: 'off' });
      const request = writeServiceUpdateRequest(
        harness.installRoot,
        '1.2.0',
        options,
      );
      harness.link.tick();
      await vi.waitFor(() =>
        expect(harness.result()).toMatchObject({
          requestId: request.id,
          status: 'failed',
          reason: "This machine's managed policy turns off Station updates.",
        }),
      );
      expect(harness.sent).toEqual([]);
      expect(harness.stage).not.toHaveBeenCalled();
    },
  );

  test('allowNightly: false refuses applying a staged nightly-numbered version on an install state with no ring', async () => {
    const harness = stagedLink(null);
    harness.installPolicy({ allowNightly: false });
    const staged = join(harness.installRoot, 'versions', '1.3.0-nightly.7');
    mkdirSync(join(staged, 'bin'), { recursive: true });
    writeFileSync(join(staged, 'bin', 'station.mjs'), '');
    writeFileSync(join(staged, '.station-install-complete'), 'abc\n');
    const request = writeServiceUpdateRequest(
      harness.installRoot,
      '1.3.0-nightly.7',
      { mode: 'apply' },
    );
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.result()).toMatchObject({
        requestId: request.id,
        status: 'failed',
        reason:
          "This machine's managed policy makes the nightly channel unavailable.",
      }),
    );
    expect(harness.sent).toEqual([]);
  });

  test('a staged stable version is still applied when the policy allows it', async () => {
    const harness = stagedLink({ channel: 'stable', releaseChannel: 'stable' });
    harness.installPolicy({ allowNightly: false });
    writeServiceUpdateRequest(harness.installRoot, '1.2.0', { mode: 'apply' });
    harness.link.tick();
    await vi.waitFor(() =>
      expect(harness.sent).toMatchObject([
        { type: 'request-update', targetVersion: '1.2.0' },
      ]),
    );
  });

  test('allowNightly: false refuses a stage whose install state names no ring', async () => {
    const { installRoot, env, dump } = stagingFixture('stable', {
      allowNightly: false,
    });
    writeFileSync(
      join(installRoot, '.station-release-state.json'),
      JSON.stringify({ channel: 'stable' }),
    );
    await expect(
      stageServiceUpdate({ installRoot, version: '1.0.0', env }),
    ).rejects.toThrow(
      "This machine's managed policy makes the nightly channel unavailable, and Station cannot tell which release channel this install updates from.",
    );
    // A nightly-numbered installed version is nightly even with no ring.
    await expect(
      stageServiceUpdate({ installRoot, version: '1.0.0-nightly.3', env }),
    ).rejects.toThrow(
      "This machine's managed policy makes the nightly channel unavailable.",
    );
    expect(existsSync(dump)).toBe(false);
  });
});
