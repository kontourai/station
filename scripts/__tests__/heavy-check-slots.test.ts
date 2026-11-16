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
import { pathToFileURL } from 'node:url';
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
  // real-time: the child polls for the parent's release file, bounded by the 20 s deadline above.
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

  test('a held marker admits only while the exact claim it names is live', () => {
    const w = workspace();
    holdSlot(w.slotDir);
    // Claims held elsewhere (another pool directory), as an ancestor's.
    const claims = join(w.root, 'claims');
    mkdirSync(claims, { mode: 0o700 });
    const claim = (index: number, pid: number, nonce: string) =>
      writeFileSync(
        slotPath(claims, index),
        JSON.stringify({ pid, start: null, nonce, acquiredAt: Date.now() }),
      );
    const marker = (index: number, nonce: string) =>
      JSON.stringify({ dir: claims, index, nonce });
    claim(0, deadPid(), 'dead-holder');
    claim(2, process.pid, 'live-holder');
    claim(3, process.pid, 'someone-else');
    const run = (label: string, held: string) =>
      runSync(
        [label, w.check, w.log, label, '', '0'],
        poolEnv(w.slotDir, {
          STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0',
          [HEAVY_CHECK_HELD_ENV]: held,
        }),
      );

    const refused = {
      'dead-holder': run('dead-holder', marker(0, 'dead-holder')),
      // The slot was released: nothing is recorded there any more.
      released: run('released', marker(1, 'released-claim')),
      // Released, then claimed by another check: its nonce differs.
      reclaimed: run('reclaimed', marker(3, 'released-claim')),
      'pid-only': run('pid-only', String(process.pid)),
    };
    for (const [label, result] of Object.entries(refused)) {
      expect(result.status, label).toBe(1);
      expect(result.stderr).toContain(
        `FAIL: waited 0s for a heavy-check slot for ${label}`,
      );
    }
    expect(w.lines()).toEqual([]);

    const live = run('live-claim', marker(2, 'live-holder'));
    expect(live.status, live.stderr).toBe(0);
    expect(live.stderr).toContain(
      `[heavy-check-slots] live-claim runs under the heavy-check slot held by pid ${process.pid}.`,
    );
    expect(w.lines()).toEqual(['live-claim start', 'live-claim end']);
  });

  test('with several slots, a later waiter cannot take a slot an earlier one is owed', async () => {
    const w = workspace();
    mkdirSync(w.slotDir, { recursive: true, mode: 0o700 });
    for (const index of [0, 1])
      writeFileSync(
        slotPath(w.slotDir, index),
        JSON.stringify({
          pid: process.pid,
          start: null,
          nonce: `busy-${index}`,
          acquiredAt: Date.now(),
        }),
      );
    const env = poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOTS: '2' });
    const order: string[] = [];
    const quiet = () => {};
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
    rmSync(slotPath(w.slotDir, 1));
    const first = await early;
    await new Promise((done) => setTimeout(done, 300));
    // One slot freed: the earlier waiter took it, the later one still waits.
    expect(order).toEqual(['early']);
    rmSync(slotPath(w.slotDir, 0));
    (await late).release();
    first.release();
    expect(order).toEqual(['early', 'late']);
  }, 30_000);

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

/**
 * A heavy check that takes its own slot, as `code-health-gate.mjs` and the
 * fallow runners do (#5080): it is started directly, not through the runner.
 */
const SELF_SLOTTED_CHECK = `import { appendFileSync, existsSync } from 'node:fs';
import { holdHeavyCheckSlotForProcess } from ${JSON.stringify(
  pathToFileURL(resolve('scripts/lib/heavy-check-slots.mjs')).href,
)};
const [log, name, release] = process.argv.slice(2);
if (!(await holdHeavyCheckSlotForProcess(name))) process.exit(1);
appendFileSync(log, name + ' start\\n');
const until = Date.now() + 20_000;
while (release && !existsSync(release) && Date.now() < until)
  // real-time: the child polls for the parent's release file, bounded by the 20 s deadline above.
  await new Promise((done) => setTimeout(done, 25));
appendFileSync(log, name + ' end\\n');
`;

/** Every entry point that runs a fallow analysis, with the label it queues under. */
const PACKAGE_SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync('package.json', 'utf8'),
).scripts;
const FALLOW_PACKAGE_SCRIPTS = ['fallow', 'fallow:dead-code', 'fallow:audit'];
const FALLOW_ENTRY_POINTS: ReadonlyArray<{
  label: string;
  args: string[];
}> = [
  { label: 'code-health-gate', args: ['scripts/code-health-gate.mjs'] },
  {
    label: 'code-health-gate',
    args: ['scripts/code-health-gate.mjs', '--base=HEAD'],
  },
  { label: 'fallow audit', args: ['scripts/run-fallow-audit.mjs'] },
  {
    label: 'fallow audit --whole-tree',
    args: ['scripts/run-fallow-audit.mjs', '--whole-tree'],
  },
  { label: 'fallow:baseline', args: ['scripts/fallow-baseline.mjs'] },
  { label: 'fallow:ceiling', args: ['scripts/fallow-ceiling.mjs'] },
  {
    label: 'fallow:ceiling',
    args: ['scripts/fallow-ceiling.mjs', '--write'],
  },
  // Package scripts that run the fallow launcher go through the runner.
  ...FALLOW_PACKAGE_SCRIPTS.map((name) => ({
    label: name,
    args: PACKAGE_SCRIPTS[name].split(' ').slice(1),
  })),
];

describe('heavy checks that take their own slot (#5080)', () => {
  test('two concurrent self-slotted checks run one after the other', async () => {
    const w = workspace();
    const check = join(w.root, 'self-slotted.mjs');
    writeFileSync(check, SELF_SLOTTED_CHECK);
    const env = poolEnv(w.slotDir);
    const launch = (name: string, release = '') => {
      const child = spawn(process.execPath, [check, w.log, name, release], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<number | null>((done) =>
        child.once('close', (code) => done(code)),
      );
      return { child, exited, stderr: () => stderr };
    };
    const first = launch('first-gate', w.release);
    await until(
      () => w.lines().includes('first-gate start'),
      'the first check',
    );
    const second = launch('second-gate');
    await until(
      () => second.stderr().includes('waiting for a heavy-check slot'),
      'the second check to queue',
    );
    expect(second.stderr()).toContain(
      `waiting for a heavy-check slot for second-gate: 1/1 held by pid ${first.child.pid} (first-gate)`,
    );
    expect(w.lines()).toEqual(['first-gate start']);
    writeFileSync(w.release, '');
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(w.lines()).toEqual([
      'first-gate start',
      'first-gate end',
      'second-gate start',
      'second-gate end',
    ]);
  }, 60_000);

  test('package scripts that launch fallow directly go through the slot runner', () => {
    for (const name of FALLOW_PACKAGE_SCRIPTS)
      expect(PACKAGE_SCRIPTS[name], name).toMatch(
        new RegExp(
          `^node scripts/heavy-check-slot\\.mjs ${name} node_modules/fallow/bin/fallow `,
        ),
      );
  });

  test.each(
    FALLOW_ENTRY_POINTS.map((entry) => [entry.args.join(' '), entry] as const),
  )('%s queues for the slot before any analysis', (_name, { label, args }) => {
    const w = workspace();
    // Run from an empty directory: anything that slipped past the slot
    // would analyse it, never this repository.
    const project = join(w.root, 'project');
    mkdirSync(project);
    holdSlot(w.slotDir, 'another worktree');
    const result = spawnSync(
      process.execPath,
      args.map((arg) =>
        /^(scripts|node_modules)\//.test(arg) ? resolve(arg) : arg,
      ),
      {
        cwd: project,
        env: {
          ...poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0' }),
          GIT_CEILING_DIRECTORIES: w.root,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain(
      `FAIL: waited 0s for a heavy-check slot for ${label}; all 1 are held: pid ${process.pid} (another worktree)`,
    );
    expect(result.stdout).toBe('');
    expect(readdirSync(project)).toEqual([]);
  });

  test('a code-health gate runs once the holder releases its slot', async () => {
    const w = workspace();
    const project = join(w.root, 'not-a-repository');
    mkdirSync(project);
    holdSlot(w.slotDir, 'another worktree');
    const gate = spawn(
      process.execPath,
      [resolve('scripts/code-health-gate.mjs'), '--base=HEAD'],
      {
        cwd: project,
        env: {
          ...poolEnv(w.slotDir),
          GIT_CEILING_DIRECTORIES: w.root,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    children.push(gate);
    let stderr = '';
    gate.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    gate.stdout?.resume();
    const exited = new Promise<number | null>((done) =>
      gate.once('close', (code) => done(code)),
    );
    await until(
      () =>
        stderr.includes('waiting for a heavy-check slot for code-health-gate'),
      'the gate to queue',
    );
    // Queued: it has not started its analysis.
    expect(readdirSync(project)).toEqual([]);
    rmSync(slotPath(w.slotDir, 0));
    // Admitted, it runs, and reaches the git step it cannot pass here.
    expect(await exited).toBe(2);
    expect(stderr).toMatch(/git|repository/i);
  }, 60_000);

  test('a code-health gate under a live slot holder, or in hosted CI, takes no slot', () => {
    const w = workspace();
    holdSlot(w.slotDir, 'ci:fast');
    const project = join(w.root, 'not-a-repository');
    mkdirSync(project);
    const run = (extra: Record<string, string>) =>
      spawnSync(
        process.execPath,
        [resolve('scripts/code-health-gate.mjs'), '--base=HEAD'],
        {
          cwd: project,
          env: {
            ...poolEnv(w.slotDir, { STATION_HEAVY_CHECK_SLOT_WAIT_MS: '0' }),
            GIT_CEILING_DIRECTORIES: w.root,
            ...extra,
          },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000,
        },
      );
    const nested = run({
      [HEAVY_CHECK_HELD_ENV]: JSON.stringify({
        dir: w.slotDir,
        index: 0,
        nonce: 'held-by-the-test',
      }),
    });
    expect(nested.stderr).toContain(
      `[heavy-check-slots] code-health-gate runs under the heavy-check slot held by pid ${process.pid}.`,
    );
    expect(nested.stderr).not.toContain('waiting for a heavy-check slot');
    const hosted = run({ GITHUB_ACTIONS: 'true' });
    expect(hosted.stderr).toContain(
      '[heavy-check-slots] hosted CI (GITHUB_ACTIONS=true): code-health-gate runs without a host slot.',
    );
    // Both were admitted and ran the gate, which stops at git here.
    for (const result of [nested, hosted]) {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).not.toContain('FAIL: waited');
    }
  });
});
