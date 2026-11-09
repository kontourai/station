/**
 * #3994 a command session's termination ends what the command started, not
 * just the command. Real processes: the leader exiting must not end custody
 * while a process it started still runs, whether termination came from Stop
 * or from the output cap.
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { buildWindowsOwnedGuard } from '../../../../scripts/lib/windows-owned-guard-build.mjs';
import { spawnCommandProcess } from '../command-process.js';
import { windowsCommandLine } from '../windows-command-guard.js';
import { windowsNowUs } from '../windows-owned-processes.js';

const windows = process.platform === 'win32';
const started: number[] = [];
let guard: ReturnType<typeof buildWindowsOwnedGuard> | undefined;
let fixtureDirectory: string | undefined;

beforeAll(() => {
  if (!windows) return;
  fixtureDirectory = mkdtempSync(join(tmpdir(), 'station-command-custody-'));
  const source = resolve('scripts/windows-owned-guard.cs');
  guard = buildWindowsOwnedGuard({
    source,
    tempDirectory: fixtureDirectory,
    spawnProcess: (file, args, options) =>
      spawnSyncBounded(file, args, {
        ...options,
        windowsHide: true,
        timeout: 60_000,
      }),
  });
  console.info('source-bound Job guard', {
    source,
    sourceSHA256: createHash('sha256')
      .update(readFileSync(source))
      .digest('hex'),
    executable: guard.path,
    executableSHA256: createHash('sha256')
      .update(readFileSync(guard.path))
      .digest('hex'),
  });
}, 120_000);

afterAll(() => {
  guard?.cleanup();
  if (fixtureDirectory)
    rmSync(fixtureDirectory, { recursive: true, force: true });
  console.info('source-bound guard fixture retired', fixtureDirectory);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(async () => {
  // Only processes this file started, by the pids they reported.
  for (const pid of started.splice(0)) {
    if (alive(pid))
      if (windows)
        spawnSync('taskkill', ['/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else process.kill(pid, 'SIGKILL');
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
    console.info('owned fixture retired', pid);
  }
});

/** Runs `script` as the command and collects what it prints. */
async function run(
  script: string,
  outputCapBytes?: number,
  windowsGuard?: string | null,
) {
  const proc = await spawnCommandProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: process.env,
    ...(outputCapBytes !== undefined && { outputCapBytes }),
    windowsGuard: windowsGuard === undefined ? guard?.path : windowsGuard,
  });
  started.push(proc.pid);
  let text = '';
  proc.onData((data) => {
    text += data;
  });
  const exited = new Promise<{ outputCapped?: boolean }>((done) =>
    proc.onExit((event) => done(event)),
  );
  const pidsOf = async (count: number) => {
    await expect
      .poll(() => [...text.matchAll(/pid:(\d+)/g)].length, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(count);
    const pids = [...text.matchAll(/pid:(\d+)/g)].map((match) =>
      Number(match[1]),
    );
    started.push(...pids);
    return pids;
  };
  const read = () => text;
  return { proc, exited, pidsOf, read };
}

/**
 * The command starts a child that starts a grandchild and exits: the
 * grandchild's parent is gone before Stop, so no parent-pid census can
 * attribute it to the command (#4624). Prints `mid:` and `pid:` lines. The
 * grandchild is detached: Node ends a non-detached child with its parent
 * (libuv's own kill-on-close job), so only a detached one outlives it.
 */
const ORPHANING = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', \\"console.log('pid:' + process.pid); setInterval(() => {}, 1000)\\"], { stdio: 'inherit', detached: true }).unref(); console.log('mid:' + process.pid); setTimeout(() => process.exit(0), 300)"], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`;

/** Waits until the orphaning command's middle process has exited. */
async function orphaned(read: () => string): Promise<number> {
  await expect
    .poll(() => /mid:(\d+)/.exec(read())?.[1], { timeout: 20_000 })
    .toBeDefined();
  const middle = Number(/mid:(\d+)/.exec(read())![1]);
  started.push(middle);
  await expect
    .poll(() => alive(middle), { timeout: 20_000, interval: 100 })
    .toBe(false);
  return middle;
}

/**
 * A leader that SIGTERM ends, and a child of it that ignores SIGTERM and
 * holds the output pipe open.
 */
const STUBBORN_CHILD = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('pid:' + process.pid); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`;

/** The real session protocol with control stdin retained by this test owner. */
function controlledSession(parentPid = process.pid) {
  if (!guard) throw new Error('Source-bound Job guard was not built');
  const identity = spawnSyncBounded(
    guard.path,
    ['--identity', String(parentPid)],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    },
  );
  if (identity.error || identity.status !== 0)
    throw new Error(`Parent identity failed: ${identity.stderr}`);
  const script = `
require('node:child_process').spawn(process.execPath, ['-e', "console.log('pid:' + process.pid); setInterval(() => {}, 1000)"], { stdio: 'inherit', detached: true, windowsHide: true }).unref();
process.stdin.once('data', () => process.exit(7));
`;
  const child = nodeSpawn(
    guard.path,
    [
      '--session',
      String(parentPid),
      identity.stdout.trim(),
      process.execPath,
      windowsCommandLine(process.execPath, ['-e', script], false),
    ],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    },
  );
  if (child.pid) started.push(child.pid);
  const exited = new Promise<number | null>((done) =>
    child.once('close', done),
  );
  let control = '';
  let output = '';
  let resumed = false;
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (data: string) => {
    control += data;
    const bound = /^BOUND (\d+) \S+/m.exec(control);
    if (bound && !resumed) {
      started.push(Number(bound[1]));
      resumed = true;
      child.stdin!.write('RESUME\n');
    }
  });
  child.stdin!.on('error', () => {});
  const stdout = child.stdio[3];
  const stdin = child.stdio[5];
  if (!(stdout instanceof Duplex) || !(stdin instanceof Duplex))
    throw new Error('Session fixture pipes unavailable');
  stdout.setEncoding('utf8');
  stdout.on('data', (data: string) => {
    output += data;
  });
  stdin.on('error', () => {});
  return {
    child,
    exited,
    control: () => control,
    async leaderExit() {
      await expect
        .poll(() => /pid:(\d+)/.exec(output)?.[1], { timeout: 20_000 })
        .toBeDefined();
      const descendant = Number(/pid:(\d+)/.exec(output)![1]);
      started.push(descendant);
      stdin.write('exit\n');
      await expect.poll(() => control, { timeout: 20_000 }).toContain('EXIT 7');
      expect(alive(descendant)).toBe(true);
      return descendant;
    },
  };
}

describe.skipIf(windows)('command termination custody (POSIX)', () => {
  it('Stop ends a child that ignores SIGTERM after its parent exits', async () => {
    const { proc, pidsOf } = await run(STUBBORN_CHILD);
    const [child] = await pidsOf(1);
    expect(alive(child!)).toBe(true);
    await proc.terminate();
    expect(alive(proc.pid)).toBe(false);
    expect(alive(child!)).toBe(false);
  }, 30_000);

  it('the output cap ends a child that ignores SIGTERM after its parent exits', async () => {
    const flood = `${STUBBORN_CHILD}
setTimeout(() => setInterval(() => process.stdout.write('x'.repeat(65536)), 1), 300);`;
    const { exited, pidsOf } = await run(flood, 256 * 1024);
    const [child] = await pidsOf(1);
    expect((await exited).outputCapped).toBe(true);
    await expect
      .poll(() => alive(child!), { timeout: 15_000, interval: 100 })
      .toBe(false);
  }, 30_000);

  it('a command that already exited claims nothing further', async () => {
    const { proc, exited } = await run('process.exit(0)');
    await exited;
    await expect(proc.terminate()).resolves.toBeUndefined();
  }, 30_000);
});

describe.runIf(windows)('command termination custody (Windows)', () => {
  it('ends the Job when delivery pauses on a below-cap tail after EXIT', async () => {
    if (!guard || !fixtureDirectory)
      throw new Error('Source-bound Job fixture unavailable');
    const marker = join(fixtureDirectory, 'post-exit-output');
    const childSource = `
const { existsSync, watch } = require('node:fs');
const marker = ${JSON.stringify(marker)};
let sent = false;
const watcher = watch(${JSON.stringify(fixtureDirectory)}, () => {
  if (sent || !existsSync(marker)) return;
  sent = true;
  watcher.close();
  process.stdout.write('post-exit-tail\\n');
});
console.log('pid:' + process.pid);
setInterval(() => {}, 1000);
`;
    const leaderSource = `
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
  stdio: 'inherit', detached: true, windowsHide: true,
}).unref();
process.stdin.once('data', () => process.exit(7));
`;
    let control = '';
    let exitObserved = false;
    const proc = await spawnCommandProcess(
      {
        command: process.execPath,
        args: ['-e', leaderSource],
        cwd: process.cwd(),
        env: process.env,
        outputCapBytes: 1024,
        windowsGuard: guard.path,
      },
      (file, args, options) => {
        const child = nodeSpawn(file, args, { ...options, windowsHide: true });
        if (child.pid) started.push(child.pid);
        child.stdout?.on('data', (chunk) => {
          control += String(chunk);
          if (!exitObserved && control.split(/\r?\n/).includes('EXIT 7')) {
            exitObserved = true;
            writeFileSync(marker, 'emit tail');
          }
        });
        return child;
      },
    );
    started.push(proc.pid);
    let text = '';
    let pausedAfterExit = false;
    proc.onData((data) => {
      text += data;
      if (text.includes('post-exit-tail')) {
        pausedAfterExit = exitObserved && !alive(proc.pid);
        proc.pause();
      }
    });
    const exited = new Promise<{
      outputIncomplete?: boolean;
      outputCapped?: boolean;
    }>((done) => proc.onExit(done));
    await expect
      .poll(() => /pid:(\d+)/.exec(text)?.[1], { timeout: 20_000 })
      .toBeDefined();
    const descendant = Number(/pid:(\d+)/.exec(text)![1]);
    started.push(descendant);
    expect(alive(descendant)).toBe(true);
    proc.write('exit\n');
    const event = await exited;
    console.info('post-EXIT paused tail verdict', {
      event,
      text,
      pausedAfterExit,
      descendant,
      descendantAlive: alive(descendant),
    });
    expect(pausedAfterExit).toBe(true);
    expect(text).toContain('post-exit-tail');
    expect(event.outputCapped).not.toBe(true);
    expect(event.outputIncomplete).toBe(true);
    expect(alive(descendant)).toBe(false);
  }, 120_000);

  it('the output cap retains custody after fast leader exit while delivery is paused', async () => {
    const { proc, exited, pidsOf, read } = await run(
      `
require('node:child_process').spawn(process.execPath, ['-e', "console.log('pid:' + process.pid); setInterval(() => {}, 1000)"], { stdio: 'inherit', detached: true, windowsHide: true }).unref();
process.stdin.once('data', () => process.stdout.write('x'.repeat(2048), () => process.exit(0)));
`,
      1024,
    );
    const [child] = await pidsOf(1);
    expect(alive(child!)).toBe(true);
    proc.pause();
    proc.write('flush\n');
    const event = await exited;
    console.info('paused-cap verdict', {
      event,
      deliveredBytes: Buffer.byteLength(read()),
      leader: proc.pid,
      child,
      leaderAlive: alive(proc.pid),
      childAlive: alive(child!),
    });
    expect.soft(event.outputCapped).toBe(true);
    expect.soft(Buffer.byteLength(read())).toBeLessThanOrEqual(1024);
    expect.soft(alive(proc.pid)).toBe(false);
    expect(alive(child!)).toBe(false);
  }, 120_000);

  it.each([
    { name: 'Stop after EXIT', action: 'ABORT\n' },
    { name: 'control EOF after EXIT', action: null },
    { name: 'invalid acknowledgement after EXIT', action: 'INVALID\n' },
    { name: 'missing acknowledgement after EXIT', action: '' },
  ])(
    'fails closed for $name',
    async ({ action }) => {
      const session = controlledSession();
      const descendant = await session.leaderExit();
      if (action === null) session.child.stdin!.end();
      else if (action) session.child.stdin!.write(action);
      expect(await session.exited).toBe(0);
      expect(session.control()).toContain('ENDED');
      expect(session.control()).not.toContain('COMPLETE');
      expect(alive(descendant)).toBe(false);
    },
    60_000,
  );

  it('ends the Job after EXIT when its parent dies with control still open', async () => {
    const parent = nodeSpawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    if (!parent.pid) throw new Error('Parent fixture did not start');
    started.push(parent.pid);
    const parentExited = new Promise<void>((done) =>
      parent.once('exit', () => done()),
    );
    const session = controlledSession(parent.pid);
    const descendant = await session.leaderExit();
    const killedAt = Date.now();
    parent.kill('SIGKILL');
    await parentExited;
    expect(session.child.stdin!.writable).toBe(true);
    expect(await session.exited).toBe(0);
    expect(Date.now() - killedAt).toBeLessThan(5_000);
    expect(session.control()).toContain('ENDED');
    expect(session.control()).not.toContain('COMPLETE');
    expect(alive(descendant)).toBe(false);
  }, 60_000);

  it('Stop ends the command, its child and its grandchild', async () => {
    const tree = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', \\"console.log('pid:' + process.pid); setInterval(() => {}, 1000)\\"], { stdio: 'inherit' }); console.log('pid:' + process.pid); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`;
    const { proc, pidsOf } = await run(tree);
    const pids = await pidsOf(2);
    await proc.terminate();
    for (const pid of [proc.pid, ...pids])
      expect(alive(pid), `${pid}`).toBe(false);
  }, 120_000);

  it('Stop ends a descendant whose parent had already exited (#4624)', async () => {
    const { proc, pidsOf, read } = await run(ORPHANING);
    const [grandchild] = await pidsOf(1);
    await orphaned(read);
    expect(alive(grandchild!)).toBe(true);
    await proc.terminate();
    expect(alive(proc.pid)).toBe(false);
    expect(alive(grandchild!)).toBe(false);
  }, 120_000);

  it('the output cap ends a descendant whose parent had already exited (#4624)', async () => {
    const flood = `${ORPHANING}
setTimeout(() => setInterval(() => process.stdout.write('x'.repeat(65536)), 1), 2000);`;
    const { exited, pidsOf, read } = await run(flood, 512 * 1024);
    const [grandchild] = await pidsOf(1);
    await orphaned(read);
    expect((await exited).outputCapped).toBe(true);
    await expect
      .poll(() => alive(grandchild!), { timeout: 30_000, interval: 100 })
      .toBe(false);
  }, 120_000);

  it('a command in its Job still takes typed input (#4624)', async () => {
    const { proc, read } = await run(
      "process.stdin.setEncoding('utf8'); process.stdin.on('data', (line) => console.log('got:' + line.trim())); console.log('ready')",
    );
    await expect.poll(read, { timeout: 20_000 }).toContain('ready');
    proc.write('typed text\n');
    await expect.poll(read, { timeout: 20_000 }).toContain('got:typed text');
    await proc.terminate();
  }, 60_000);

  it('a command in its Job gets its arguments as Node passes them (#4624)', async () => {
    const args = ['a b', 'q"x', 'dir\\ end\\', '', 'plain', 'tab\there'];
    const proc = await spawnCommandProcess({
      command: process.execPath,
      args: [
        '-e',
        "console.log('argv:' + JSON.stringify(process.argv.slice(1)))",
        ...args,
      ],
      cwd: process.cwd(),
      env: process.env,
      windowsGuard: guard?.path,
    });
    started.push(proc.pid);
    let text = '';
    proc.onData((data) => {
      text += data;
    });
    await new Promise<void>((done) => proc.onExit(() => done()));
    expect(JSON.parse(/argv:(.*)/.exec(text)![1]!)).toEqual(args);
  }, 60_000);

  it('a command that exits by itself leaves what it started running, as on POSIX', async () => {
    // Detached, so Node's own job does not end it with the command; the
    // command's Job must be released for it to survive.
    const { exited, pidsOf } = await run(
      "require('node:child_process').spawn(process.execPath, ['-e', \"console.log('pid:' + process.pid); setInterval(() => {}, 1000)\"], { stdio: 'inherit', detached: true }).unref(); setTimeout(() => process.exit(3), 500)",
    );
    const [child] = await pidsOf(1);
    expect(await exited).toMatchObject({ exitCode: 3, signal: null });
    expect(alive(child!)).toBe(true);
  }, 60_000);

  it('Stop fails when the Job cannot be confirmed ended, never reporting success', async () => {
    expect(guard?.path).toBeTruthy();
    // A guard that binds, then answers ABORT without confirming the Job ended.
    const unconfirmed = `
process.stdout.write('BOUND ' + process.pid + ' 2026-01-01T00:00:00.0000000Z\\n');
let lines = 0;
process.stdin.on('data', (chunk) => {
  lines += String(chunk).split('\\n').length - 1;
  if (lines >= 2) process.exit(125);
});
setInterval(() => {}, 1000);
`;
    const proc = await spawnCommandProcess(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        env: process.env,
        windowsGuard: guard?.path,
      },
      (_guard, _args, options) =>
        nodeSpawn(process.execPath, ['-e', unconfirmed], options),
    );
    started.push(proc.pid);
    await expect(proc.terminate()).rejects.toThrow(/could not be confirmed/);
  }, 60_000);

  it('keeps ending descendants until the process table shows none, and only proven ones', async () => {
    let round = 0;
    const killed: number[][] = [];
    const spawnedUs = windowsNowUs();
    const proc = await spawnCommandProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: process.env,
      // The process-table path a command without a Job takes.
      windowsGuard: null,
      windowsCensus: {
        list: async () => {
          round++;
          if (round === 1)
            return [
              // The leader's child, orphaned once the leader was ended.
              { pid: 900_001, ppid: proc.pid, createdUs: spawnedUs + 1_000n },
              // An unrelated process created before the leader: not ours.
              { pid: 900_009, ppid: proc.pid, createdUs: spawnedUs - 1n },
            ];
          // Started by the child while the first kill ran.
          if (round === 2)
            return [
              { pid: 900_002, ppid: 900_001, createdUs: spawnedUs + 2_000n },
            ];
          return [];
        },
        kill: async (pids) => {
          killed.push(pids);
        },
      },
    });
    started.push(proc.pid);
    // The leader has been running a while before it is stopped.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await proc.terminate();
    // The leader is ended directly; the table only finds what it started.
    expect(alive(proc.pid)).toBe(false);
    expect(killed).toEqual([[900_001], [900_002]]);
    expect(round).toBe(3);
  }, 60_000);

  it('ends the command at once, while its process table is still being read', async () => {
    // A cold PowerShell process-table read can take tens of seconds.
    let release!: () => void;
    const tableRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proc = await spawnCommandProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: process.env,
      // The process-table path a command without a Job takes.
      windowsGuard: null,
      windowsCensus: {
        list: async () => {
          await tableRead;
          return [];
        },
        kill: async () => undefined,
      },
    });
    started.push(proc.pid);
    const exited = new Promise<void>((done) => proc.onExit(() => done()));
    const terminated = proc.terminate();
    // The exit is reported while the read is still outstanding.
    await expect(
      Promise.race([
        exited.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('running'), 10_000)),
      ]),
    ).resolves.toBe('exited');
    expect(alive(proc.pid)).toBe(false);
    release();
    await terminated;
  }, 60_000);
});
