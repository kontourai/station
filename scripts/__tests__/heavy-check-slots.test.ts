import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  acquireHeavyCheckSlot,
  HEAVY_CHECK_HELD_ENV,
  resolveHeavyCheckSlotCount,
} from '../lib/heavy-check-slots.mjs';
import { slotPath } from '../lib/typecheck-host-slots.mjs';

/**
 * Every admission case runs the real runner (`scripts/heavy-check-slot.mjs`)
 * as a child process against a private slot directory and asserts its exit
 * status: what a package script or the pre-push hook branches on.
 */

const RUNNER = resolve('scripts/heavy-check-slot.mjs');
const GIB = 1024 ** 3;
const makeTempDir = trackTempDirs();
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill();
});

/**
 * A check that logs its start, optionally waits for a release file, logs its
 * end and exits with the requested status.
 */
const CHECK = `import { appendFileSync, existsSync } from 'node:fs';
const [log, name, release, code] = process.argv.slice(2);
appendFileSync(log, name + ' start\\n');
const until = Date.now() + 20_000;
while (release && !existsSync(release) && Date.now() < until)
  await new Promise((done) => setTimeout(done, 25));
appendFileSync(log, name + ' end\\n');
process.exit(Number(code || 0));
`;

/** A check that runs another slotted check and exits with its status. */
const NESTING_CHECK = `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [runner, check, log] = process.argv.slice(2);
appendFileSync(log, 'outer start\\n');
const inner = spawnSync(process.execPath, [runner, 'inner', check, log, 'inner', '', '0'], { stdio: 'inherit', windowsHide: true });
appendFileSync(log, 'outer end\\n');
process.exit(inner.status ?? 1);
`;

function workspace() {
  const root = makeTempDir('heavy-check-slots-');
  const check = join(root, 'check.mjs');
  const nesting = join(root, 'nesting.mjs');
  writeFileSync(check, CHECK);
  writeFileSync(nesting, NESTING_CHECK);
  return {
    root,
    check,
    nesting,
    slotDir: join(root, 'slots'),
    log: join(root, 'order.log'),
    release: join(root, 'release'),
    lines(): string[] {
      return existsSync(this.log)
        ? readFileSync(this.log, 'utf8').trim().split('\n').filter(Boolean)
        : [];
    },
  };
}

/**
 * A host-local pool of one. Hosted CI's exemption and the held marker of the
 * Vitest run executing this file are removed unless a case sets them.
 */
function poolEnv(
  slotDir: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env[HEAVY_CHECK_HELD_ENV];
  return {
    ...env,
    STATION_HEAVY_CHECK_SLOT_DIR: slotDir,
    STATION_HEAVY_CHECK_SLOTS: '1',
    STATION_HEAVY_CHECK_SLOT_WAIT_MS: '20000',
    ...extra,
  };
}

function runSync(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
}

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [RUNNER, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((done) =>
    child.once('close', (code) => done(code)),
  );
  return { child, exited, stderr: () => stderr };
}

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** A slot record held by this test process, which stays alive throughout. */
function holdSlot(slotDir: string, label = 'docs:truth:gate') {
  mkdirSync(slotDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    slotPath(slotDir, 0),
    JSON.stringify({
      pid: process.pid,
      start: null,
      nonce: 'held-by-the-test',
      acquiredAt: Date.now(),
      label,
    }),
  );
}

/** The pid of a process that has already exited. */
function deadPid(): number {
  const gone = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  expect(gone.status).toBe(0);
  return gone.pid as number;
}

describe('heavy-check slot count', () => {
  test('is the smaller of one per four CPUs and one per 8 GiB, between 1 and 4', () => {
    const count = (cpus: number, gib: number, env = {}) =>
      resolveHeavyCheckSlotCount({ env, cpus, totalmem: gib * GIB });
    // The host that motivated the pool: 4 cores, ~15.6 GiB.
    expect(count(4, 15.6)).toBe(1);
    expect(count(8, 16)).toBe(2);
    expect(count(16, 16)).toBe(2);
    expect(count(16, 48)).toBe(4);
    expect(count(64, 256)).toBe(4);
    expect(count(2, 4)).toBe(1);
    expect(count(2, 4, { STATION_HEAVY_CHECK_SLOTS: '3' })).toBe(3);
    for (const bad of ['0', '65', '1.5', 'two'])
      expect(() => count(4, 16, { STATION_HEAVY_CHECK_SLOTS: bad })).toThrow(
        /STATION_HEAVY_CHECK_SLOTS/,
      );
  });
});

describe('heavy-check slot runner (child processes)', () => {
  test('a second check waits for the holder, names it, and runs after it exits', async () => {
    const w = workspace();
    const env = poolEnv(w.slotDir);
    const first = start(
      ['first-check', w.check, w.log, 'A', w.release, '0'],
      env,
    );
    await until(() => w.lines().includes('A start'), 'the first check');
    const second = start(['second-check', w.check, w.log, 'B', '', '7'], env);
    await until(
      () => second.stderr().includes('waiting for a heavy-check slot'),
      'the second check to queue',
    );
    expect(second.stderr()).toContain(
      `[heavy-check-slots] waiting for a heavy-check slot for second-check: 1/1 held by pid ${first.child.pid} (first-check)`,
    );
    // Queued, not running alongside.
    expect(w.lines()).toEqual(['A start']);
    writeFileSync(w.release, '');
    expect(await first.exited).toBe(0);
    // The check's own status is the runner's.
    expect(await second.exited).toBe(7);
    expect(w.lines()).toEqual(['A start', 'A end', 'B start', 'B end']);
  }, 60_000);

  test('reclaims a slot whose holder died and runs the check', () => {
    const w = workspace();
    holdSlot(w.slotDir);
    const record = JSON.parse(readFileSync(slotPath(w.slotDir, 0), 'utf8'));
    writeFileSync(
      slotPath(w.slotDir, 0),
      JSON.stringify({ ...record, pid: deadPid(), nonce: 'dead-holder' }),
    );
    const result = runSync(
      ['after-crash', w.check, w.log, 'C', '', '0'],
      poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0' }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(w.lines()).toEqual(['C start', 'C end']);
    expect(
      JSON.parse(readFileSync(slotPath(w.slotDir, 0), 'utf8')).nonce,
    ).not.toBe('dead-holder');
  });

  test('fails loudly, naming the holder, when the bounded wait runs out', () => {
    const w = workspace();
    holdSlot(w.slotDir);
    const result = runSync(
      ['starved-check', w.check, w.log, 'D', '', '0'],
      poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0' }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      new RegExp(
        `^FAIL: waited 0s for a heavy-check slot for starved-check; all 1 are held: pid ${process.pid} \\(docs:truth:gate\\)`,
        'm',
      ),
    );
    expect(result.stderr).toContain('STATION_HEAVY_CHECK_SLOT_WAIT_MS');
    // Never silently skipped into a pass: the check did not run.
    expect(w.lines()).toEqual([]);
  });

  test('a slotted check started by a slot holder runs under that slot instead of deadlocking', () => {
    const w = workspace();
    const result = runSync(
      ['outer', w.nesting, RUNNER, w.check, w.log],
      poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOT_WAIT_MS: '3000' }),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(w.lines()).toEqual([
      'outer start',
      'inner start',
      'inner end',
      'outer end',
    ]);
    expect(result.stderr).not.toContain('waiting for a heavy-check slot');
  });

  test('a held marker admits only while the exact process it names is alive', () => {
    const w = workspace();
    holdSlot(w.slotDir);
    const leaked = runSync(
      ['leaked-marker', w.check, w.log, 'E', '', '0'],
      poolEnv(w.slotDir, {
        STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0',
        [HEAVY_CHECK_HELD_ENV]: String(deadPid()),
      }),
    );
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain('FAIL: waited 0s for a heavy-check slot');
    expect(w.lines()).toEqual([]);

    const live = runSync(
      ['live-marker', w.check, w.log, 'F', '', '0'],
      poolEnv(w.slotDir, {
        STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0',
        [HEAVY_CHECK_HELD_ENV]: String(process.pid),
      }),
    );
    expect(live.status, live.stderr).toBe(0);
    expect(live.stderr).toContain(
      `[heavy-check-slots] live-marker runs under the heavy-check slot held by pid ${process.pid}.`,
    );
    expect(w.lines()).toEqual(['F start', 'F end']);

    // A live pid whose birth differs from the marker's is a recycled pid.
    if (process.platform !== 'win32') {
      const recycled = runSync(
        ['recycled-marker', w.check, w.log, 'R', '', '0'],
        poolEnv(w.slotDir, {
          STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0',
          [HEAVY_CHECK_HELD_ENV]: `${process.pid}:not-this-process-birth`,
        }),
      );
      expect(recycled.status).toBe(1);
      expect(recycled.stderr).toContain(
        'FAIL: waited 0s for a heavy-check slot for recycled-marker',
      );
      expect(w.lines()).toEqual(['F start', 'F end']);
    }
  });

  test('queued checks are admitted in arrival order, not by who polls fastest', async () => {
    const w = workspace();
    holdSlot(w.slotDir);
    const env = poolEnv(w.slotDir);
    const order: string[] = [];
    const quiet = () => {};
    // The earlier waiter polls slowly and the later one forty times as
    // often: without arrival order the later one claims the freed slot.
    const early = acquireHeavyCheckSlot({
      label: 'early',
      env,
      pollMs: 400,
      log: quiet,
    }).then((slot) => {
      order.push('early');
      return slot;
    });
    await new Promise((done) => setTimeout(done, 100));
    const late = acquireHeavyCheckSlot({
      label: 'late',
      env,
      pollMs: 10,
      log: quiet,
    }).then((slot) => {
      order.push('late');
      return slot;
    });
    await new Promise((done) => setTimeout(done, 300));
    expect(order).toEqual([]);
    rmSync(slotPath(w.slotDir, 0));
    const first = await early;
    await new Promise((done) => setTimeout(done, 300));
    expect(order).toEqual(['early']);
    first.release();
    (await late).release();
    expect(order).toEqual(['early', 'late']);
    // No ticket outlives its waiter.
    expect(readdirSync(join(w.slotDir, 'queue'))).toEqual([]);
  }, 30_000);

  test('the check receives the Node flags given to the runner', () => {
    const w = workspace();
    const probe = join(w.root, 'flags.mjs');
    writeFileSync(
      probe,
      'process.stdout.write(JSON.stringify(process.execArgv));\n',
    );
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=321', RUNNER, 'flags', probe],
      { env: poolEnv(w.slotDir), encoding: 'utf8', windowsHide: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContain('--max-old-space-size=321');
  });

  test('hosted CI runs the check without taking a slot, and says so', () => {
    const w = workspace();
    holdSlot(w.slotDir);
    const hosted = runSync(
      ['hosted-check', w.check, w.log, 'G', '', '0'],
      poolEnv(w.slotDir, {
        STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0',
        GITHUB_ACTIONS: 'true',
      }),
    );
    expect(hosted.status, hosted.stderr).toBe(0);
    expect(hosted.stderr).toContain(
      '[heavy-check-slots] hosted CI (GITHUB_ACTIONS=true): hosted-check runs without a host slot.',
    );
    expect(w.lines()).toEqual(['G start', 'G end']);

    // Local tools export CI too; that alone does not skip the queue.
    const local = runSync(
      ['local-ci-flag', w.check, w.log, 'L', '', '0'],
      poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0', CI: '1' }),
    );
    expect(local.status).toBe(1);
    expect(local.stderr).toContain(
      'FAIL: waited 0s for a heavy-check slot for local-ci-flag',
    );
    expect(w.lines()).toEqual(['G start', 'G end']);
  });

  test('refuses a malformed invocation or pool setting instead of running unadmitted', () => {
    const w = workspace();
    const usage = runSync(['only-a-label'], poolEnv(w.slotDir));
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('Usage: node scripts/heavy-check-slot.mjs');

    const badCount = runSync(
      ['bad-count', w.check, w.log, 'H', '', '0'],
      poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOTS: '0' }),
    );
    expect(badCount.status).toBe(1);
    expect(badCount.stderr).toContain('STATION_HEAVY_CHECK_SLOTS="0"');
    expect(w.lines()).toEqual([]);
  });
});
