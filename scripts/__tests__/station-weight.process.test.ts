import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { lookupProcessBirthFingerprint } from '../../packages/shared/src/process-identity.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  fixtureRepository,
  gitEnvironment,
  instanceSnapshot,
  leftoverAfterStop,
  ownedTree,
  processTable,
  repositoryState,
  runLauncher,
  runTagging,
  sampleTreeCpu,
  signalIfSame,
  survivors,
  taggedRows,
} from '../bench/station-weight.mjs';

// Fast real-process mechanics of the station-weight check. The full run
// against an isolated Station is station-weight.end-to-end.process.test.ts.

const ROOT = resolve(__dirname, '../..');
const RUNNER = join(ROOT, 'scripts/bench/station-weight.mjs');
const makeTempDir = trackTempDirs();
const posix = ['darwin', 'linux'].includes(process.platform);
const strays: Array<{ pid: number; started: string }> = [];

/**
 * Remembers `pid` with its birth token for cleanup, which signals it only
 * while the pid still has that birth: a pid reused since is never killed.
 */
function stray(pid: number) {
  const started = lookupProcessBirthFingerprint(pid);
  if (started) strays.push({ pid, started });
}

afterEach(() => {
  signalIfSame(strays.splice(0), 'SIGKILL');
});

const identity = (pid: number) => {
  const row = processTable().find((entry) => entry.pid === pid);
  if (!row) throw new Error(`pid ${pid} is not in the process table`);
  return { pid: row.pid, started: row.started };
};

/** Starts `script` under node with `env` and resolves the first stdout line. */
function start(
  script: string,
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = [],
) {
  const child = spawn(process.execPath, ['-e', script, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  // Read synchronously after spawn: the child is not reaped before the event
  // loop turns, so its pid cannot have been reused yet.
  stray(child.pid as number);
  const firstLine = new Promise<string>((resolveLine) =>
    child.stdout.once('data', (chunk) => resolveLine(String(chunk).trim())),
  );
  return { child, firstLine };
}

const exited = (child: ReturnType<typeof spawn>) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolveExit) => child.once('exit', resolveExit));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Spawns a detached, unreferenced node child that idles; prints its pid. */
const DETACH = `const { spawn } = require('node:child_process');
  const detach = () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return child.pid;
  };`;

describe.skipIf(!posix)('station-weight process tree ownership', () => {
  test('finds a grandchild that outlives its parent by recorded identity', async () => {
    const { child: parent, firstLine } = start(
      `${DETACH} process.stdout.write(detach() + '\\n'); setInterval(() => {}, 1000);`,
    );
    const childPid = Number(await firstLine);
    stray(childPid);
    const root = identity(parent.pid as number);
    const before = ownedTree(processTable(), [root]);
    expect(before.map((row) => row.pid).sort()).toEqual(
      [parent.pid, childPid].sort(),
    );
    parent.kill('SIGKILL');
    await exited(parent);
    await wait(200);
    expect(survivors(before, processTable()).map((row) => row.pid)).toEqual([
      childPid,
    ]);
    // Same pid with a different birth token is a reused pid, not a survivor.
    const reused = before.map((row) => ({ ...row, started: 'reused' }));
    expect(survivors(reused, processTable())).toEqual([]);
  });
});

describe.skipIf(!posix)('station-weight leftover detection', () => {
  const nonce = randomBytes(16).toString('hex');
  const scratch = `/tmp/station-weight-test-${nonce}`;
  const startedAtMs = Date.now();
  const tagging = runTagging({
    nonce,
    scratch,
    startedAtMs,
    controlConfigDir: `/control-${nonce}`,
  });
  const tagged = { ...process.env, STATION_WEIGHT_RUN: nonce };
  const idle = `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;

  test('a double-forked daemon that left the tree before stop is a leftover', async () => {
    // The instance root starts a helper that detaches a daemon and exits, so
    // the daemon is reparented away from the root before the pre-stop
    // snapshot: no ancestry ties it to the instance.
    const { child: root, firstLine } = start(
      `const { spawn } = require('node:child_process');
       const helper = spawn(process.execPath, ['-e', ${JSON.stringify(
         `${DETACH} process.stdout.write(detach() + '\\n');`,
       )}], { stdio: ['ignore', 'pipe', 'ignore'] });
       helper.stdout.once('data', (chunk) => helper.once('exit', () => process.stdout.write(String(chunk))));
       setInterval(() => {}, 1000);`,
      tagged,
    );
    const daemon = Number(await firstLine);
    stray(daemon);
    await wait(200);
    const roots = [identity(root.pid as number)];
    const beforeStop = instanceSnapshot(processTable(), roots, tagging);
    expect(ownedTree(processTable(), roots).map((row) => row.pid)).toEqual([
      root.pid,
    ]);
    root.kill('SIGKILL');
    await exited(root);
    await wait(200);
    const left = leftoverAfterStop(beforeStop, processTable(), tagging);
    expect(left.map((row) => row.pid)).toEqual([daemon]);
  });

  test('a child spawned during shutdown, after the pre-stop snapshot, is a leftover', async () => {
    const { child: root, firstLine } = start(
      `${DETACH}
       process.on('SIGTERM', () => { process.stdout.write(detach() + '\\n'); setTimeout(() => process.exit(0), 50); });
       process.stdout.write('ready\\n');
       setInterval(() => {}, 1000);`,
      tagged,
    );
    expect(await firstLine).toBe('ready');
    const roots = [identity(root.pid as number)];
    const beforeStop = instanceSnapshot(processTable(), roots, tagging);
    expect(beforeStop.map((row) => row.pid)).toEqual([root.pid]);
    const late = new Promise<number>((resolveLate) =>
      root.stdout.once('data', (chunk) => resolveLate(Number(String(chunk)))),
    );
    root.kill('SIGTERM');
    const spawnedDuringShutdown = await late;
    stray(spawnedDuringShutdown);
    await exited(root);
    await wait(200);
    expect(alive(spawnedDuringShutdown)).toBe(true);
    const left = leftoverAfterStop(beforeStop, processTable(), tagging);
    expect(left.map((row) => row.pid)).toEqual([spawnedDuringShutdown]);
  });

  test('a process carrying the control tag or no run tag is not a leftover', async () => {
    const control = start(idle, {
      ...tagged,
      CLAUDE_CONFIG_DIR: `/control-${nonce}`,
    });
    const unrelated = start(idle, {
      ...process.env,
      STATION_WEIGHT_RUN: `${nonce}-other`,
    });
    await Promise.all([control.firstLine, unrelated.firstLine]);
    expect(leftoverAfterStop([], processTable(), tagging)).toEqual([]);
  });

  test('a process naming the run tag only in its arguments is not the run', async () => {
    // Every tag spelled as an argument, none in the environment: it must be
    // neither selected nor signalled.
    const impostor = start(idle, process.env, [
      `STATION_WEIGHT_RUN=${nonce}`,
      `HOME=${scratch}/user`,
      `TMPDIR=${scratch}/tmp`,
    ]);
    // Positive control: the same process with the tag in its environment.
    const genuine = start(idle, tagged);
    await Promise.all([impostor.firstLine, genuine.firstLine]);
    const table = processTable();
    expect(taggedRows(table, tagging).map((row) => row.pid)).toEqual([
      genuine.child.pid,
    ]);
    expect(leftoverAfterStop([], table, tagging).map((row) => row.pid)).toEqual(
      [genuine.child.pid],
    );
  });

  test('a tagged process that names the nonce in its arguments too is not the run', async () => {
    // Not `--x=`: node would read a dashed argument after -e as its own option.
    const both = start(idle, tagged, [`run=${nonce}`]);
    await both.firstLine;
    expect(taggedRows(processTable(), tagging)).toEqual([]);
  });

  test('a tagged process older than the run, or of another user, is not the run', async () => {
    const { child, firstLine } = start(idle, tagged);
    await firstLine;
    const table = processTable();
    const own = table.find((row) => row.pid === child.pid);
    expect(own).toBeDefined();
    expect(taggedRows(table, tagging).map((row) => row.pid)).toEqual([
      child.pid,
    ]);
    // The run began after the process did.
    expect(
      taggedRows(
        table,
        runTagging({
          nonce,
          scratch,
          startedAtMs: Date.now() + 10_000,
        }),
      ),
    ).toEqual([]);
    // The same row under another effective uid.
    expect(
      taggedRows(
        table.map((row) =>
          row.pid === child.pid ? { ...row, uid: (row.uid ?? 0) + 1 } : row,
        ),
        tagging,
      ),
    ).toEqual([]);
  });
});

describe.skipIf(!posix)('station-weight idle CPU', () => {
  test('counts a worker that does its work and exits inside the window', async () => {
    // The root idles; 400 ms in, it runs a worker that burns 600 ms of CPU
    // and exits well before the window ends.
    const { child: root, firstLine } = start(
      `const { spawn } = require('node:child_process');
       process.stdout.write('ready\\n');
       setTimeout(() => {
         const worker = spawn(process.execPath, ['-e', 'const t0 = process.cpuUsage(); for (;;) { const u = process.cpuUsage(t0); if (u.user + u.system >= 600000) break; }'], { stdio: 'ignore' });
         worker.once('exit', () => process.stdout.write('worker-exited\\n'));
       }, 400);
       setInterval(() => {}, 1000);`,
    );
    expect(await firstLine).toBe('ready');
    const roots = [identity(root.pid as number)];
    const workerExited = new Promise((resolveExit) =>
      root.stdout.on('data', (chunk) => {
        if (String(chunk).includes('worker-exited')) resolveExit(true);
      }),
    );
    const sampled = await sampleTreeCpu(
      () => ownedTree(processTable(), roots),
      { windowMs: 4_000, intervalMs: 100 },
    );
    expect(await workerExited).toBe(true);
    expect(sampled.endRows.map((row) => row.pid)).toEqual([root.pid]);
    expect(sampled.exitedDuringWindow).toBeGreaterThanOrEqual(1);
    // 600 ms of worker CPU, less at most one 100 ms interval it was not seen.
    expect(sampled.cpuSeconds).toBeGreaterThanOrEqual(0.45);
  });
});

describe.skipIf(!posix)('station-weight launcher capture', () => {
  const node = (script: string, maxBytes?: number) =>
    runLauncher(process.execPath, ['-e', script], {
      env: process.env,
      timeoutMs: 30_000,
      ...(maxBytes ? { maxBytes } : {}),
    });

  test('accepts a complete capture', async () => {
    await expect(node(`process.stdout.write('done')`)).resolves.toMatchObject({
      status: 0,
      output: expect.stringContaining('done'),
    });
  });

  test('refuses output that is not valid UTF-8, even with exit 0', async () => {
    await expect(
      node(`process.stdout.write(Buffer.from([0x6f, 0x6b, 0xff, 0xfe]))`),
    ).rejects.toThrow(/not valid UTF-8/);
  });

  test('refuses output truncated at its capture bound, even with exit 0', async () => {
    await expect(
      node(`process.stdout.write('x'.repeat(4096))`, 1024),
    ).rejects.toThrow(/past the 1024-byte capture bound/);
  });

  test('refuses a launcher that did not run', async () => {
    await expect(
      runLauncher(join(makeTempDir('station-weight-'), 'station'), ['start'], {
        env: process.env,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/station start did not run/);
  });
});

describe.skipIf(!posix)('station-weight git isolation', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...gitEnvironment(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
  const routing = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
  const saved = Object.fromEntries(
    routing.map((key) => [key, process.env[key]]),
  );
  afterEach(() => {
    for (const key of routing)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });

  /** Another checkout the caller's GIT_* variables point at. */
  function victimCheckout() {
    const victim = makeTempDir('station-weight-victim-');
    expect(git(victim, 'init', '-q').status).toBe(0);
    process.env.GIT_DIR = join(victim, '.git');
    process.env.GIT_WORK_TREE = victim;
    process.env.GIT_INDEX_FILE = join(victim, '.git/index');
    return victim;
  }

  const markers = { claudeMd: 'claude-marker', agentsMd: 'agents-marker' };

  test('the fixture commit stays in the fixture when the caller routes git elsewhere', () => {
    const victim = victimCheckout();
    const scratch = makeTempDir('station-weight-scratch-');
    const repo = fixtureRepository(scratch, markers, {
      PATH: process.env.PATH,
      HOME: scratch,
    });
    expect(git(victim, 'rev-parse', '--verify', 'HEAD').status).not.toBe(0);
    expect(git(repo, 'log', '--format=%s').stdout.trim()).toBe('fixture');
    expect(
      git(repo, 'show', '--name-only', '--format=', 'HEAD')
        .stdout.trim()
        .split('\n')
        .sort(),
    ).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  test('GIT_* variables in the environment handed to the fixture are dropped', () => {
    const victim = victimCheckout();
    const scratch = makeTempDir('station-weight-scratch-');
    const repo = fixtureRepository(scratch, markers, { ...process.env });
    expect(git(victim, 'rev-parse', '--verify', 'HEAD').status).not.toBe(0);
    expect(git(repo, 'log', '--format=%s').stdout.trim()).toBe('fixture');
  });

  test('the revision under test is this checkout, not the one GIT_DIR names', () => {
    const expected = git(ROOT, 'rev-parse', 'HEAD').stdout.trim();
    victimCheckout();
    expect(repositoryState().sha).toBe(expected);
  });
});

describe.skipIf(!posix)('station-weight gate exit status', () => {
  const HOST = { label: 'testos-arm64', fingerprint: '0123456789abcdef' };
  const REQUEST = {
    'request.stationAddedTextBytes': 1000,
    'request.stationAddedToolCount': 20,
    'request.stationAddedToolDefinitionBytes': 4500,
    'request.sideCallCount': 0,
  };
  const HOST_VALUES = {
    restMemoryBytes: 1_000_000_000,
    idleSessionsMemoryBytes: 1_500_000_000,
    idleCpuPercent: 0.2,
    leftoverAfterStopMemoryBytes: 0,
  };
  const baseline = {
    schemaVersion: 2,
    request: { sourceRevision: 'r', recordedAt: 't', values: REQUEST },
    hosts: {
      [HOST.fingerprint]: {
        platform: HOST.label,
        sourceRevision: 'r',
        recordedAt: 't',
        values: HOST_VALUES,
      },
    },
  };
  const metric = (value: number) => ({ status: 'measured', value, unit: 'x' });
  const complete = () => ({
    outcome: 'completed',
    dirty: false,
    sourceRevision: 'abc',
    startedAt: '2026-01-01T00:00:00.000Z',
    host: HOST,
    metrics: Object.fromEntries(
      Object.entries({ serverReadyMs: 5000, ...REQUEST, ...HOST_VALUES }).map(
        ([id, value]) => [id, metric(value)],
      ),
    ) as Record<string, unknown>,
  });

  function gate(result: unknown, ...flags: string[]) {
    const dir = makeTempDir('station-weight-gate-');
    const resultPath = join(dir, 'result.json');
    const baselinePath = join(dir, 'baseline.json');
    writeFileSync(resultPath, JSON.stringify(result));
    if (!flags.includes('--no-baseline'))
      writeFileSync(baselinePath, JSON.stringify(baseline));
    const run = spawnSync(
      process.execPath,
      [
        RUNNER,
        `--evaluate=${resultPath}`,
        `--baseline=${baselinePath}`,
        ...flags.filter((flag) => flag !== '--no-baseline'),
      ],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true },
    );
    return { ...run, baselinePath };
  }

  test('a complete run within budget exits 0', () => {
    const run = gate(complete());
    expect(run.stdout).toContain('GATE PASS');
    expect(run.status).toBe(0);
  });

  test('a result without the report-only ready time exits 0', () => {
    const result = complete();
    delete result.metrics.serverReadyMs;
    const run = gate(result);
    expect(run.stdout).toContain('GATE PASS');
    expect(run.stdout).not.toContain('not compared');
    expect(run.status).toBe(0);
  });

  test('request budgets NOT_MEASURED (engine never ready) exit non-zero', () => {
    const result = complete();
    for (const id of Object.keys(REQUEST))
      result.metrics[id] = {
        status: 'not_measured',
        unit: 'bytes',
        reason: 'Claude engine not ready: timed out',
      };
    const run = gate(result);
    expect(run.stdout).toContain('GATE FAIL');
    expect(run.status).toBe(1);
  });

  test('a missing baseline file leaves every budget uncompared and exits non-zero', () => {
    const run = gate(complete(), '--no-baseline');
    expect(run.stdout).toContain('no baseline file');
    expect(run.stdout.match(/NOT_MEASURED/g)).toHaveLength(8);
    expect(run.status).toBe(1);
  });

  test('another host with no baseline of its own exits non-zero', () => {
    const run = gate({
      ...complete(),
      host: { ...HOST, fingerprint: 'ffffffffffffffff' },
    });
    expect(run.stdout).toContain(
      'not compared: restMemoryBytes, idleSessionsMemoryBytes, idleCpuPercent, leftoverAfterStopMemoryBytes',
    );
    expect(run.status).toBe(1);
  });

  test('a run that did not complete exits non-zero', () => {
    const run = gate({ ...complete(), outcome: 'failed', error: 'boom' });
    expect(run.status).toBe(1);
  });

  test('report-only exits 0, says it compared nothing, and still fails a gap', () => {
    const run = gate(complete(), '--no-baseline', '--report-only');
    expect(run.stdout).toContain('REPORT_ONLY compared nothing');
    expect(run.stdout).not.toMatch(/\bPASS request\./);
    expect(run.status).toBe(0);
    const result = complete();
    result.metrics.restMemoryBytes = {
      status: 'not_measured',
      unit: 'bytes',
      reason: "the instance's process tree was empty",
    };
    expect(gate(result, '--no-baseline', '--report-only').status).toBe(1);
  });

  test('recording an incomplete run is refused and leaves the baseline untouched', () => {
    const result = complete();
    // The shape a run writes for a gap: present, with a reason, no value.
    result.metrics.idleCpuPercent = {
      status: 'not_measured',
      unit: 'percent of one core',
      reason: "the instance's process tree was empty",
    };
    const run = gate(result, '--record-baseline');
    expect(run.stdout).toContain(
      'refusing to record an incomplete baseline; not measured: idleCpuPercent',
    );
    expect(run.stdout).toContain('baseline NOT recorded');
    expect(run.status).toBe(1);
    expect(JSON.parse(readFileSync(run.baselinePath, 'utf8'))).toEqual(
      baseline,
    );
  });

  test('recording a complete run writes it under the host fingerprint', () => {
    const result = { ...complete(), host: { ...HOST, fingerprint: 'abcd' } };
    const run = gate(result, '--record-baseline');
    expect(run.status).toBe(0);
    const recorded = JSON.parse(readFileSync(run.baselinePath, 'utf8'));
    expect(Object.keys(recorded.hosts).sort()).toEqual([
      HOST.fingerprint,
      'abcd',
    ]);
  });
});
