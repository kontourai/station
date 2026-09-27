import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LAUNCHER_STOP_BUDGET_MS } from '../../packages/cli/src/commands/service-command.js';
import { writeServiceUpdateRequest } from '../../packages/cli/src/commands/service-launcher-link.js';
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
  waitFor,
} from './fixtures/service-launcher-harness.js';

// The launcher is plain ESM with no types of its own.
type LauncherModule = {
  DEFAULT_TIMINGS: Record<string, number>;
  MAX_TRIAL_ATTEMPTS: number;
  compareVersions: (left: string, right: string) => number;
};

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
    // The unit's stop timeout covers the launcher's whole stop.
    expect(LAUNCHER_STOP_BUDGET_MS).toBe(
      launcher.DEFAULT_TIMINGS.stopGraceMs +
        10_000 +
        launcher.DEFAULT_TIMINGS.ownStopTimeoutMs,
    );
    expect(
      launcher.compareVersions('0.6.0-nightly.10', '0.6.0-nightly.9'),
    ).toBe(1);
    expect(launcher.compareVersions('1.0.0', '1.0.0-preview.3')).toBe(1);
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
