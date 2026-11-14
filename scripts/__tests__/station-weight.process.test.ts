import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  darwinProcessArguments,
  endRunProcesses,
  exactStarts,
  fixtureRepository,
  gitEnvironment,
  instanceSnapshot,
  leftoverAfterStop,
  ownedTree,
  processTable,
  repositoryState,
  runLauncher,
  runOwnership,
  runTagging,
  sampleTreeCpu,
  signalIfSame,
  survivors,
  taggedRows,
} from '../bench/station-weight.mjs';
import {
  birthOf,
  daemonSource as boundedDaemonSource,
} from './helpers/station-weight-daemon.js';

// Fast real-process mechanics of the station-weight check. The full run
// against an isolated Station is station-weight.end-to-end.process.test.ts.

const ROOT = resolve(__dirname, '../..');
const RUNNER = join(ROOT, 'scripts/bench/station-weight.mjs');
const makeTempDir = trackTempDirs();
const posix = ['darwin', 'linux'].includes(process.platform);

// Cleanup never signals a process by pid alone. Children this file spawned
// are killed through their own ChildProcess handles, which Node signals only
// until it has reaped them. Detached daemons, which have no handle here, exit
// on their own once the test's lease file is gone, once this worker is gone
// (a killed worker never removes the lease), or after 60 s.
const children: ChildProcess[] = [];
let lease = '';

beforeEach(() => {
  // Not under a temp dir whose name a test asserts on, and never naming a
  // run nonce: a daemon's arguments carry it.
  lease = join(
    tmpdir(),
    `station-weight-lease-${randomBytes(8).toString('hex')}`,
  );
  writeFileSync(lease, '');
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(lease, { force: true });
});

/** This worker, as the owner of every daemon its tests start. */
const WORKER = { pid: process.pid, birth: birthOf(process.pid) };

/**
 * An idle daemon body that exits within 100 ms of its lease file going, and
 * also on its own bounds (see boundedDaemonSource).
 */
const daemonSource = () => boundedDaemonSource({ owner: WORKER, lease });

const idleSource = `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`;

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
  children.push(child);
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

/**
 * Source defining `detach()`: spawns a detached, unreferenced node daemon
 * that idles until the lease goes, and returns its pid.
 */
const detachSource = () => `const { spawn } = require('node:child_process');
  const detach = () => {
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(daemonSource())}], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return child.pid;
  };`;

describe.skipIf(!posix)('station-weight test daemons', () => {
  /** A daemon spawned with a handle, so the test can watch it exit. */
  const daemon = (source: string) => {
    const child = spawn(process.execPath, ['-e', source], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(child);
    return child;
  };
  const exitsWithin = (child: ChildProcess, ms: number) =>
    Promise.race([exited(child).then(() => true), wait(ms).then(() => false)]);

  test('a daemon exits once its owner is gone, though its lease remains', async () => {
    const { child: owner, firstLine } = start(idleSource);
    await firstLine;
    const child = daemon(
      boundedDaemonSource({
        owner: {
          pid: owner.pid as number,
          birth: birthOf(owner.pid as number),
        },
        lease,
      }),
    );
    // Positive control: alive while its owner and lease are.
    expect(await exitsWithin(child, 600)).toBe(false);
    owner.kill('SIGKILL');
    await exited(owner);
    expect(await exitsWithin(child, 2_000)).toBe(true);
    expect(child.exitCode).toBe(0);
  });

  test('a daemon exits when its owner pid has another birth', async () => {
    const child = daemon(
      boundedDaemonSource({
        owner: { pid: process.pid, birth: 'another process' },
        lease,
        birthCheckMs: 500,
      }),
    );
    expect(await exitsWithin(child, 3_000)).toBe(true);
    expect(child.exitCode).toBe(0);
  });

  test('a daemon exits at its deadline, though its owner and lease remain', async () => {
    const child = daemon(
      boundedDaemonSource({ owner: WORKER, lease, deadlineMs: 800 }),
    );
    expect(await exitsWithin(child, 3_000)).toBe(true);
    expect(child.exitCode).toBe(0);
  });
});

describe.skipIf(!posix)('station-weight process tree ownership', () => {
  test('finds a grandchild that outlives its parent by recorded identity', async () => {
    const { child: parent, firstLine } = start(
      `${detachSource()} process.stdout.write(detach() + '\\n'); setInterval(() => {}, 1000);`,
    );
    const childPid = Number(await firstLine);
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
  // Its own random name: a path containing the nonce would be excluded by
  // the argument rule before the environment is read apart from arguments.
  const scratch = `/tmp/station-weight-test-${randomBytes(8).toString('hex')}`;
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
         `${detachSource()} process.stdout.write(detach() + '\\n');`,
       )}], { stdio: ['ignore', 'pipe', 'ignore'] });
       helper.stdout.once('data', (chunk) => helper.once('exit', () => process.stdout.write(String(chunk))));
       setInterval(() => {}, 1000);`,
      tagged,
    );
    const daemon = Number(await firstLine);
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
    // It inherited the nonce entry, so the run may end it.
    expect(left.map((row) => [row.pid, row.killEligible])).toEqual([
      [daemon, true],
    ]);
    expect(endRunProcesses(left)).toMatchObject({
      killed: [daemon],
      leftRunning: [],
    });
    await wait(200);
    expect(alive(daemon)).toBe(false);
  });

  test('a child spawned during shutdown, after the pre-stop snapshot, is a leftover', async () => {
    const { child: root, firstLine } = start(
      `${detachSource()}
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
    await exited(root);
    await wait(200);
    expect(alive(spawnedDuringShutdown)).toBe(true);
    const left = leftoverAfterStop(beforeStop, processTable(), tagging);
    expect(left.map((row) => row.pid)).toEqual([spawnedDuringShutdown]);
    // Ended here under rule A: left to its lease, it could still be alive,
    // and tagged, when the next test reads the table.
    expect(endRunProcesses(left)).toMatchObject({
      killed: [spawnedDuringShutdown],
    });
    await wait(200);
    expect(alive(spawnedDuringShutdown)).toBe(false);
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

  test('a process naming the run tags only in its arguments is not the run', async () => {
    // Tags spelled as arguments, none in the environment: neither may be
    // selected or signalled. The first names only the scratch paths, so
    // only reading the environment apart from the arguments excludes it.
    const paths = start(idle, process.env, [
      `HOME=${scratch}/user`,
      `TMPDIR=${scratch}/tmp`,
    ]);
    const named = start(idle, process.env, [`STATION_WEIGHT_RUN=${nonce}`]);
    // Positive control: the same process with the tag in its environment.
    const genuine = start(idle, tagged);
    await Promise.all([paths.firstLine, named.firstLine, genuine.firstLine]);
    const table = processTable();
    expect(taggedRows(table, tagging).map((row) => row.pid)).toEqual([
      genuine.child.pid,
    ]);
    expect(leftoverAfterStop([], table, tagging).map((row) => row.pid)).toEqual(
      [genuine.child.pid],
    );
  });

  test('a run tag spelled inside another variable is not an environment entry', async () => {
    // The reviewer's cases: the tag text inside an unrelated value, which a
    // space-separated environment listing cannot tell from an entry.
    const fakeHome = start(idle, {
      ...process.env,
      INNOCENT: `before HOME=${scratch}/user after`,
    });
    const fakeNonce = start(idle, {
      ...process.env,
      INNOCENT: `before STATION_WEIGHT_RUN=${nonce} after`,
    });
    // Positive controls: genuine entries, one behind 190,000 bytes of arguments
    // and one a HOME under the scratch root. The arguments are two strings
    // because Linux refuses any single one over 128 KiB (MAX_ARG_STRLEN).
    const genuine = start(idle, tagged);
    const longArgument = start(idle, tagged, [
      'x'.repeat(95_000),
      'y'.repeat(95_000),
    ]);
    const nestedHome = start(idle, {
      ...process.env,
      HOME: `${scratch}/user/nested`,
    });
    await Promise.all(
      [fakeHome, fakeNonce, genuine, longArgument, nestedHome].map(
        (entry) => entry.firstLine,
      ),
    );
    const table = processTable();
    const expected = [
      genuine.child.pid,
      longArgument.child.pid,
      nestedHome.child.pid,
    ].sort();
    expect(
      taggedRows(table, tagging)
        .map((row) => row.pid)
        .sort(),
    ).toEqual(expected);
    expect(
      leftoverAfterStop([], table, tagging)
        .map((row) => row.pid)
        .sort(),
    ).toEqual(expected);
  });

  test('a detached child without the run environment is a leftover once a read saw it in the tree', async () => {
    // The root starts a daemon in its own session with no environment at
    // all (env: {}), so no tag ties it to the run; the reviewer's macOS
    // case, a long process.title, hides the environment the same way.
    const ownership = runOwnership(tagging, { intervalMs: 50 });
    const { child: root, firstLine } = start(
      `const { spawn } = require('node:child_process');
       const daemon = spawn(process.execPath, ['-e', ${JSON.stringify(daemonSource())}], { detached: true, stdio: 'ignore', env: {}, windowsHide: true });
       daemon.unref();
       process.stdout.write(daemon.pid + '\\n');
       setInterval(() => {}, 1000);`,
      tagged,
    );
    const daemon = Number(await firstLine);
    ownership.setRoots([identity(root.pid as number)]);
    try {
      let seen = false;
      for (let attempt = 0; attempt < 40 && !seen; attempt += 1) {
        await wait(50);
        seen = ownership.ledger.identities().some((row) => row.pid === daemon);
      }
      expect(seen).toBe(true);
      root.kill('SIGKILL');
      await exited(root);
      await wait(200);
      const table = processTable();
      expect(table.find((row) => row.pid === daemon)?.ppid).not.toBe(root.pid);
      // Neither ancestry nor environment finds it any more.
      expect(leftoverAfterStop([], table, tagging)).toEqual([]);
      const left = ownership.leftover(table);
      expect(left.map((row) => [row.pid, row.killEligible])).toEqual([
        [daemon, false],
      ]);
      expect(ownership.followErrors()).toEqual([]);
      // Counted, reported with its command line, and never signalled: only
      // the follower ties it to the run.
      const ended = endRunProcesses(left);
      expect(ended.killed).toEqual([]);
      expect(ended.leftRunning).toEqual([
        expect.objectContaining({
          pid: daemon,
          command: expect.stringContaining('setInterval'),
        }),
      ]);
      await wait(200);
      expect(alive(daemon)).toBe(true);
    } finally {
      ownership.stop();
    }
  });

  test('a recorded root without the nonce is counted and never signalled', async () => {
    const ownership = runOwnership(tagging, { intervalMs: 50 });
    // Both roots are the instance record's; only one carries the nonce.
    const plain = start(idle);
    const withNonce = start(idle, tagged);
    await Promise.all([plain.firstLine, withNonce.firstLine]);
    const plainPid = plain.child.pid as number;
    const noncePid = withNonce.child.pid as number;
    try {
      ownership.setRoots([identity(plainPid), identity(noncePid)]);
      const left = ownership.leftover(processTable());
      expect(
        left
          .map((row) => [row.pid, row.killEligible])
          .sort((a, b) => Number(a[0]) - Number(b[0])),
      ).toEqual(
        [
          [plainPid, false],
          [noncePid, true],
        ].sort((a, b) => Number(a[0]) - Number(b[0])),
      );
      const ended = endRunProcesses(left);
      expect(ended.killed).toEqual([noncePid]);
      expect(ended.leftRunning.map((row) => row.pid)).toEqual([plainPid]);
      await exited(withNonce.child);
      // The run's final cleanup set treats it the same way.
      expect(
        ownership
          .strays(processTable())
          .map((row) => [row.pid, row.killEligible]),
      ).toEqual([[plainPid, false]]);
      await wait(200);
      expect(alive(plainPid)).toBe(true);
    } finally {
      ownership.stop();
    }
  });

  test('a process tied only by a scratch path is counted and never signalled; one outside the resolved root is not counted', async () => {
    const real = makeTempDir('station-weight-scratch-');
    const outside = makeTempDir('station-weight-outside-');
    mkdirSync(join(real, 'user'));
    symlinkSync(outside, join(real, 'link'));
    const pathTagging = runTagging({ nonce, scratch: real, startedAtMs });
    const withHome = (home: string) =>
      start(idle, { ...process.env, HOME: home });
    // The reviewer's probes: spelled under the scratch root, resolved
    // outside it.
    const dotDot = withHome(`${real}/../${outside.split('/').pop()}`);
    const viaLink = withHome(`${real}/link`);
    const pathOnly = withHome(`${real}/user`);
    const withNonce = start(idle, {
      ...process.env,
      HOME: `${real}/user`,
      STATION_WEIGHT_RUN: nonce,
    });
    await Promise.all(
      [dotDot, viaLink, pathOnly, withNonce].map((entry) => entry.firstLine),
    );
    const table = processTable();
    const tagged = taggedRows(table, pathTagging);
    expect(
      Object.fromEntries(tagged.map((row) => [String(row.pid), row.tag])),
    ).toEqual({
      [String(pathOnly.child.pid)]: 'path',
      [String(withNonce.child.pid)]: 'nonce',
    });
    const left = leftoverAfterStop([], table, pathTagging);
    const ended = endRunProcesses(left);
    expect(ended.killed).toEqual([withNonce.child.pid]);
    expect(ended.leftRunning.map((row) => row.pid)).toEqual([
      pathOnly.child.pid,
    ]);
    await exited(withNonce.child);
    expect(alive(pathOnly.child.pid as number)).toBe(true);
    expect(alive(dotDot.child.pid as number)).toBe(true);
    expect(alive(viaLink.child.pid as number)).toBe(true);
  });

  test('a signal is sent only while the exact birth holds, even within the same second', async () => {
    const { child, firstLine } = start(idle, tagged);
    await firstLine;
    const pid = child.pid as number;
    const exact = exactStarts([pid]).get(pid) as string;
    // macOS microseconds, Linux start ticks.
    expect(exact).toMatch(/^(darwin:\d+|linux:.+:\d+)$/);
    const [, prefix, value] = exact.match(/^(.*:)(\d+)$/) as string[];
    const nextTick = `${prefix}${Number(value) + 1}`;
    expect(
      signalIfSame(
        [{ pid, exactStart: nextTick, killEligible: true }],
        'SIGKILL',
      ),
    ).toEqual({ signalled: [], skipped: [pid] });
    // The exact birth holds, but eligibility must be stated: an omitted
    // flag, or anything but `true`, is not eligible.
    for (const row of [
      { pid, exactStart: exact },
      { pid, exactStart: exact, killEligible: 1 },
    ])
      expect(signalIfSame([row as never], 'SIGKILL')).toEqual({
        signalled: [],
        skipped: [pid],
      });
    await wait(200);
    expect(alive(pid)).toBe(true);
    expect(
      signalIfSame([{ pid, exactStart: exact, killEligible: true }], 'SIGKILL'),
    ).toEqual({ signalled: [pid], skipped: [] });
    await exited(child);
    expect(child.signalCode).toBe('SIGKILL');
  });

  test.skipIf(process.platform !== 'darwin')(
    'the macOS helper drops a process whose start changed between its reads',
    async () => {
      const { child, firstLine } = start(idle, tagged);
      await firstLine;
      const pid = child.pid as number;
      const read = darwinProcessArguments([pid]).get(pid);
      expect(read && 'env' in read ? read.env : []).toContain(
        `STATION_WEIGHT_RUN=${nonce}`,
      );
      // The real helper reading the real process, with the start read after
      // the block shifted as a replaced process's would be.
      expect(
        darwinProcessArguments([pid], undefined, { recheckOffsetUs: 1 }).has(
          pid,
        ),
      ).toBe(false);
    },
  );

  describe.skipIf(process.platform !== 'darwin')(
    'the macOS KERN_PROCARGS2 parser',
    () => {
      const entry = `STATION_WEIGHT_RUN=${nonce}`;
      /** argc, then NUL-joined `text` exactly as given (no added NULs). */
      const block = (argc: number, text: string) => {
        const head = Buffer.alloc(4);
        head.writeInt32LE(argc);
        return Buffer.concat([head, Buffer.from(text, 'binary')]);
      };
      const argmax = Number(
        spawnSync('sysctl', ['-n', 'kern.argmax'], {
          encoding: 'utf8',
          windowsHide: true,
        }).stdout,
      );
      const cases = new Map<number, Buffer>([
        // Well formed: path, padding, one argument, one entry, terminator.
        [1, block(1, `/bin/x\0\0\0x\0${entry}\0\0`)],
        // The reviewer's cases: a negative argc moved the argument into the
        // environment; an unterminated final entry; a huge argc.
        [2, block(-1, `/bin/x\0${entry}\0\0`)],
        [3, block(0, `/bin/x\0${entry}`)],
        [4, block(0x7fffffff, `/bin/x\0x\0${entry}\0\0`)],
        // argc larger than the arguments present, within the bound.
        [5, block(3, `/bin/x\0x\0${entry}`)],
        // An unterminated executable path.
        [6, block(0, '/bin/x')],
        // Past kern.argmax by one byte (4 of them are argc).
        [7, block(0, `/bin/x\0${entry}\0\0`.padEnd(argmax - 3, '\0'))],
      ]);

      test('accepts a well-formed block and refuses each malformed one', () => {
        const parsed = darwinProcessArguments([], undefined, {
          blocks: cases,
        });
        expect(parsed.get(1)).toEqual({
          startedUs: 0,
          argv: ['x'],
          env: [entry],
        });
        expect(
          Object.fromEntries(
            [2, 3, 4, 5, 6, 7].map((pid) => [pid, parsed.get(pid)]),
          ),
        ).toEqual({
          2: { malformed: expect.stringMatching(/^argc -1 /) },
          3: { malformed: 'unterminated environment entry 0' },
          4: { malformed: expect.stringMatching(/^argc 2147483647 /) },
          5: { malformed: 'unterminated argument 1 of 3' },
          6: { malformed: 'unterminated executable path' },
          7: { malformed: `size ${argmax + 1} outside 4..${argmax}` },
        });
      });

      test('a malformed block is never tagged and is counted as a read failure', () => {
        const rows = [...cases.keys()].map((pid) => ({
          pid,
          ppid: 1,
          uid: tagging.uid,
          rssBytes: 0,
          cpuSeconds: 0,
          started: `born-${pid}`,
          // The parse mode answers startedUs 0: the epoch second.
          startedAtMs: 0,
          command: `p${pid}`,
        }));
        const readFailures: Array<{
          pid: number;
          started: string;
          command: string;
          reason: string;
        }> = [];
        const tagged = taggedRows(
          rows,
          { ...tagging, notBeforeMs: -2_000 },
          {
            platform: 'darwin',
            readArguments: (pids, run) =>
              darwinProcessArguments(pids, run, { blocks: cases }),
            readFailures,
          },
        );
        // Only the well-formed block carries the entry.
        expect(tagged.map((row) => [row.pid, row.tag])).toEqual([[1, 'nonce']]);
        expect(readFailures.map((failure) => failure.pid)).toEqual([
          2, 3, 4, 5, 6, 7,
        ]);
      });
    },
  );

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

  /**
   * A launcher that starts an untagged grandchild in its own process group,
   * writes the grandchild's pid to `pidFile`, then either idles or exits.
   * The grandchild holds the launcher's output open.
   */
  const launcherWithGrandchild = (pidFile: string, exitAtOnce: boolean) =>
    `const { spawn } = require('node:child_process');
     const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(daemonSource())}], { stdio: 'inherit', env: {} });
     require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
     ${exitAtOnce ? 'process.exit(0);' : 'setInterval(() => {}, 1000);'}`;

  test('a launcher past its timeout has the process group it created killed, untagged members included', async () => {
    const pidFile = join(makeTempDir('station-weight-launcher-'), 'pid');
    await expect(
      runLauncher(
        process.execPath,
        ['-e', launcherWithGrandchild(pidFile, false)],
        {
          env: process.env,
          timeoutMs: 1_500,
          killGraceMs: 5_000,
        },
      ),
    ).rejects.toThrow(
      /did not finish within 1500 ms; the run sent SIGKILL to the process group it created$/,
    );
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await wait(200);
    expect(alive(grandchild)).toBe(false);
  });

  test('a launcher that already exited is not group-signalled on a timeout; what it left is reported', async () => {
    const pidFile = join(makeTempDir('station-weight-launcher-'), 'pid');
    await expect(
      runLauncher(
        process.execPath,
        ['-e', launcherWithGrandchild(pidFile, true)],
        {
          env: process.env,
          timeoutMs: 1_500,
          killGraceMs: 500,
        },
      ),
    ).rejects.toThrow(
      /did not signal its process group: the launcher had already exited.*output was still open 500 ms later/,
    );
    // The group still exists (the grandchild is in it), but the run cannot
    // prove its id was not reused, so it was left alone; it exits with the
    // lease.
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);
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

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'a saved ready time of %s (serialized as null) is reported and exits 0',
    (_name, value) => {
      const result = complete();
      result.metrics.serverReadyMs = metric(value);
      // The shape a run writes: JSON turns a non-finite number into null.
      expect(JSON.parse(JSON.stringify(result)).metrics.serverReadyMs).toEqual({
        status: 'measured',
        value: null,
        unit: 'x',
      });
      const run = gate(result);
      expect(run.stderr).not.toContain('TypeError');
      expect(run.stdout).toContain('MEASURED serverReadyMs=null x');
      expect(run.stdout).toContain(
        'REPORTED serverReadyMs measured without a finite value (null)',
      );
      expect(run.stdout).toContain('GATE PASS');
      expect(run.status).toBe(0);
    },
  );

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
