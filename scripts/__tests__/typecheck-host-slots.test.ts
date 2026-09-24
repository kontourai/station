import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  acquireTypecheckSlot,
  CORRUPT_RECORD_STALE_MS,
  describeSlotSource,
  holderIsLive,
  isTransientContention,
  ownBirthFingerprint,
  prepareSlotDirectory,
  reclaimStaleSlot,
  resolveSlotCount,
  resolveSlotDirectory,
  SLOT_HELD_ENV,
  slotPath,
  UNVERIFIED_HOLDER_STALE_MS,
} from '../lib/typecheck-host-slots.mjs';
import { compileProject } from '../scripts-typecheck-coverage.mjs';
import { needsSlot, planTscArgs, projectConfigPath } from '../tsc-slot.mjs';
import {
  TYPECHECK_LANES,
  typecheckConcurrency,
} from '../typecheck-aggregate.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB_URL = pathToFileURL(
  join(REPO_ROOT, 'scripts', 'lib', 'typecheck-host-slots.mjs'),
).href;
const GIB = 1024 ** 3;

const temps: string[] = [];
const children: ChildProcess[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A pid that certainly belonged to a process which has exited. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', ''], {
    windowsHide: true,
  });
  expect(result.status).toBe(0);
  return result.pid as number;
}

function writeRecord(dir: string, index: number, record: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(slotPath(dir, index), `${JSON.stringify(record)}\n`);
}

const noEnv = {} as NodeJS.ProcessEnv;

describe('resolveSlotCount', () => {
  test('defaults to one slot per 8 GiB, rounded, between 1 and 4', () => {
    // A hosted "16 GB" runner reports ~15.6 GiB. Flooring gave it 1 slot
    // and serialized CI's typecheck lane; it must get 2.
    expect(resolveSlotCount({ env: noEnv, totalmem: 15.6 * GIB })).toBe(2);
    expect(resolveSlotCount({ env: noEnv, totalmem: 8 * GIB })).toBe(1);
    expect(resolveSlotCount({ env: noEnv, totalmem: 48 * GIB })).toBe(4);
    expect(resolveSlotCount({ env: noEnv, totalmem: 11 * GIB })).toBe(1);
    expect(resolveSlotCount({ env: noEnv, totalmem: 4 * GIB })).toBe(1);
    expect(resolveSlotCount({ env: noEnv, totalmem: 512 * GIB })).toBe(4);
  });

  test('the aggregate log names the resolved count and where it came from', () => {
    expect(describeSlotSource({ env: noEnv, totalmem: 15.6 * GIB })).toBe(
      '15.6 GiB RAM, one per 8 GiB rounded, max 4',
    );
    expect(describeSlotSource({ env: { STATION_TYPECHECK_SLOTS: '3' } })).toBe(
      'STATION_TYPECHECK_SLOTS=3',
    );
  });

  test('honours a valid override and refuses an invalid one', () => {
    expect(
      resolveSlotCount({
        env: { STATION_TYPECHECK_SLOTS: '7' },
        totalmem: 4 * GIB,
      }),
    ).toBe(7);
    for (const bad of ['0', '-1', '2.5', 'four', '65'])
      expect(() =>
        resolveSlotCount({
          env: { STATION_TYPECHECK_SLOTS: bad },
          totalmem: 48 * GIB,
        }),
      ).toThrow(/STATION_TYPECHECK_SLOTS/);
  });
});

describe('slot directory', () => {
  test('on POSIX it is a fixed uid-scoped /tmp path, whatever TMPDIR says', () => {
    // Every caller must resolve the SAME directory: a sandbox or sudo with
    // its own TMPDIR would otherwise form a second pool with its own N.
    for (const tmp of [
      '/var/folders/xy/T',
      '/tmp/codex-sandbox',
      '/run/private',
    ])
      expect(
        resolveSlotDirectory({
          env: { TMPDIR: tmp },
          platform: 'darwin',
          uid: 501,
          tmpdir: tmp,
        }),
      ).toBe('/tmp/station-typecheck-slots-501');
    expect(
      resolveSlotDirectory({ env: noEnv, platform: 'linux', uid: 1001 }),
    ).toBe('/tmp/station-typecheck-slots-1001');
  });

  test('Windows uses its per-user temp dir, and the override wins everywhere', () => {
    expect(
      resolveSlotDirectory({
        env: noEnv,
        platform: 'win32',
        tmpdir: 'C:\\Users\\u\\AppData\\Local\\Temp',
      }),
    ).toBe(
      join('C:\\Users\\u\\AppData\\Local\\Temp', 'station-typecheck-slots'),
    );
    for (const platform of ['darwin', 'win32'])
      expect(
        resolveSlotDirectory({
          env: { STATION_TYPECHECK_SLOT_DIR: '/shared/slots' },
          platform,
          uid: 501,
        }),
      ).toBe('/shared/slots');
  });

  test.skipIf(process.platform === 'win32')(
    'is created private, tightened if loose, and refused when owned by another user or a symlink',
    () => {
      const uid = process.getuid?.() as number;
      const parent = tempDir('tc-slots-dir-');
      const dir = join(parent, 'slots');
      prepareSlotDirectory(dir, { platform: 'darwin', uid });
      expect(statSync(dir).mode & 0o777).toBe(0o700);

      const loose = join(parent, 'loose');
      mkdirSync(loose, { mode: 0o777 });
      prepareSlotDirectory(loose, { platform: 'darwin', uid });
      expect(statSync(loose).mode & 0o077).toBe(0);

      expect(() =>
        prepareSlotDirectory(dir, { platform: 'darwin', uid: uid + 1 }),
      ).toThrow(/owned by uid \d+, not \d+/);

      const link = join(parent, 'link');
      symlinkSync(dir, link, 'dir');
      expect(() =>
        prepareSlotDirectory(link, { platform: 'darwin', uid }),
      ).toThrow(/is not a real directory/);
    },
  );
});

describe('holderIsLive', () => {
  const alive = () => true;
  const dead = () => false;

  test('a dead pid is stale; a live pid with a matching birth is held', () => {
    const record = { pid: 4242, start: 'birth-a', acquiredAt: Date.now() };
    expect(holderIsLive(record, { pidAlive: dead })).toBe(false);
    expect(
      holderIsLive(record, { pidAlive: alive, lookupBirth: () => 'birth-a' }),
    ).toBe(true);
  });

  test('a recycled pid (live, different birth) is stale; an unreadable birth is not proof', () => {
    const record = { pid: 4242, start: 'birth-a', acquiredAt: Date.now() };
    expect(
      holderIsLive(record, { pidAlive: alive, lookupBirth: () => 'birth-b' }),
    ).toBe(false);
    expect(
      holderIsLive(record, { pidAlive: alive, lookupBirth: () => null }),
    ).toBe(true);
  });

  test('a record without a birth is trusted only within the unverified bound', () => {
    const now = Date.now();
    expect(
      holderIsLive(
        { pid: 4242, start: null, acquiredAt: now - 1000 },
        { now, pidAlive: alive },
      ),
    ).toBe(true);
    expect(
      holderIsLive(
        {
          pid: 4242,
          start: null,
          acquiredAt: now - UNVERIFIED_HOLDER_STALE_MS - 1,
        },
        { now, pidAlive: alive },
      ),
    ).toBe(false);
  });

  test('an unverified holder is not trusted past about one bounded wait (61 minutes, a literal)', () => {
    // Pinned to a literal, not the constant: widening the constant must fail
    // here. A recycled pid must not pin a slot longer than a waiter's 45-minute
    // wait plus margin.
    const now = Date.now();
    expect(
      holderIsLive(
        { pid: 4242, start: null, acquiredAt: now - 61 * 60_000 },
        { now, pidAlive: () => true },
      ),
    ).toBe(false);
    expect(
      holderIsLive(
        { pid: 4242, start: null, acquiredAt: now - 50 * 60_000 },
        { now, pidAlive: () => true },
      ),
    ).toBe(true);
  });

  test('Windows records carry no birth fingerprint (no PowerShell per compile)', () => {
    let called = false;
    expect(
      ownBirthFingerprint({
        platform: 'win32',
        lookup: () => {
          called = true;
          return 'x';
        },
      }),
    ).toBeNull();
    expect(called).toBe(false);
  });
});

describe('acquireTypecheckSlot (in-process)', () => {
  test('grants at most N slots, then times out naming the holders', async () => {
    const dir = tempDir('tc-slots-cap-');
    const first = await acquireTypecheckSlot({ env: noEnv, dir, slots: 2 });
    const second = await acquireTypecheckSlot({ env: noEnv, dir, slots: 2 });
    expect(new Set([first.index, second.index])).toEqual(new Set([0, 1]));
    const logs: string[] = [];
    await expect(
      acquireTypecheckSlot({
        env: noEnv,
        dir,
        slots: 2,
        waitMs: 0,
        label: 'third',
        log: (message) => logs.push(message),
      }),
    ).rejects.toThrow(
      new RegExp(
        `^FAIL: waited 0s for a host typecheck slot for third; all 2 are held: pid ${process.pid}`,
      ),
    );
    first.release();
    const third = await acquireTypecheckSlot({
      env: noEnv,
      dir,
      slots: 2,
      waitMs: 0,
    });
    expect(third.index).toBe(first.index);
    second.release();
    third.release();
    expect(readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual(
      [],
    );
  });

  test('reclaims a slot whose holder is dead', async () => {
    const dir = tempDir('tc-slots-dead-');
    writeRecord(dir, 0, {
      pid: deadPid(),
      start: 'long-gone',
      nonce: 'stale',
      acquiredAt: Date.now(),
    });
    const slot = await acquireTypecheckSlot({
      env: noEnv,
      dir,
      slots: 1,
      waitMs: 0,
    });
    expect(slot.index).toBe(0);
    const record = JSON.parse(readFileSync(slotPath(dir, 0), 'utf8'));
    expect(record.pid).toBe(process.pid);
    slot.release();
  });

  test('reclaims a slot whose pid was recycled, and keeps one whose holder is live', async () => {
    const dir = tempDir('tc-slots-reuse-');
    writeRecord(dir, 0, {
      pid: process.pid,
      start: 'an-earlier-process',
      nonce: 'recycled',
      acquiredAt: Date.now(),
    });
    const slot = await acquireTypecheckSlot({
      env: noEnv,
      dir,
      slots: 1,
      waitMs: 0,
      lookupBirth: () => 'this-process',
    });
    expect(slot.index).toBe(0);
    // The same record shape with a MATCHING birth is a live holder.
    await expect(
      acquireTypecheckSlot({
        env: noEnv,
        dir,
        slots: 1,
        waitMs: 0,
        lookupBirth: () =>
          JSON.parse(readFileSync(slotPath(dir, 0), 'utf8')).start,
      }),
    ).rejects.toThrow(/all 1 are held/);
    slot.release();
  });

  test('treats a fresh unparseable record as held and an old one as stale', async () => {
    const dir = tempDir('tc-slots-corrupt-');
    mkdirSync(dir, { recursive: true });
    writeFileSync(slotPath(dir, 0), '{"pid": 12');
    await expect(
      acquireTypecheckSlot({ env: noEnv, dir, slots: 1, waitMs: 0 }),
    ).rejects.toThrow(/all 1 are held/);
    const old = (Date.now() - CORRUPT_RECORD_STALE_MS - 5_000) / 1000;
    utimesSync(slotPath(dir, 0), old, old);
    const slot = await acquireTypecheckSlot({
      env: noEnv,
      dir,
      slots: 1,
      waitMs: 0,
    });
    expect(slot.index).toBe(0);
    slot.release();
  });

  test('a nested acquisition under a held slot does not wait (no self-deadlock at N=1)', async () => {
    const dir = tempDir('tc-slots-nested-');
    const outer = await acquireTypecheckSlot({ env: noEnv, dir, slots: 1 });
    const inner = await acquireTypecheckSlot({
      env: { [SLOT_HELD_ENV]: `${dir}#${outer.index}` },
      dir,
      slots: 1,
      waitMs: 0,
    });
    expect(inner.reentrant).toBe(true);
    inner.release();
    // The nested release must not free the outer holder's slot.
    expect(existsSync(slotPath(dir, outer.index))).toBe(true);
    outer.release();
    expect(existsSync(slotPath(dir, outer.index))).toBe(false);
  });

  test('release removes only its own record', async () => {
    const dir = tempDir('tc-slots-release-');
    const slot = await acquireTypecheckSlot({ env: noEnv, dir, slots: 1 });
    writeRecord(dir, slot.index, {
      pid: process.pid,
      nonce: 'someone-else',
      acquiredAt: Date.now(),
    });
    slot.release();
    expect(
      JSON.parse(readFileSync(slotPath(dir, slot.index), 'utf8')).nonce,
    ).toBe('someone-else');
  });
});

describe('isTransientContention', () => {
  test('Windows sharing violations are contention; the same codes on POSIX are real errors', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      expect(isTransientContention({ code }, 'win32')).toBe(true);
      expect(isTransientContention({ code }, 'darwin')).toBe(false);
      expect(isTransientContention({ code }, 'linux')).toBe(false);
    }
    expect(isTransientContention({ code: 'ENOSPC' }, 'win32')).toBe(false);
  });
});

describe('reclaimStaleSlot', () => {
  test('removes the judged record', () => {
    const dir = tempDir('tc-slots-reclaim-');
    writeRecord(dir, 0, { pid: 1, nonce: 'judged' });
    expect(reclaimStaleSlot(dir, 0, 'judged')).toBe('reclaimed');
    expect(existsSync(slotPath(dir, 0))).toBe(false);
  });

  test('puts back a fresh record that replaced the judged one', () => {
    // Another waiter reclaimed the stale slot and claimed it between this
    // waiter's verdict and its removal; removing it would admit N+1.
    const dir = tempDir('tc-slots-restore-');
    writeRecord(dir, 0, { pid: process.pid, nonce: 'fresh-holder' });
    expect(reclaimStaleSlot(dir, 0, 'judged')).toBe('restored');
    expect(JSON.parse(readFileSync(slotPath(dir, 0), 'utf8')).nonce).toBe(
      'fresh-holder',
    );
    expect(readdirSync(dir)).toEqual(['slot-0.lock']);
  });

  test('reports an already-removed record as gone', () => {
    const dir = tempDir('tc-slots-gone-');
    expect(reclaimStaleSlot(dir, 0, 'judged')).toBe('gone');
  });
});

/**
 * A stand-in compiler: takes (or, for the control, skips) a slot, marks
 * itself active, holds until it either sees more than N active peers or its
 * hold time passes, then records the peak it saw and exits.
 */
const FAKE_CHILD = `
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { acquireTypecheckSlot } = await import(process.env.SLOT_LIB_URL);
const [mode, logDir, slotsText, holdText, action] = process.argv.slice(2);
const slots = Number(slotsText);
const id = String(process.pid);
if (mode === 'slotted') {
  const slot = await acquireTypecheckSlot({ slots, pollMs: 40, waitMs: 120000, label: id });
  process.once('exit', slot.release);
}
const active = join(logDir, 'active-' + id);
writeFileSync(active, '');
if (action === 'hold-forever') {
  process.stdout.write('HELD\\n');
  setInterval(() => {}, 1000);
} else if (action === 'exit') {
  process.exit(3);
} else {
  const deadline = Date.now() + Number(holdText);
  let peak = 0;
  while (Date.now() < deadline) {
    const count = readdirSync(logDir).filter((n) => n.startsWith('active-')).length;
    peak = Math.max(peak, count);
    if (count > slots) break;
    await new Promise((r) => setTimeout(r, 15));
  }
  rmSync(active);
  writeFileSync(join(logDir, 'peak-' + id), String(peak));
}
`;

function fakeChildScript(): string {
  const dir = tempDir('tc-slots-fake-');
  const path = join(dir, 'fake-tsc.mjs');
  writeFileSync(path, FAKE_CHILD);
  return path;
}

function startFake(
  script: string,
  slotDir: string,
  args: string[],
): ChildProcess {
  const child = spawn(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      SLOT_LIB_URL: LIB_URL,
      STATION_TYPECHECK_SLOT_DIR: slotDir,
      [SLOT_HELD_ENV]: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolveExit(code));
  });
}

async function runFleet(mode: 'slotted' | 'unslotted', holdMs: number) {
  const script = fakeChildScript();
  const slotDir = tempDir('tc-slots-fleet-');
  const logDir = tempDir('tc-slots-log-');
  const slots = 2;
  const fleet = Array.from({ length: 6 }, () =>
    startFake(script, slotDir, [mode, logDir, String(slots), String(holdMs)]),
  );
  const codes = await Promise.all(fleet.map(exited));
  const peaks = readdirSync(logDir)
    .filter((name) => name.startsWith('peak-'))
    .map((name) => Number(readFileSync(join(logDir, name), 'utf8')));
  return { slots, codes, peaks, slotDir };
}

describe('host-wide cap across processes', { timeout: 90_000 }, () => {
  test('six slotted compilers never exceed two slots, and all finish', async () => {
    const { slots, codes, peaks, slotDir } = await runFleet('slotted', 400);
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(peaks).toHaveLength(6);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(slots);
    expect(readdirSync(slotDir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });

  test('known-bad control: the same fleet without slots exceeds two', async () => {
    // Proves the measurement above can see over-admission: with the slot
    // acquisition removed and nothing else changed, peers overlap.
    const { slots, codes, peaks } = await runFleet('unslotted', 15_000);
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Math.max(...peaks)).toBeGreaterThan(slots);
  });

  test('a killed holder releases its slot to the next waiter', async () => {
    const script = fakeChildScript();
    const slotDir = tempDir('tc-slots-kill-');
    const logDir = tempDir('tc-slots-kill-log-');
    const holder = startFake(script, slotDir, [
      'slotted',
      logDir,
      '1',
      '0',
      'hold-forever',
    ]);
    await new Promise<void>((resolveHeld, rejectHeld) => {
      holder.stdout?.on('data', (chunk) => {
        if (String(chunk).includes('HELD')) resolveHeld();
      });
      holder.once('exit', () => rejectHeld(new Error('holder exited early')));
    });
    // With the holder alive, the only slot is taken.
    await expect(
      acquireTypecheckSlot({ env: noEnv, dir: slotDir, slots: 1, waitMs: 0 }),
    ).rejects.toThrow(/all 1 are held/);
    holder.kill('SIGKILL');
    await exited(holder);
    // SIGKILL runs no exit hook: the record is still on disk, and the waiter
    // must reclaim it from the dead pid.
    expect(existsSync(slotPath(slotDir, 0))).toBe(true);
    const slot = await acquireTypecheckSlot({
      env: noEnv,
      dir: slotDir,
      slots: 1,
      waitMs: 10_000,
      pollMs: 50,
    });
    expect(slot.index).toBe(0);
    slot.release();
  });

  test('process.exit releases the slot through the exit hook', async () => {
    const script = fakeChildScript();
    const slotDir = tempDir('tc-slots-exit-');
    const logDir = tempDir('tc-slots-exit-log-');
    const child = startFake(script, slotDir, [
      'slotted',
      logDir,
      '1',
      '0',
      'exit',
    ]);
    expect(await exited(child)).toBe(3);
    expect(existsSync(slotPath(slotDir, 0))).toBe(false);
  });
});

describe('tsc-slot runner', () => {
  test('adds incremental flags with a per-project build info file', () => {
    const env = { STATION_TSBUILDINFO_DIR: '/cache' } as NodeJS.ProcessEnv;
    const plan = planTscArgs(
      ['-p', 'packages/shared/tsconfig.json', '--noEmit'],
      {
        cwd: REPO_ROOT,
        env,
        repoRoot: REPO_ROOT,
      },
    );
    expect(plan.args.slice(0, 3)).toEqual([
      '-p',
      'packages/shared/tsconfig.json',
      '--noEmit',
    ]);
    expect(plan.args.slice(3)).toEqual([
      '--incremental',
      '--tsBuildInfoFile',
      join('/cache', 'packages__shared__tsconfig.json.tsbuildinfo'),
    ]);
  });

  test('leaves caller-chosen incremental settings, non-compile modes and the opt-out alone', () => {
    for (const args of [
      ['-p', 'x.json', '--incremental'],
      ['-p', 'x.json', '--tsBuildInfoFile', 'y'],
      ['--build'],
      ['-b', 'x.json'],
      ['--watch'],
      ['--version'],
    ])
      expect(planTscArgs(args, { cwd: REPO_ROOT, env: noEnv }).args).toEqual(
        args,
      );
    expect(
      planTscArgs(['-p', 'x.json'], {
        cwd: REPO_ROOT,
        env: { STATION_TYPECHECK_INCREMENTAL: '0' },
      }).args,
    ).toEqual(['-p', 'x.json']);
  });

  test('a bare invocation targets ./tsconfig.json, and a directory resolves to its tsconfig', () => {
    expect(projectConfigPath(['--noEmit'], REPO_ROOT)).toBe(
      join(REPO_ROOT, 'tsconfig.json'),
    );
    expect(projectConfigPath(['-p', 'packages/shared'], REPO_ROOT)).toBe(
      join(REPO_ROOT, 'packages', 'shared', 'tsconfig.json'),
    );
    expect(projectConfigPath(['--project=tsconfig.e2e.json'], REPO_ROOT)).toBe(
      join(REPO_ROOT, 'tsconfig.e2e.json'),
    );
  });

  test('every typecheck lane compiles through the runner, and no two projects share build info', () => {
    const root = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    );
    const buildInfo: string[] = [];
    for (const lane of TYPECHECK_LANES) {
      const command: string = root.scripts[lane.script];
      expect(command, lane.script).toBeTypeOf('string');
      if (lane.script === 'typecheck:scripts') {
        expect(command).toBe('node scripts/scripts-typecheck-coverage.mjs');
        continue;
      }
      for (const segment of command.split(' && ')) {
        // A bare `tsc` here would run outside the host cap.
        expect(segment, lane.script).toMatch(/^node scripts\/tsc-slot\.mjs /);
        const args = segment.split(/\s+/).slice(2);
        const plan = planTscArgs(args, {
          cwd: REPO_ROOT,
          env: noEnv,
          repoRoot: REPO_ROOT,
        });
        expect(plan.buildInfoFile, segment).not.toBeNull();
        buildInfo.push(plan.buildInfoFile as string);
      }
    }
    // The single-project lanes (typecheck:server was removed as a strict
    // subset of typecheck:server-tests) + typecheck:examples' seventeen
    // projects (every example with TypeScript sources, station#2343).
    expect(buildInfo).toHaveLength(27);
    expect(new Set(buildInfo).size).toBe(buildInfo.length);
  });

  test('the scripts coverage gate compiles through the runner too', () => {
    const calls: string[][] = [];
    compileProject(REPO_ROOT, {
      run: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0, stdout: '', stderr: '' };
      },
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(join(REPO_ROOT, 'scripts', 'tsc-slot.mjs'));
    expect(calls[0].slice(2)).toEqual([
      '-p',
      'tsconfig.scripts.json',
      '--noEmit',
      '--listFiles',
    ]);
  });

  test('the typecheck aggregate never runs more lanes at once than there are slots', () => {
    expect(
      typecheckConcurrency({ env: { STATION_TYPECHECK_SLOTS: '1' } }),
    ).toBe(1);
    expect(
      typecheckConcurrency({
        env: { STATION_TYPECHECK_SLOTS: '2' },
        concurrency: 4,
      }),
    ).toBe(2);
    expect(
      typecheckConcurrency({
        env: { STATION_TYPECHECK_SLOTS: '4' },
        concurrency: 3,
      }),
    ).toBe(3);
  });

  test('watch, help, version and other non-compiling modes take no slot', () => {
    for (const args of [
      ['--watch', '-p', 'x.json'],
      ['-w'],
      ['--help'],
      ['-h'],
      ['--version'],
      ['-v'],
      ['--init'],
      ['--showConfig', '-p', 'x.json'],
    ])
      expect(needsSlot(args), args.join(' ')).toBe(false);
    for (const args of [
      ['-p', 'x.json', '--noEmit'],
      ['--build', 'x.json'],
      ['--noEmit', '--listFiles'],
    ])
      expect(needsSlot(args), args.join(' ')).toBe(true);
  });

  test('`--version` runs even while every slot is held', {
    timeout: 60_000,
  }, () => {
    const slotDir = tempDir('tc-slots-version-');
    writeRecord(slotDir, 0, {
      pid: process.pid,
      start: null,
      nonce: 'the-test-process',
      acquiredAt: Date.now(),
    });
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'tsc-slot.mjs'), '--version'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          STATION_TYPECHECK_SLOT_DIR: slotDir,
          STATION_TYPECHECK_SLOTS: '1',
          STATION_TYPECHECK_SLOT_WAIT_MS: '0',
          [SLOT_HELD_ENV]: '',
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Version \d+\.\d+\.\d+/);
    expect(result.stderr).not.toMatch(/typecheck slot/);
  });

  test('the runner does not start the compiler while every slot is held', {
    timeout: 60_000,
  }, () => {
    // Without this, a runner that skipped acquisition would pass every other
    // runner test: they only look at what it compiled.
    const project = tempDir('tc-slots-held-project-');
    const slotDir = tempDir('tc-slots-held-');
    const cache = tempDir('tc-slots-held-cache-');
    writeFileSync(
      join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] },
        files: ['a.ts'],
      }),
    );
    writeFileSync(join(project, 'a.ts'), 'export const a: number = "x";\n');
    writeRecord(slotDir, 0, {
      pid: process.pid,
      start: null,
      nonce: 'the-test-process',
      acquiredAt: Date.now(),
    });
    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'tsc-slot.mjs'),
        '-p',
        join(project, 'tsconfig.json'),
      ],
      {
        cwd: project,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          STATION_TSBUILDINFO_DIR: cache,
          STATION_TYPECHECK_SLOT_DIR: slotDir,
          STATION_TYPECHECK_SLOTS: '1',
          STATION_TYPECHECK_SLOT_WAIT_MS: '0',
          [SLOT_HELD_ENV]: '',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      new RegExp(
        `^FAIL: waited 0s for a host typecheck slot for .*all 1 are held: pid ${process.pid}`,
        'm',
      ),
    );
    // The compiler never ran: no diagnostic for the ill-typed file, and no
    // build info written.
    expect(result.stdout).not.toMatch(/error TS/);
    expect(readdirSync(cache)).toEqual([]);
    // The held record is untouched.
    expect(JSON.parse(readFileSync(slotPath(slotDir, 0), 'utf8')).nonce).toBe(
      'the-test-process',
    );
  });

  test('a warm incremental run still reports an unchanged type error, and releases its slot', {
    timeout: 90_000,
  }, () => {
    const project = tempDir('tc-slots-project-');
    const cache = tempDir('tc-slots-cache-');
    const slotDir = tempDir('tc-slots-runner-');
    writeFileSync(
      join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [] },
        files: ['a.ts', 'b.ts'],
      }),
    );
    writeFileSync(
      join(project, 'a.ts'),
      'export function f(x: number): number { return x; }\n',
    );
    writeFileSync(
      join(project, 'b.ts'),
      "import { f } from './a';\nexport const y: number = f(1);\n",
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts', 'tsc-slot.mjs'),
          '-p',
          join(project, 'tsconfig.json'),
        ],
        {
          cwd: project,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            STATION_TSBUILDINFO_DIR: cache,
            STATION_TYPECHECK_SLOT_DIR: slotDir,
            STATION_TYPECHECK_SLOTS: '1',
            [SLOT_HELD_ENV]: '',
          },
        },
      );

    const clean = run();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    const infos = readdirSync(cache);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/^external-[0-9a-f]{16}\.tsbuildinfo$/);

    // Change a.ts's signature: the error is in b.ts, which did not change,
    // so only a correct incremental graph can find it.
    writeFileSync(
      join(project, 'a.ts'),
      'export function f(x: number): string { return String(x); }\n',
    );
    const broken = run();
    expect(broken.status).not.toBe(0);
    expect(broken.stdout).toMatch(/b\.ts\(2,14\): error TS2322/);

    // Nothing changed since the failing run: the warm run must replay the
    // stored diagnostic rather than report clean.
    const again = run();
    expect(again.status).not.toBe(0);
    expect(again.stdout).toMatch(/b\.ts\(2,14\): error TS2322/);

    expect(readdirSync(slotDir).filter((n) => n.endsWith('.lock'))).toEqual([]);
  });
});
