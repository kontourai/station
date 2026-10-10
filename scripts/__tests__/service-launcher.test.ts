import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  LAUNCHER_STOP_BUDGET_MS,
  SYSTEMD_STOP_TIMEOUT_SECONDS,
} from '../../packages/cli/src/commands/service-command.js';
import {
  serviceUpdatePaths,
  writeServiceUpdateRequest,
} from '../../packages/cli/src/commands/service-launcher-link.js';
import {
  lookupProcessBirthFingerprint,
  ownProcessBirthProbeSchedule,
  WINDOWS_OWN_PROCESS_BIRTH_DEADLINE_MS,
} from '../../packages/shared/src/process-identity.mjs';
import { readServiceUpdateProgress } from '../../packages/shared/src/service-launcher-protocol.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { readRegistryInstances } from '../../src-server/tools/instance-registry-bridge.js';
import {
  addVersion,
  bundleLauncherFixtureCli,
  fixtureLog,
  homeSchemaVersion,
  INSTANCE,
  type LauncherInstall,
  makeLauncherInstall,
  pointCurrent,
  type RunningLauncher,
  readState,
  startLauncher,
  TEST_TIMINGS,
  waitFor,
} from './fixtures/service-launcher-harness.js';

// The launcher is plain ESM with no types of its own.
type LauncherModule = {
  DEFAULT_TIMINGS: Record<string, number>;
  MAX_TRIAL_ATTEMPTS: number;
  MAX_RESTORE_ATTEMPTS: number;
  compareVersions: (left: string, right: string) => number | null;
  processBirth: (pid: number) => string | null;
  ownBirthSchedule: (platform: string) => {
    retryDelayMs: number;
    deadlineMs: number;
    attempts: Array<{ timeoutMs: number; shell: 'powershell' | 'pwsh7' }>;
  };
  reclaimStaleLock: (lock: string, judged: string) => void;
  recordServiceActiveVersion: (installRoot: string, version: string) => void;
};

async function launcherModule(): Promise<LauncherModule> {
  return (await import(
    '../../packaging/portable-server/bin/station-launcher.mjs'
  )) as LauncherModule;
}

function lockPath(install: LauncherInstall): string {
  return join(install.installRoot, 'runtime', 'service-state.lock');
}

/** A live process that is not a Station launcher, for pid-reuse cases. */
function unrelatedProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  return child;
}

const makeTempDir = trackTempDirs();
let cli = '';
const running: RunningLauncher[] = [];

beforeAll(async () => {
  cli = await bundleLauncherFixtureCli();
}, 60_000);

afterEach(async () => {
  for (const launcher of running.splice(0)) {
    if (
      launcher.process.exitCode === null &&
      launcher.process.signalCode === null
    ) {
      launcher.process.kill('SIGTERM');
      // A launcher blocked in a synchronous step (a gated backup) handles the
      // signal only afterwards; do not wait for it.
      const timer = setTimeout(() => launcher.process.kill('SIGKILL'), 10_000);
      await launcher.exited;
      clearTimeout(timer);
    }
  }
});

function launch(install: LauncherInstall, env: Record<string, string> = {}) {
  const launcher = startLauncher(install, env);
  running.push(launcher);
  return launcher;
}

function diagnostics(install: LauncherInstall, launcher?: RunningLauncher) {
  return () =>
    `state: ${JSON.stringify(readState(install))}\nlog:\n${fixtureLog(install).join('\n')}\nlauncher:\n${launcher?.output() ?? ''}`;
}

/** v1 active and running, v2 staged with `behavior`. */
async function runningV1(
  v2: Parameters<typeof addVersion>[3],
  v1: Parameters<typeof addVersion>[3] = {},
  env: Record<string, string> = {},
) {
  const install = makeLauncherInstall(makeTempDir('station-launcher-'));
  addVersion(install, cli, '1.0.0', v1);
  addVersion(install, cli, '1.1.0', v2);
  pointCurrent(install, '1.0.0');
  const launcher = launch(install, env);
  await waitFor(
    'v1 ready',
    () => {
      if (launcher.process.exitCode !== null)
        throw new Error(`the launcher exited:\n${launcher.output()}`);
      return fixtureLog(install).includes('1.0.0 ready');
    },
    30_000,
    diagnostics(install, launcher),
  );
  return { install, launcher };
}

function finished(install: LauncherInstall) {
  const update = readState(install)?.update;
  return update && update.status !== 'pending' ? update : undefined;
}

function currentVersion(install: LauncherInstall): string {
  return readlinkSync(join(install.installRoot, 'current')).split('/').at(-1)!;
}

describe('the fixed service launcher (#2675 D)', { timeout: 90_000 }, () => {
  it('pins the production timings the plan requires', async () => {
    const launcher = (await import(
      '../../packaging/portable-server/bin/station-launcher.mjs'
    )) as LauncherModule;
    expect(launcher.DEFAULT_TIMINGS.stopGraceMs).toBe(65_000);
    expect(launcher.DEFAULT_TIMINGS.preparedTimeoutMs).toBe(240_000);
    expect(launcher.MAX_TRIAL_ATTEMPTS).toBe(2);
    expect(launcher.MAX_RESTORE_ATTEMPTS).toBe(3);
    // The unit's stop timeout covers the launcher's whole stop.
    expect(LAUNCHER_STOP_BUDGET_MS).toBe(
      launcher.DEFAULT_TIMINGS.stopGraceMs +
        10_000 +
        launcher.DEFAULT_TIMINGS.ownStopTimeoutMs,
    );
    // A stop during the liveness handoff no longer waits for it, and the
    // unit's timeout still leaves more than that wait as margin.
    expect(SYSTEMD_STOP_TIMEOUT_SECONDS * 1_000).toBeGreaterThan(
      LAUNCHER_STOP_BUDGET_MS + launcher.DEFAULT_TIMINGS.handoffAckMs,
    );
    expect(
      launcher.compareVersions('0.6.0-nightly.10', '0.6.0-nightly.9'),
    ).toBe(1);
    expect(launcher.compareVersions('1.0.0', '1.0.0-preview.3')).toBe(1);
    // Another ring's prerelease cannot be ordered, so it is never "newer".
    expect(
      launcher.compareVersions('1.0.0-nightly.1', '1.0.0-preview.3'),
    ).toBeNull();
    expect(launcher.compareVersions('1.2.0', '1.10.0')).toBe(-1);
  });

  it('commits a trial that reports prepared: state, current and the backup follow', async () => {
    const { install, launcher } = await runningV1({ trial: 'prepare' });
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'committed',
      fromVersion: '1.0.0',
      targetVersion: '1.1.0',
      attempts: 1,
    });
    expect(readState(install)?.activeVersion).toBe('1.1.0');
    // `current` moves and the backup goes right after the commit is recorded.
    await waitFor(
      'current and the backup to follow',
      () =>
        currentVersion(install) === '1.1.0' &&
        !existsSync(
          join(install.installRoot, 'runtime', 'update-backups', update.id),
        ),
    );
    const log = fixtureLog(install);
    // Stopped, backed up with the old version's own code, then trialled.
    const order = [
      '1.0.0 run active',
      `1.0.0 handoff ${launcher.process.pid}`,
      '1.0.0 term',
      '1.0.0 update-home backup',
      '1.1.0 run trial',
      '1.1.0 ready',
    ].map((line) => log.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A committed trial keeps what it wrote.
    expect(existsSync(join(install.home, 'config', 'trial-wrote.json'))).toBe(
      true,
    );

    launcher.process.kill('SIGTERM');
    expect(await launcher.exited).toEqual({ code: 0, signal: null });
    expect(fixtureLog(install)).toContain('1.1.0 term');
  });

  it('after a commit keeps only the new version and its rollback target, and never an installer stage', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '0.9.0');
    addVersion(install, cli, '1.0.0');
    addVersion(install, cli, '1.1.0', { trial: 'prepare' });
    // Sealed, as install.sh leaves every version.
    chmodSync(join(install.installRoot, 'versions', '0.9.0', 'bin'), 0o555);
    chmodSync(join(install.installRoot, 'versions', '0.9.0'), 0o555);
    mkdirSync(join(install.installRoot, 'versions', '.stage.123'));
    pointCurrent(install, '1.0.0');
    const launcher = launch(install);
    await waitFor('v1 ready', () =>
      fixtureLog(install).includes('1.0.0 ready'),
    );
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    await waitFor(
      'the prune after the commit',
      () =>
        readdirSync(join(install.installRoot, 'versions')).sort().join(',') ===
        '.stage.123,1.0.0,1.1.0',
      30_000,
      diagnostics(install, launcher),
    );
    expect(finished(install)?.status).toBe('committed');
  });

  it('rolls back a trial that migrates the home schema and then crashes', async () => {
    const { install, launcher } = await runningV1({
      trial: 'exit',
      homeSchemaVersion: 99,
    });
    const schemaBefore = homeSchemaVersion(install);
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'rolled-back',
      reason: 'candidate-exited:3',
    });
    expect(fixtureLog(install)).toContain('1.1.0 schema 99');
    await waitFor(
      'v1 restarted',
      () =>
        fixtureLog(install).filter((line) => line === '1.0.0 run active')
          .length === 2,
    );
    expect(homeSchemaVersion(install)).toBe(schemaBefore);
    expect(existsSync(join(install.home, 'config', 'trial-wrote.json'))).toBe(
      false,
    );
    expect(readFileSync(join(install.home, 'config', 'app.json'), 'utf8')).toBe(
      '{"model":"before"}\n',
    );
    expect(readState(install)?.activeVersion).toBe('1.0.0');
    expect(currentVersion(install)).toBe('1.0.0');
  });

  it('rolls back a trial that never reports prepared', async () => {
    const { install, launcher } = await runningV1({ trial: 'hang' });
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'rolled-back',
      reason: 'prepared-timeout',
    });
    expect(fixtureLog(install)).toContain('1.1.0 term');
    expect(readState(install)?.activeVersion).toBe('1.0.0');
  });

  it("kills an old child that ignores TERM and runs its version's own stop before the backup", async () => {
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      { ignoreTerm: true },
    );
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update.status).toBe('committed');
    const log = fixtureLog(install);
    const ignored = log.indexOf('1.0.0 term-ignored');
    const stop = log.indexOf('1.0.0 stop');
    const backup = log.indexOf('1.0.0 update-home backup');
    expect(ignored).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(ignored);
    expect(backup).toBeGreaterThan(stop);
    expect(launcher.output()).toContain('did not stop within');
  });

  it('keeps the home owned by a live service for the whole window, so a desktop app would not start a sidecar', async () => {
    const gate = join(makeTempDir('station-launcher-gate-'), 'open');
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      {},
      {
        STATION_FIXTURE_BACKUP_GATE: gate,
      },
    );
    const liveServices = () =>
      readRegistryInstances(install.home).filter(
        (entry) =>
          entry.type === 'service' &&
          typeof entry.port === 'number' &&
          typeof entry.pid === 'number' &&
          entry.pidAlive === true,
      );
    const [before] = liveServices();
    expect(before?.id).toBe(INSTANCE);
    expect(before?.pid).not.toBe(launcher.process.pid);

    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    await waitFor(
      'the backup to wait',
      () =>
        fixtureLog(install).includes(
          '1.0.0 waiting STATION_FIXTURE_BACKUP_GATE',
        ),
      30_000,
      diagnostics(install, launcher),
    );
    // Mid-window: the old child is gone, nothing new runs, and the entry
    // the desktop app decides on names the launcher, alive.
    expect(fixtureLog(install)).toContain('1.0.0 term');
    const during = liveServices();
    expect(during.map((entry) => [entry.id, entry.pid])).toEqual([
      [INSTANCE, launcher.process.pid],
    ]);

    writeFileSync(gate, '');
    const update = await waitFor('the update to finish', () =>
      finished(install),
    );
    expect(update.status).toBe('committed');
    await waitFor('v2 publishes itself', () => {
      const [entry] = liveServices();
      return entry && entry.pid !== launcher.process.pid ? entry : undefined;
    });
  });

  it('answers a request for a version that is not newer without stopping anything', async () => {
    const { install, launcher } = await runningV1({ trial: 'prepare' });
    const request = writeServiceUpdateRequest(install.installRoot, '1.0.0');
    const result = await waitFor(
      'a result',
      () => {
        try {
          return JSON.parse(
            readFileSync(
              join(
                install.installRoot,
                'runtime',
                'update-request-result.json',
              ),
              'utf8',
            ),
          );
        } catch {
          return undefined;
        }
      },
      30_000,
      diagnostics(install, launcher),
    );
    expect(result).toMatchObject({
      requestId: request.id,
      status: 'up-to-date',
      version: '1.0.0',
    });
    expect(readState(install)?.update).toBeUndefined();
    expect(fixtureLog(install)).not.toContain('1.0.0 term');
  });

  it('the launcher refuses a staged version that is not newer (a replayed older release)', async () => {
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      { stage: '0.9.0' },
    );
    addVersion(install, cli, '0.9.0', { trial: 'prepare' });
    const request = writeServiceUpdateRequest(install.installRoot);
    const result = await waitFor(
      'a result',
      () => {
        try {
          return JSON.parse(
            readFileSync(
              join(
                install.installRoot,
                'runtime',
                'update-request-result.json',
              ),
              'utf8',
            ),
          );
        } catch {
          return undefined;
        }
      },
      30_000,
      diagnostics(install, launcher),
    );
    expect(result).toMatchObject({
      requestId: request.id,
      status: 'rejected',
      reason: 'Station 0.9.0 is not newer than the running 1.0.0.',
    });
    expect(readState(install)?.update).toBeUndefined();
    expect(fixtureLog(install)).not.toContain('1.0.0 term');
  });

  it('refuses a second launcher on the same install root', async () => {
    const { install } = await runningV1({ trial: 'prepare' });
    const second = launch(install);
    expect((await second.exited).code).toBe(1);
    expect(second.output()).toContain('another Station launcher');
  });

  it('a backup that fails (the disk is full) keeps the old version running on an untouched home', async () => {
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      {},
      {
        STATION_FIXTURE_BACKUP_FAIL: '1',
      },
    );
    const schemaBefore = homeSchemaVersion(install);
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'failed',
      reason: 'backup-failed',
      attempts: 0,
    });
    expect(launcher.output()).toContain('ENOSPC');
    await waitFor(
      'v1 restarted',
      () =>
        fixtureLog(install).filter((line) => line === '1.0.0 run active')
          .length === 2,
    );
    expect(fixtureLog(install)).not.toContain('1.1.0 run trial');
    expect(homeSchemaVersion(install)).toBe(schemaBefore);
    expect(
      readdirSync(join(install.installRoot, 'runtime', 'update-backups')),
    ).toEqual([]);
  });
});

/**
 * The launcher is killed (SIGKILL, so nothing of it runs) right after each
 * durable write of the update, and a new one is started as the service
 * manager would. Every one must finish the same transaction.
 */
describe('a launcher killed after each durable write finishes the update (#2675 D)', {
  timeout: 120_000,
}, () => {
  async function crashThenRecover(point: string, trial: 'prepare' | 'exit') {
    const { install, launcher } = await runningV1(
      {
        trial,
        homeSchemaVersion: 99,
      },
      {},
      { STATION_LAUNCHER_TEST_CRASH_AFTER: point },
    );
    const schemaBefore = homeSchemaVersion(install);
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    expect((await launcher.exited).signal).toBe('SIGKILL');
    // Its versioned child sees the channel close and stops (a service
    // manager would also have killed it with the unit).
    const crashed = readState(install);
    const readyBefore = fixtureLog(install).length;
    const recovered = launch(install);
    // Serving again: some version reports ready after the recovery began.
    const servingAgain = (version: string) =>
      waitFor(
        `${version} serving after recovery`,
        () =>
          fixtureLog(install).slice(readyBefore).includes(`${version} ready`),
        60_000,
        diagnostics(install, recovered),
      );
    const update = await waitFor(
      'the recovered update to finish',
      () => finished(install),
      60_000,
      diagnostics(install, recovered),
    );
    return { install, recovered, update, crashed, schemaBefore, servingAgain };
  }

  it.each(['pending', 'backup', 'attempt', 'committed', 'current'])(
    'killed after %s: the trial is committed',
    async (point) => {
      const { install, update, crashed, servingAgain } = await crashThenRecover(
        point,
        'prepare',
      );
      expect(crashed?.update?.status).toBe(
        point === 'committed' || point === 'current' ? 'committed' : 'pending',
      );
      expect(update.status).toBe('committed');
      expect(update.attempts).toBeLessThanOrEqual(2);
      await servingAgain('1.1.0');
      expect(readState(install)?.activeVersion).toBe('1.1.0');
      // `current` and the backup follow the committed state.
      await waitFor(
        'current and the backup to follow',
        () =>
          currentVersion(install) === '1.1.0' &&
          readdirSync(join(install.installRoot, 'runtime', 'update-backups'))
            .length === 0,
      );
    },
  );

  it.each(['restoring', 'rolled-back'])(
    'killed after %s: the rollback restores the home and restarts the old version',
    async (point) => {
      const { install, update, schemaBefore, servingAgain } =
        await crashThenRecover(point, 'exit');
      expect(update.status).toBe('rolled-back');
      // The interrupted rollback is finished, never retried as a new trial.
      expect(update).toMatchObject({
        reason: 'candidate-exited:3',
        attempts: 1,
      });
      expect(
        fixtureLog(install).filter((line) => line === '1.1.0 run trial'),
      ).toHaveLength(1);
      await servingAgain('1.0.0');
      expect(readState(install)?.activeVersion).toBe('1.0.0');
      expect(currentVersion(install)).toBe('1.0.0');
      expect(homeSchemaVersion(install)).toBe(schemaBefore);
      expect(existsSync(join(install.home, 'config', 'trial-wrote.json'))).toBe(
        false,
      );
      expect(
        readdirSync(join(install.installRoot, 'runtime', 'update-backups')),
      ).toEqual([]);
    },
  );

  it('gives a trial at most two attempts, then rolls back', async () => {
    const { install, launcher } = await runningV1({
      trial: 'hang',
      homeSchemaVersion: 99,
    });
    const schemaBefore = homeSchemaVersion(install);
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    // The launcher dies during each trial, before the trial could prove
    // itself (a trial that takes the host down, say).
    let current = launcher;
    for (const attempt of [1, 2]) {
      await waitFor(
        `trial attempt ${attempt}`,
        () => {
          const update = readState(install)?.update;
          return update?.phase === 'trial' && update.attempts === attempt;
        },
        30_000,
        diagnostics(install, current),
      );
      await waitFor(
        'the trial to run',
        () =>
          fixtureLog(install).filter((line) => line === '1.1.0 run trial')
            .length === attempt,
      );
      current.process.kill('SIGKILL');
      await current.exited;
      current = launch(install);
    }
    const update = await waitFor(
      'the rollback',
      () => finished(install),
      30_000,
      diagnostics(install, current),
    );
    expect(update).toMatchObject({
      status: 'rolled-back',
      reason: 'trial-attempts-exhausted',
      attempts: 2,
    });
    expect(
      fixtureLog(install).filter((line) => line === '1.1.0 run trial').length,
    ).toBe(2);
    expect(homeSchemaVersion(install)).toBe(schemaBefore);
    expect(readState(install)?.activeVersion).toBe('1.0.0');
  });
});

describe('the launcher lock survives reboots and pid reuse (#2675 D review F2)', {
  timeout: 90_000,
}, () => {
  it('reads a process start time exactly as the shared process identity does', async () => {
    const { processBirth } = await launcherModule();
    const birth = processBirth(process.pid);
    expect(birth).toBeTruthy();
    expect(birth).toBe(lookupProcessBirthFingerprint(process.pid));
    const other = unrelatedProcess();
    try {
      await waitFor('the other process', () => processBirth(other.pid!));
      expect(processBirth(other.pid!)).toBe(
        lookupProcessBirthFingerprint(other.pid!),
      );
      expect(processBirth(other.pid!)).not.toBe(birth);
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('probes its own start time on the shared schedule, including Windows (review L4)', async () => {
    const { ownBirthSchedule } = await launcherModule();
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const shared = ownProcessBirthProbeSchedule(platform);
      const launcher = ownBirthSchedule(platform);
      expect(
        launcher.attempts.map(({ timeoutMs, shell }) => ({
          timeoutMs,
          // The shared schedule names the retry shell `pwsh.exe` and the
          // default (System32 Windows PowerShell) `undefined`.
          windowsShell: shell === 'pwsh7' ? 'pwsh.exe' : undefined,
        })),
      ).toEqual(shared.attempts);
      expect(launcher.retryDelayMs).toBe(shared.retryDelayMs);
      // resolveOwnProcessIdentity's overall deadline, on every platform.
      expect(launcher.deadlineMs).toBe(WINDOWS_OWN_PROCESS_BIRTH_DEADLINE_MS);
    }
    // Pinned literals beside the derived comparison.
    expect(ownBirthSchedule('win32')).toEqual({
      retryDelayMs: 250,
      deadlineMs: 30_250,
      attempts: [
        { timeoutMs: 10_000, shell: 'powershell' },
        { timeoutMs: 20_000, shell: 'pwsh7' },
      ],
    });
    expect(ownBirthSchedule('linux').retryDelayMs).toBe(100);
  });

  it('takes over a lock whose pid now belongs to an unrelated live process', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    pointCurrent(install, '1.0.0');
    const other = unrelatedProcess();
    try {
      // Left by a launcher before a reboot; its pid is someone else's now.
      writeFileSync(
        lockPath(install),
        `${JSON.stringify({ pid: other.pid, birth: 'Mon Jan  1 00:00:00 2024', token: 't' })}\n`,
      );
      const launcher = launch(install);
      await waitFor(
        'v1 ready',
        () => fixtureLog(install).includes('1.0.0 ready'),
        30_000,
        diagnostics(install, launcher),
      );
      expect(JSON.parse(readFileSync(lockPath(install), 'utf8'))).toMatchObject(
        { pid: launcher.process.pid },
      );
    } finally {
      other.kill('SIGKILL');
    }
  });

  it('takes over a pid-only lock naming pid 1 (a container reboot)', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    pointCurrent(install, '1.0.0');
    writeFileSync(lockPath(install), '{"pid":1}\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(install), old, old);
    const launcher = launch(install);
    await waitFor(
      'v1 ready',
      () => fixtureLog(install).includes('1.0.0 ready'),
      30_000,
      diagnostics(install, launcher),
    );
  });

  it('a stale-lock reclaim removes only the lock it judged, never one taken since', async () => {
    const { reclaimStaleLock } = await launcherModule();
    const root = makeTempDir('station-launcher-lock-');
    const lock = join(root, 'service-state.lock');
    // Another launcher reclaimed the stale lock and took it between this
    // one's read and its removal.
    writeFileSync(lock, '{"pid":2,"birth":"b","token":"fresh"}\n');
    reclaimStaleLock(lock, '{"pid":1,"birth":"a","token":"stale"}\n');
    expect(readFileSync(lock, 'utf8')).toBe(
      '{"pid":2,"birth":"b","token":"fresh"}\n',
    );
    expect(readdirSync(root)).toEqual(['service-state.lock']);
    // The lock it judged is removed.
    reclaimStaleLock(lock, '{"pid":2,"birth":"b","token":"fresh"}\n');
    expect(existsSync(lock)).toBe(false);
  });

  it('install.sh records a version only under the lock, and never over an unfinished update (F9)', async () => {
    const { recordServiceActiveVersion } = await launcherModule();
    const { install, launcher } = await runningV1({ trial: 'prepare' });
    // A running launcher holds the lock.
    expect(() =>
      recordServiceActiveVersion(install.installRoot, '1.1.0'),
    ).toThrow(/another Station launcher/);
    expect(readState(install)?.activeVersion).toBe('1.0.0');
    launcher.process.kill('SIGTERM');
    await launcher.exited;
    const state = join(install.installRoot, 'runtime', 'service-state.json');
    const pending = {
      protocol: 1,
      activeVersion: '1.0.0',
      update: {
        id: '00000000-0000-4000-8000-000000000000',
        fromVersion: '1.0.0',
        targetVersion: '1.1.0',
        status: 'pending',
        phase: 'trial',
        attempts: 1,
      },
    };
    writeFileSync(state, JSON.stringify(pending));
    expect(() =>
      recordServiceActiveVersion(install.installRoot, '1.1.0'),
    ).toThrow(/unfinished/);
    expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual(pending);
    writeFileSync(
      state,
      JSON.stringify({ protocol: 1, activeVersion: '1.0.0' }),
    );
    recordServiceActiveVersion(install.installRoot, '1.1.0');
    expect(readState(install)).toEqual({ protocol: 1, activeVersion: '1.1.0' });
    expect(existsSync(lockPath(install))).toBe(false);
  });
});

describe('an update keeps moving when its pieces fail (#2675 D review F1, F4-F7)', {
  timeout: 120_000,
}, () => {
  it('rolls back a real home: plugin links come back as links, repositories stay as they are (F1)', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    addVersion(install, cli, '1.1.0', { trial: 'exit' });
    pointCurrent(install, '1.0.0');
    const repo = join(install.home, 'workspaces', 'app');
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', '.bin'));
    writeFileSync(join(repo, 'node_modules', 'pkg', 'cli.js'), 'run()\n');
    symlinkSync('../pkg/cli.js', join(repo, 'node_modules', '.bin', 'pkg'));
    const generation = join(install.home, 'plugins', '.generations', 'k', 'g');
    mkdirSync(generation, { recursive: true });
    writeFileSync(join(generation, 'index.js'), 'export {}\n');
    const alias = join(install.home, 'plugins', 'demo');
    symlinkSync(generation, alias, 'dir');
    const launcher = launch(install);
    await waitFor('v1 ready', () =>
      fixtureLog(install).includes('1.0.0 ready'),
    );
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'rolled-back',
      reason: 'candidate-exited:3',
    });
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(alias)).toBe(generation);
    expect(readlinkSync(join(repo, 'node_modules', '.bin', 'pkg'))).toBe(
      '../pkg/cli.js',
    );
    expect(existsSync(join(install.home, 'config', 'trial-wrote.json'))).toBe(
      false,
    );
  });

  it('a restore that keeps failing ends in needs-operator, runs nothing, and a restart after the fix finishes it (F4)', async () => {
    const { install, launcher } = await runningV1(
      { trial: 'exit', homeSchemaVersion: 99 },
      {},
      { STATION_FIXTURE_RESTORE_FAIL: '1' },
    );
    const schemaBefore = homeSchemaVersion(install);
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    // Each failed restore exits the launcher; the service manager (this
    // test) starts it again.
    let current = launcher;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await current.exited).code).toBe(1);
      expect(readState(install)?.update).toMatchObject({
        status: 'pending',
        phase: 'restoring',
        restoreAttempts: attempt,
      });
      current = launch(install, { STATION_FIXTURE_RESTORE_FAIL: '1' });
    }
    const stuck = await waitFor(
      'needs-operator',
      () => {
        const update = readState(install)?.update;
        return update?.status === 'needs-operator' ? update : undefined;
      },
      30_000,
      diagnostics(install, current),
    );
    expect(stuck).toMatchObject({
      reason: 'candidate-exited:3',
      restoreAttempts: 3,
    });
    // The server's reader (#2675 D3) reads the launcher's own record as
    // needs-operator, never as unavailable.
    expect(readServiceUpdateProgress(install.installRoot)).toEqual({
      state: 'needs-operator',
      requestId: expect.any(String),
      fromVersion: '1.0.0',
      targetVersion: '1.1.0',
      reason: 'candidate-exited:3',
      restoreAttempts: 3,
      finishedAt: stuck.finishedAt,
    });
    // The recovery is logged right after the state is written.
    await waitFor('the recovery instruction', () =>
      current.output().includes('station service stop --instance='),
    );
    // It waits, serving nothing, instead of exiting into a restart loop.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(current.process.exitCode).toBeNull();
    expect(
      fixtureLog(install).filter((line) => line === '1.0.0 run active'),
    ).toHaveLength(1);
    expect(
      existsSync(
        join(install.installRoot, 'runtime', 'update-backups', stuck.id),
      ),
    ).toBe(true);

    // The operator fixes the cause and restarts the service.
    current.process.kill('SIGTERM');
    expect((await current.exited).code).toBe(0);
    const fixed = launch(install);
    const update = await waitFor(
      'the rollback',
      () => finished(install)?.status === 'rolled-back' && finished(install),
      30_000,
      diagnostics(install, fixed),
    );
    expect(update).toMatchObject({ reason: 'candidate-exited:3' });
    await waitFor('v1 serving', () =>
      fixtureLog(install).slice(-3).includes('1.0.0 ready'),
    );
    expect(homeSchemaVersion(install)).toBe(schemaBefore);
  });

  it('a claimed request whose child died is answered and no longer blocks the next one (F5)', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    addVersion(install, cli, '1.1.0', { trial: 'prepare' });
    pointCurrent(install, '1.0.0');
    const paths = serviceUpdatePaths(install.installRoot);
    const orphan = {
      id: '11111111-1111-4111-8111-111111111111',
      requestedAt: new Date().toISOString(),
      targetVersion: '1.1.0',
    };
    writeFileSync(paths.processing, JSON.stringify(orphan));
    const launcher = launch(install);
    await waitFor('v1 ready', () =>
      fixtureLog(install).includes('1.0.0 ready'),
    );
    expect(existsSync(paths.processing)).toBe(false);
    expect(JSON.parse(readFileSync(paths.result, 'utf8'))).toMatchObject({
      requestId: orphan.id,
      status: 'failed',
    });
    // The orphan did not become an update, and the next request runs.
    expect(readState(install)?.update).toBeUndefined();
    const request = writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'committed',
      requestId: request.id,
    });
  });

  it('sweeps a staged backup copy and orphaned backups left by a killed launcher (F6)', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    pointCurrent(install, '1.0.0');
    const backups = join(install.installRoot, 'runtime', 'update-backups');
    const stage = join(
      backups,
      '.22222222-2222-4222-8222-222222222222.4242.33333333-3333-4333-8333-333333333333.tmp',
    );
    mkdirSync(join(stage, 'home'), { recursive: true });
    writeFileSync(join(stage, 'home', 'big.bin'), 'x'.repeat(1024));
    mkdirSync(join(backups, '44444444-4444-4444-8444-444444444444'));
    launch(install);
    await waitFor('v1 ready', () =>
      fixtureLog(install).includes('1.0.0 ready'),
    );
    expect(readdirSync(backups)).toEqual([]);
  });

  it('a stop during the liveness handoff does not wait for the handoff (F6)', async () => {
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      {},
      {
        STATION_FIXTURE_HANDOFF_BLOCK_MS: '20000',
        STATION_LAUNCHER_TEST_TIMINGS: JSON.stringify({
          stopGraceMs: 1_500,
          ownStopTimeoutMs: 30_000,
          handoffAckMs: 25_000,
          preparedTimeoutMs: 6_000,
        }),
      },
    );
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    await waitFor(
      'the handoff to block',
      () => fixtureLog(install).includes('1.0.0 handoff-blocked'),
      30_000,
      diagnostics(install, launcher),
    );
    const stoppedAt = Date.now();
    launcher.process.kill('SIGTERM');
    expect((await launcher.exited).code).toBe(0);
    // Without the wakeup it would wait out the whole 25 s acknowledgement.
    expect(Date.now() - stoppedAt).toBeLessThan(15_000);
  });

  it('refuses to snapshot a trial-modified home when the backup is gone (F7)', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    addVersion(install, cli, '1.1.0', { trial: 'prepare' });
    pointCurrent(install, '1.0.0');
    writeFileSync(
      join(install.installRoot, 'runtime', 'service-state.json'),
      JSON.stringify({
        protocol: 1,
        activeVersion: '1.0.0',
        update: {
          id: '55555555-5555-4555-8555-555555555555',
          fromVersion: '1.0.0',
          targetVersion: '1.1.0',
          status: 'pending',
          phase: 'trial',
          attempts: 1,
        },
      }),
    );
    const launcher = launch(install);
    const update = await waitFor(
      'the update to finish',
      () => finished(install),
      30_000,
      diagnostics(install, launcher),
    );
    expect(update).toMatchObject({
      status: 'failed',
      reason: 'backup-missing',
      attempts: 1,
    });
    await waitFor('v1 ready', () =>
      fixtureLog(install).includes('1.0.0 ready'),
    );
    expect(fixtureLog(install)).not.toContain('1.0.0 update-home backup');
    expect(fixtureLog(install)).not.toContain('1.1.0 run trial');
  });
});

/**
 * Task Scheduler neither restarts a launcher that exits nor signals one to
 * stop (#2675 W3), so on Windows the launcher supervises itself. These run
 * the same mode here (STATION_LAUNCHER_TEST_SELF_SUPERVISED=1); the Windows
 * install-smoke leg runs it under a real scheduled task.
 */
describe('a self-supervised launcher, as on Windows (#2675 W3)', {
  timeout: 120_000,
}, () => {
  const SELF = {
    STATION_LAUNCHER_TEST_SELF_SUPERVISED: '1',
    STATION_LAUNCHER_TEST_TIMINGS: JSON.stringify({
      ...TEST_TIMINGS,
      relaunchDelayMs: 100,
      relaunchMaxDelayMs: 400,
      parentPollMs: 100,
    }),
  };

  const runs = (install: LauncherInstall, line: string) =>
    fixtureLog(install).filter((entry) => entry === line).length;

  it('starts the active version again, in the same process, when it exits on its own', async () => {
    const crash = join(makeTempDir('station-launcher-crash-'), 'crash');
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      {},
      {
        ...SELF,
        STATION_FIXTURE_ACTIVE_EXIT: crash,
      },
    );
    writeFileSync(crash, '');
    await waitFor(
      'v1 relaunched',
      () => runs(install, '1.0.0 ready') === 2,
      30_000,
      diagnostics(install, launcher),
    );
    expect(launcher.process.exitCode).toBeNull();
    const log = fixtureLog(install);
    // The exited version's own stop runs before it starts again.
    expect(log.indexOf('1.0.0 stop')).toBeGreaterThan(
      log.indexOf('1.0.0 active-exit'),
    );
    expect(launcher.output()).toContain('relaunching in 100 ms');
    // A stop it is asked for is not followed by a relaunch.
    launcher.process.kill('SIGTERM');
    expect(await launcher.exited).toEqual({ code: 0, signal: null });
    expect(runs(install, '1.0.0 run active')).toBe(2);
  });

  it('without self-supervision exits instead, for systemd or launchd to restart', async () => {
    const crash = join(makeTempDir('station-launcher-crash-'), 'crash');
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      {},
      {
        STATION_FIXTURE_ACTIVE_EXIT: crash,
      },
    );
    writeFileSync(crash, '');
    expect((await launcher.exited).code).toBe(4);
    expect(runs(install, '1.0.0 run active')).toBe(1);
  });

  it('stops its child by closing their channel, and commits an update that way', async () => {
    const { install, launcher } = await runningV1(
      { trial: 'prepare' },
      {},
      SELF,
    );
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const update = await waitFor(
      'the update to finish',
      () => {
        const update = finished(install);
        if (
          update?.status === 'committed' &&
          currentVersion(install) !== update.targetVersion
        )
          return undefined;
        return update;
      },
      30_000,
      diagnostics(install, launcher),
    );
    expect(update.status).toBe('committed');
    const log = fixtureLog(install);
    // Windows has no SIGTERM: the old version saw its channel close.
    expect(log).not.toContain('1.0.0 term');
    expect(log.indexOf('1.0.0 launcher-gone')).toBeGreaterThanOrEqual(0);
    // ...and its own `stop` by record follows, before the home is backed up.
    expect(log.indexOf('1.0.0 stop')).toBeGreaterThan(
      log.indexOf('1.0.0 launcher-gone'),
    );
    expect(log.indexOf('1.0.0 update-home backup')).toBeGreaterThan(
      log.indexOf('1.0.0 stop'),
    );
    expect(currentVersion(install)).toBe('1.1.0');
  });

  it('retries a failing restore by relaunching, and ends in needs-operator without exiting', async () => {
    const { install, launcher } = await runningV1(
      { trial: 'exit', homeSchemaVersion: 99 },
      {},
      { ...SELF, STATION_FIXTURE_RESTORE_FAIL: '1' },
    );
    writeServiceUpdateRequest(install.installRoot, '1.1.0');
    const stuck = await waitFor(
      'needs-operator',
      () => {
        const update = readState(install)?.update;
        return update?.status === 'needs-operator' ? update : undefined;
      },
      60_000,
      diagnostics(install, launcher),
    );
    expect(stuck).toMatchObject({
      reason: 'candidate-exited:3',
      restoreAttempts: 3,
    });
    expect(runs(install, '1.0.0 update-home restore')).toBe(3);
    // One launcher process did all of it, and it waits, serving nothing.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(launcher.process.exitCode).toBeNull();
    expect(runs(install, '1.0.0 run active')).toBe(1);
  });

  it('stops in order when its parent, the task wrapper, is gone', async () => {
    const install = makeLauncherInstall(makeTempDir('station-launcher-'));
    addVersion(install, cli, '1.0.0');
    pointCurrent(install, '1.0.0');
    const { STATION_CHANNEL: _channel, ...inherited } = process.env;
    // The wrapper stands in for the task's cmd.exe: it starts the launcher
    // and is then ended the way `schtasks /End` ends it.
    const wrapper = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          'const [launcher, ...args] = process.argv.slice(1);',
          "spawn(process.execPath, [launcher, ...args], { stdio: 'ignore' });",
          'setInterval(() => {}, 1000);',
        ].join('\n'),
        install.launcher,
        'service',
        'run',
        `--instance=${INSTANCE}`,
        `--base=${install.home}`,
      ],
      {
        env: { ...inherited, ...SELF, STATION_FIXTURE_LOG: install.log },
        stdio: 'ignore',
      },
    );
    try {
      await waitFor(
        'v1 ready',
        () => fixtureLog(install).includes('1.0.0 ready'),
        30_000,
        diagnostics(install),
      );
      const holder = JSON.parse(readFileSync(lockPath(install), 'utf8')) as {
        pid: number;
      };
      wrapper.kill('SIGKILL');
      await waitFor(
        'the launcher to stop and release its lock',
        () => !existsSync(lockPath(install)),
        30_000,
        diagnostics(install),
      );
      await waitFor('the launcher process to exit', () => {
        try {
          process.kill(holder.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(fixtureLog(install)).toContain('1.0.0 launcher-gone');
      expect(runs(install, '1.0.0 run active')).toBe(1);
    } finally {
      wrapper.kill('SIGKILL');
    }
  });
});

describe('the Windows switch of `current` is install.ps1’s (#2675 W3)', () => {
  type Layout = 'current' | 'next' | 'both' | 'neither';
  type Rules = {
    point: (installRoot: string, version: string) => void;
    recover: (installRoot: string) => void;
  };

  function layout(kind: Layout): string {
    const installRoot = makeTempDir('station-current-');
    for (const version of ['1.0.0', '1.1.0'])
      mkdirSync(join(installRoot, 'versions', version), { recursive: true });
    const link = (name: string, version: string) =>
      symlinkSync(
        join(installRoot, 'versions', version),
        join(installRoot, name),
        'junction',
      );
    if (kind === 'current' || kind === 'both') link('current', '1.0.0');
    if (kind === 'next' || kind === 'both') link('current.next', '1.1.0');
    return installRoot;
  }

  function observe(installRoot: string) {
    const read = (name: string) => {
      try {
        return readlinkSync(join(installRoot, name)).split(/[\\/]/).at(-1);
      } catch {
        return null;
      }
    };
    return { current: read('current'), next: read('current.next') };
  }

  async function rules(): Promise<Record<'launcher' | 'installer', Rules>> {
    const launcher = (await launcherModule()) as LauncherModule & {
      pointCurrentAt: (root: string, version: string, platform: string) => void;
      recoverCurrent: (root: string) => void;
    };
    const installer = await import(
      '../../packages/shared/src/installer/full-install.js'
    );
    return {
      launcher: {
        point: (root, version) =>
          launcher.pointCurrentAt(root, version, 'win32'),
        recover: launcher.recoverCurrent,
      },
      installer: {
        point: (root, version) =>
          installer.pointCurrentAt(root, join(root, 'versions', version)),
        recover: installer.recoverCurrent,
      },
    };
  }

  it.each(['current', 'next', 'both', 'neither'] as const)(
    'recovers a %s layout the same way',
    async (kind) => {
      const both = await rules();
      const outcomes = Object.values(both).map((rule) => {
        const root = layout(kind);
        rule.recover(root);
        return observe(root);
      });
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0]).toEqual(
        {
          current: { current: '1.0.0', next: null },
          next: { current: '1.1.0', next: null },
          both: { current: '1.0.0', next: null },
          neither: { current: null, next: null },
        }[kind],
      );
    },
  );

  it('retries a refused rename exactly as install.ps1 does (#3363)', async () => {
    type Retrying = (
      source: string,
      destination: string,
      options: {
        platform?: string;
        rename?: (source: string, destination: string) => void;
        wait?: (milliseconds: number) => void;
      },
    ) => void;
    const launcher = (await launcherModule()) as unknown as {
      renamePathRetrying: Retrying;
    };
    const shared = (await import(
      '../../packages/shared/src/fs-windows-compat.js'
    )) as unknown as { renamePathSyncRetrying: Retrying };
    const refusal = (code: string) => Object.assign(new Error(code), { code });
    const scripts: Array<{ platform: string; codes: (string | null)[] }> = [
      { platform: 'win32', codes: ['EPERM', 'EBUSY', null] },
      { platform: 'win32', codes: Array(12).fill('EACCES') },
      { platform: 'win32', codes: ['EPERM', 'ENOENT'] },
      { platform: 'linux', codes: ['EPERM', null] },
    ];
    for (const { platform, codes } of scripts) {
      const run = (retrying: Retrying) => {
        const errors = codes.map((code) => (code ? refusal(code) : null));
        const waits: number[] = [];
        let calls = 0;
        let thrown: unknown = null;
        try {
          retrying('a', 'b', {
            platform,
            rename: () => {
              const error = errors[calls++];
              if (error) throw error;
            },
            wait: (ms) => waits.push(ms),
          });
        } catch (error) {
          thrown = errors.indexOf(error as (typeof errors)[number]);
        }
        return { calls, waits, thrown };
      };
      expect(run(launcher.renamePathRetrying), JSON.stringify(codes)).toEqual(
        run(shared.renamePathSyncRetrying),
      );
    }
  });

  it('switches `current` to the same version, leaving no current.next', async () => {
    const both = await rules();
    for (const rule of Object.values(both)) {
      const root = layout('current');
      rule.point(root, '1.1.0');
      expect(observe(root)).toEqual({ current: '1.1.0', next: null });
    }
  });
});
