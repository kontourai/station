import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePortBlock, findFreePortOutside } from '../lib/free-ports.mjs';
import { probeDogfoodHealth } from '../station-dogfood-health.mjs';
import { reconcile } from '../station-dogfood-reconcile.mjs';
import {
  reapAllLongRunningFixtureChildren,
  spawnLongRunningFixtureChild,
} from './helpers/longrunning-fixture-child.js';
import { StationFixtureOwner } from './helpers/station-fixture-owner.js';

const workspace = resolve(import.meta.dirname, '..', '..');
const fixture = join(
  import.meta.dirname,
  'fixtures',
  'dogfood-runtime-fixture.mjs',
);
const cleanupRoots = new Set<string>();
const fixtureOwner = new StationFixtureOwner();
fixtureOwner.installAbnormalExitReaper();
//
// The one fixture this file spawns directly (a `node -e
// 'setInterval(...)'` stand-in for a real backgrounded process, used to
// simulate a fingerprint-mismatch on the recorded serverPid) goes through
// helpers/longrunning-fixture-child.ts instead, which additionally reaps it
// on an abnormal suite teardown (station#1812) -- see that file for why
// `detached: true` makes this fixture invisible to a process-group signal
// sent to the test worker itself.

afterEach(async () => {
  fixtureOwner.dispose();
  await reapAllLongRunningFixtureChildren();
  for (const root of cleanupRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  cleanupRoots.clear();
});

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  } while (Date.now() < deadline);
  throw new Error('condition did not converge');
}

function materializeRelease(release: string, instance: string, sha: string) {
  mkdirSync(join(release, `dist-server-${instance}`), { recursive: true });
  mkdirSync(join(release, `dist-ui-${instance}`), { recursive: true });
  copyFileSync(
    fixture,
    join(release, `dist-server-${instance}`, 'command-station.js'),
  );
  writeFileSync(
    join(release, `dist-server-${instance}`, 'station-build.json'),
    JSON.stringify({
      sha,
      branch: 'main',
      builtAt: '2026-07-10T12:00:00.000Z',
    }),
  );
  writeFileSync(
    join(release, `dist-ui-${instance}`, 'index.html'),
    '<head></head><body>Station</body>',
  );
  symlinkSync(join(workspace, 'node_modules'), join(release, 'node_modules'));
  const shim = join(release, 'station');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${join(workspace, 'node_modules', 'tsx', 'dist', 'cli.mjs')}" "${join(workspace, 'scripts', 'station-cli.ts')}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
}

describe('production reconcile backend-only recovery', () => {
  it('stages B while A serves, then resumes the immutable build and promotes exact B', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-production-stage-'));
    cleanupRoots.add(root);
    fixtureOwner.registerFixtureRoot(root);
    const repo = join(root, 'repo');
    const supportDir = join(root, 'support');
    const logDir = join(root, 'logs');
    const stationHome = join(root, 'station-home');
    const previousSha = 'a'.repeat(40);
    const desiredSha = 'b'.repeat(40);
    const previous = join(supportDir, 'releases', previousSha);
    const desired = join(supportDir, 'releases', desiredSha);
    const instance = 'stagephone';
    const serverPort = await findFreePortBlock(4);
    const uiPort = await findFreePortOutside(serverPort, 4);
    for (const directory of [repo, supportDir, logDir, stationHome, previous]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    materializeRelease(previous, instance, previousSha);
    const config = {
      version: 1,
      repo,
      githubRepo: 'kontourai/station',
      instance,
      stationHome,
      supportDir,
      logDir,
      serverPort,
      uiPort,
      tailnetUrl: 'https://station.example.ts.net',
    };
    const statePath = join(supportDir, 'state.json');
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        active: { sha: previousSha, path: previous },
        previous: null,
        failedCandidates: [],
        recoveryHistory: [],
      })}\n`,
      { mode: 0o600 },
    );
    for (const name of [
      'station-update.log',
      'station-runtime.log',
      'station-lifecycle.jsonl',
    ]) {
      writeFileSync(join(logDir, name), '', { mode: 0o600 });
    }
    const baseArgs = (action: string) => [
      action,
      `--instance=${instance}`,
      `--base=${stationHome}`,
      `--port=${serverPort}`,
      `--ui-port=${uiPort}`,
    ];
    const previousStatePath = join(
      previous,
      '.station',
      'instances',
      `${instance}.json`,
    );
    const desiredStatePath = join(
      desired,
      '.station',
      'instances',
      `${instance}.json`,
    );
    fixtureOwner.registerStatePath(previousStatePath);
    fixtureOwner.registerStatePath(desiredStatePath);
    const start = spawnSync(
      './station',
      [
        ...baseArgs('start'),
        '--host=127.0.0.1',
        `--log=${join(logDir, 'station-runtime.log')}`,
        `--lifecycle-journal=${join(logDir, 'station-lifecycle.jsonl')}`,
        `--readiness-file=${statePath}`,
      ],
      {
        cwd: previous,
        env: {
          ...process.env,
          STATION_BUILD_BRANCH: 'main',
          STATION_HOME: stationHome,
        },
        encoding: 'utf8',
      },
    );
    expect(start.status, start.stderr).toBe(0);
    fixtureOwner.capturePublishedBoot(previousStatePath);
    let runningRelease = previous;
    let buildCalls = 0;
    const command = (
      executable: string,
      args: string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
    ) => {
      const result = (status = 0, stdout = '', stderr = '') => ({
        status,
        stdout,
        stderr,
      });
      if (executable === 'git') {
        if (args.includes('get-url'))
          return result(0, 'git@github.com:kontourai/station.git\n');
        if (args.includes('fetch')) return result();
        if (args.includes('worktree') && args.includes('add')) {
          materializeRelease(args.at(-2) as string, instance, desiredSha);
          return result();
        }
        if (args.includes('worktree') && args.includes('remove')) {
          rmSync(args.at(-1) as string, { recursive: true, force: true });
          return result();
        }
        if (args.at(-2) === 'rev-parse') {
          const cwd = args[args.indexOf('-C') + 1];
          return result(
            0,
            `${cwd === repo ? desiredSha : join(cwd).split('/').at(-1)?.split('--')[0]}\n`,
          );
        }
        if (args.includes('symbolic-ref')) return result(1);
        if (args.includes('status')) return result();
      }
      if (executable === 'gh') {
        return result(
          0,
          JSON.stringify([
            {
              databaseId: 42,
              headSha: desiredSha,
              status: 'completed',
              conclusion: 'success',
              event: 'push',
              workflowName: 'CI',
              url: 'https://example/run/42',
            },
          ]),
        );
      }
      if (executable === 'npm') return result();
      if (executable === './station' && args[0] === 'build') {
        buildCalls += 1;
        return result();
      }
      if (executable === 'curl') {
        if (args.at(-1)?.endsWith('/api/system/readiness')) {
          return result(0, JSON.stringify({ ready: true, status: 'ready' }));
        }
        const identity = JSON.parse(
          readFileSync(
            join(runningRelease, '.station', 'instances', `${instance}.json`),
            'utf8',
          ),
        );
        return result(
          0,
          JSON.stringify({
            instanceId: identity.instanceId,
            sha: identity.build.sha,
            bootId: identity.bootId,
          }),
        );
      }
      const spawned = spawnSync(executable, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
      });
      if (executable === './station' && spawned.status === 0) {
        if (args[0] === 'start') {
          runningRelease = options.cwd as string;
          fixtureOwner.capturePublishedBoot(
            join(runningRelease, '.station', 'instances', `${instance}.json`),
          );
        }
      }
      return result(
        spawned.status ?? 1,
        spawned.stdout ?? '',
        spawned.stderr ?? '',
      );
    };
    let now = Date.now();
    expect(
      reconcile(config, {
        run: command,
        stageOnly: true,
        now: () => ++now,
      }),
    ).toMatchObject({
      action: 'staged',
      sha: desiredSha,
      runningSha: previousSha,
    });
    expect(buildCalls).toBe(1);
    expect((await probeDogfoodHealth(previousStatePath)).identity.sha).toBe(
      previousSha,
    );

    expect(reconcile(config, { run: command, now: () => ++now })).toMatchObject(
      {
        action: 'promoted',
        sha: desiredSha,
        previousSha,
      },
    );
    expect(buildCalls).toBe(1);
    await eventually(
      () => probeDogfoodHealth(desiredStatePath),
      (health) => health.healthy && health.identity.sha === desiredSha,
    );
    const identity = await fetch(
      `http://127.0.0.1:${serverPort}/api/system/identity`,
    ).then((response) => response.json());
    expect(identity).toMatchObject({ sha: desiredSha });
    expect(existsSync(desired)).toBe(true);
  }, 30_000);

  it('drives production reconcile, Station CLI, health helper, and UI proxy at the exact SHA', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-production-recovery-'));
    cleanupRoots.add(root);
    fixtureOwner.registerFixtureRoot(root);
    const repo = join(root, 'repo');
    const supportDir = join(root, 'support');
    const logDir = join(root, 'logs');
    const stationHome = join(root, 'station-home');
    const sha = 'a'.repeat(40);
    const release = join(supportDir, 'releases', sha);
    const serverPort = await findFreePortBlock(4);
    const uiPort = await findFreePortOutside(serverPort, 4);
    for (const directory of [repo, supportDir, logDir, stationHome, release]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    mkdirSync(join(release, 'dist-server-phone'), { recursive: true });
    mkdirSync(join(release, 'dist-ui-phone'), { recursive: true });
    copyFileSync(
      fixture,
      join(release, 'dist-server-phone', 'command-station.js'),
    );
    writeFileSync(
      join(release, 'dist-server-phone', 'station-build.json'),
      JSON.stringify({
        sha,
        branch: 'main',
        builtAt: '2026-07-10T12:00:00.000Z',
      }),
    );
    writeFileSync(
      join(release, 'dist-ui-phone', 'index.html'),
      '<head></head><body>Station</body>',
    );
    symlinkSync(join(workspace, 'node_modules'), join(release, 'node_modules'));
    const shim = join(release, 'station');
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${join(workspace, 'node_modules', 'tsx', 'dist', 'cli.mjs')}" "${join(workspace, 'scripts', 'station-cli.ts')}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const statePath = join(supportDir, 'state.json');
    const config = {
      version: 1,
      repo,
      githubRepo: 'kontourai/station',
      instance: 'phone',
      stationHome,
      supportDir,
      logDir,
      serverPort,
      uiPort,
      tailnetUrl: 'https://station.example.ts.net',
    };
    writeFileSync(
      statePath,
      `${JSON.stringify({
        version: 1,
        active: {
          sha,
          path: release,
          ci: { id: 42, url: 'https://example/run/42' },
        },
        previous: null,
        failedCandidates: [],
        recoveryHistory: [],
        lastRemoteCheckAt: new Date().toISOString(),
        health: { status: 'ready', sha },
      })}\n`,
      { mode: 0o600 },
    );
    for (const name of [
      'station-update.log',
      'station-runtime.log',
      'station-lifecycle.jsonl',
    ]) {
      writeFileSync(join(logDir, name), '', { mode: 0o600 });
    }
    const stationArgs = [
      'start',
      '--instance=phone',
      `--base=${stationHome}`,
      `--port=${serverPort}`,
      `--ui-port=${uiPort}`,
      '--host=127.0.0.1',
      `--log=${join(logDir, 'station-runtime.log')}`,
      `--lifecycle-journal=${join(logDir, 'station-lifecycle.jsonl')}`,
      `--readiness-file=${statePath}`,
    ];
    const instanceState = join(release, '.station', 'instances', 'phone.json');
    fixtureOwner.registerStatePath(instanceState);
    const start = spawnSync('./station', stationArgs, {
      cwd: release,
      env: {
        ...process.env,
        STATION_BUILD_BRANCH: 'main',
        STATION_HOME: stationHome,
      },
      encoding: 'utf8',
    });
    expect(start.status, start.stderr).toBe(0);
    fixtureOwner.capturePublishedBoot(instanceState);
    const before = JSON.parse(readFileSync(instanceState, 'utf8'));
    await eventually(
      () => probeDogfoodHealth(instanceState),
      (result) => result.healthy,
    );

    const killedAt = Date.now();
    process.kill(before.serverPid, 'SIGTERM');
    await eventually(
      () => fetch(`http://127.0.0.1:${uiPort}/api/system/readiness`),
      (response) => response.status === 503,
    );

    const command = (
      executable: string,
      args: string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
    ) => {
      if (executable === 'git') {
        if (args.includes('get-url'))
          return {
            status: 0,
            stdout: 'git@github.com:kontourai/station.git\n',
            stderr: '',
          };
        if (args.includes('fetch'))
          return { status: 0, stdout: '', stderr: '' };
        if (args.at(-2) === 'rev-parse')
          return { status: 0, stdout: `${sha}\n`, stderr: '' };
        if (args.includes('symbolic-ref'))
          return { status: 1, stdout: '', stderr: '' };
        if (args.includes('status'))
          return { status: 0, stdout: '', stderr: '' };
      }
      if (executable === 'curl') {
        if (args.at(-1)?.endsWith('/api/system/readiness')) {
          return {
            status: 0,
            stdout: JSON.stringify({ ready: true, status: 'ready' }),
            stderr: '',
          };
        }
        const current = JSON.parse(readFileSync(instanceState, 'utf8'));
        return {
          status: 0,
          stdout: JSON.stringify({
            instanceId: current.instanceId,
            sha: current.build.sha,
            bootId: current.bootId,
          }),
          stderr: '',
        };
      }
      const result = spawnSync(executable, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
      });
      if (
        executable === './station' &&
        args[0] === 'start' &&
        result.status === 0
      ) {
        fixtureOwner.capturePublishedBoot(instanceState);
      }
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    };
    let now = Date.now();
    const outcome = reconcile(config, {
      run: command,
      now: () => {
        now += 10;
        return now;
      },
    });
    expect(outcome).toMatchObject({ action: 'recovered', sha });
    const after = JSON.parse(readFileSync(instanceState, 'utf8'));
    expect(after.serverPid).not.toBe(before.serverPid);
    expect(after.bootId).not.toBe(before.bootId);
    await eventually(
      () => probeDogfoodHealth(instanceState),
      (result) => result.healthy,
    );
    await eventually(
      () => fetch(`http://127.0.0.1:${uiPort}/api/system/readiness`),
      (response) => response.status === 200,
    );
    const supervisor = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(supervisor.recoveryHistory.at(-1)).toMatchObject({
      outcome: 'recovered',
      intervalAllowanceMs: 15_000,
      withinBudget: true,
      exit: { classification: 'unexpected_signal', signal: 'SIGTERM' },
    });
    expect(
      supervisor.recoveryHistory.at(-1).postDetectionDurationMs,
    ).toBeGreaterThan(0);
    expect(
      supervisor.recoveryHistory.at(-1).worstCaseEndToEndMs,
    ).toBeLessThanOrEqual(60_000);
    expect(Date.now() - killedAt).toBeLessThanOrEqual(60_000);
    const lifecycleEvents = [
      `${join(logDir, 'station-lifecycle.jsonl')}.previous`,
      join(logDir, 'station-lifecycle.jsonl'),
    ]
      .flatMap((file) => {
        try {
          return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        } catch {
          return [];
        }
      })
      .map((line) => JSON.parse(line));
    const recoveryIntent = lifecycleEvents.find(
      (event) => event.type === 'stop_intent' && event.intent === 'recovery',
    );
    expect(recoveryIntent).toBeDefined();
    expect(
      lifecycleEvents.find(
        (event) =>
          event.type === 'stop_result' &&
          event.operationId === recoveryIntent.operationId,
      ),
    ).toMatchObject({ result: 'completed' });

    process.kill(after.serverPid, 'SIGTERM');
    await eventually(async () => {
      try {
        process.kill(after.serverPid, 0);
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    const unrelated = await spawnLongRunningFixtureChild();
    if (!unrelated.pid) throw new Error('unrelated child did not start');
    writeFileSync(
      instanceState,
      JSON.stringify({ ...after, serverPid: unrelated.pid }),
      { mode: 0o600 },
    );
    const runtimeBeforeFailedStop = readFileSync(
      join(logDir, 'station-runtime.log'),
    );
    expect(() =>
      reconcile(config, {
        run: command,
        now: () => {
          now += 10;
          return now;
        },
      }),
    ).toThrow('process fingerprint mismatch');
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    expect(
      readFileSync(join(logDir, 'station-runtime.log')).equals(
        runtimeBeforeFailedStop,
      ),
    ).toBe(true);
  }, 30_000);

  it('repeats real Stagephone cleanup after readiness rejection (UI 503) and state deletion', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const root = mkdtempSync(join(tmpdir(), 'station-production-residue-'));
      cleanupRoots.add(root);
      fixtureOwner.registerFixtureRoot(root);
      const release = join(root, 'release');
      const instance = `residue-${attempt}`;
      const sha = 'c'.repeat(40);
      const serverPort = await findFreePortBlock(4);
      const uiPort = await findFreePortOutside(serverPort, 4);
      for (const directory of [release, join(root, 'station-home')]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
      }
      materializeRelease(release, instance, sha);
      const instanceState = join(
        release,
        '.station',
        'instances',
        `${instance}.json`,
      );
      fixtureOwner.registerStatePath(instanceState);
      const start = spawnSync(
        './station',
        [
          'start',
          `--instance=${instance}`,
          `--base=${join(root, 'station-home')}`,
          `--port=${serverPort}`,
          `--ui-port=${uiPort}`,
          '--host=127.0.0.1',
        ],
        {
          cwd: release,
          env: {
            ...process.env,
            STATION_BUILD_BRANCH: 'main',
            STATION_HOME: join(root, 'station-home'),
          },
          encoding: 'utf8',
        },
      );
      expect(start.status, start.stderr).toBe(0);
      fixtureOwner.capturePublishedBoot(instanceState);
      const boot = JSON.parse(readFileSync(instanceState, 'utf8'));
      await eventually(
        () => probeDogfoodHealth(instanceState),
        (health) => health.healthy,
      );

      process.kill(boot.serverPid, 'SIGTERM');
      await eventually(
        () => fetch(`http://127.0.0.1:${uiPort}/api/system/readiness`),
        (response) => response.status === 503,
      );
      const rejectedHealth = await probeDogfoodHealth(instanceState);
      expect(rejectedHealth.healthy).toBe(false);
      expect(rejectedHealth.failedChecks).toEqual(
        expect.arrayContaining(['process', 'ownership-post']),
      );

      // Cleanup authority remains the trusted boot snapshot captured before
      // readiness rejection, never the mutable state deleted by that path.
      rmSync(instanceState);
      expect(existsSync(instanceState)).toBe(false);

      // This asserts all captured backend/UI PIDs, their listeners, and their
      // fixture-root cwd are gone on each iteration; dispose throws a bounded
      // diagnostic if any residue remains.
      fixtureOwner.dispose();
    }
  }, 30_000);
});
