/**
 * #3994 a command session's termination ends what the command started, not
 * just the command. Real processes: the leader exiting must not end custody
 * while a process it started still runs, whether termination came from Stop
 * or from the output cap.
 */
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCommandProcess } from '../command-process.js';
import { resolveWindowsCommandGuard } from '../windows-command-guard.js';
import { windowsNowUs } from '../windows-owned-processes.js';

const windows = process.platform === 'win32';
const started: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

afterEach(() => {
  // Only processes this file started, by the pids they reported.
  for (const pid of started.splice(0))
    if (alive(pid))
      if (windows)
        spawnSync('taskkill', ['/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
        });
      else process.kill(pid, 'SIGKILL');
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
    ...(windowsGuard !== undefined && { windowsGuard }),
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
 * attribute it to the command (#4624). Prints `mid:` and `pid:` lines.
 */
const ORPHANING = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', \\"console.log('pid:' + process.pid); setInterval(() => {}, 1000)\\"], { stdio: 'inherit' }).unref(); console.log('mid:' + process.pid); setTimeout(() => process.exit(0), 300)"], { stdio: 'inherit' });
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
    const { exited, pidsOf } = await run(
      "require('node:child_process').spawn(process.execPath, ['-e', \"console.log('pid:' + process.pid); setInterval(() => {}, 1000)\"], { stdio: 'inherit' }).unref(); setTimeout(() => process.exit(3), 500)",
    );
    const [child] = await pidsOf(1);
    expect(await exited).toMatchObject({ exitCode: 3, signal: null });
    expect(alive(child!)).toBe(true);
  }, 60_000);

  it('Stop fails when the Job cannot be confirmed ended, never reporting success', async () => {
    const guard = await resolveWindowsCommandGuard();
    expect(guard).toBeTruthy();
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
        windowsGuard: guard,
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
