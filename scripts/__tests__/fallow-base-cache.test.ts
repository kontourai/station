import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  FALLOW_BASE_CACHE_PREFIX,
  prepareFallowRun,
  pruneFallowBaseCaches,
} from '../lib/fallow-base-cache.mjs';
import { runFallowAnalysis } from '../run-fallow-audit.mjs';

/**
 * #2529: `fallow audit` leaves a full base checkout in its temp directory per
 * base commit. The audit runs with that directory inside the Station temp
 * root; each run records the bases it may use and prunes the rest.
 */

const makeTempDir = trackTempDirs();
let scratch: string;
const saved = {
  STATION_TEMP_ROOT: process.env.STATION_TEMP_ROOT,
  TMPDIR: process.env.TMPDIR,
  FALLOW_AUDIT_BASE: process.env.FALLOW_AUDIT_BASE,
};

beforeEach(() => {
  scratch = makeTempDir('fallow-base-cache-');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const cachesIn = (directory: string) =>
  existsSync(directory)
    ? readdirSync(directory).filter(
        (name) =>
          name.startsWith(FALLOW_BASE_CACHE_PREFIX) && !name.includes('.'),
      )
    : [];

const runMarkers = (directory: string) =>
  existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith('run-'))
    : [];

function gitRepo(): { repo: string; head: string } {
  const repo = join(scratch, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@station.dev');
  git('config', 'user.name', 'Station Test');
  writeFileSync(
    join(repo, 'package.json'),
    '{"name":"mini","type":"module"}\n',
  );
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return { repo, head: git('rev-parse', 'HEAD') };
}

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid as number;
}

describe('fallow audit base snapshots (#2529)', () => {
  test('the real audit writes its base snapshot under the Station temp root, records its base while running, and clears its marker', async () => {
    const { repo, head } = gitRepo();
    // A change against the base, so the audit needs a base snapshot.
    writeFileSync(
      join(repo, 'a.ts'),
      'export const a = 2;\nexport const b = 3;\n',
    );

    const stationRoot = join(scratch, 'station-root');
    const systemTemp = join(scratch, 'system-temp');
    mkdirSync(systemTemp);
    process.env.STATION_TEMP_ROOT = stationRoot;
    process.env.TMPDIR = systemTemp;
    process.env.FALLOW_AUDIT_BASE = 'HEAD';

    await runFallowAnalysis(repo, 'audit', join(scratch, 'audit.json'));

    const fallowDir = join(stationRoot, 'fallow');
    const [cache] = cachesIn(fallowDir);
    expect(cachesIn(fallowDir)).toHaveLength(1);
    expect(cachesIn(systemTemp)).toEqual([]);
    // fallow's own .sha names the base the run recorded in its marker.
    expect(readFileSync(join(fallowDir, `${cache}.sha`), 'utf8').trim()).toBe(
      head,
    );
    expect(runMarkers(fallowDir)).toEqual([]);
  }, 60_000);

  const makeCache = (name: string, createdAt: number, sha?: string) => {
    const base = join(scratch, `${FALLOW_BASE_CACHE_PREFIX}${name}`);
    mkdirSync(join(base, 'src'), { recursive: true });
    writeFileSync(join(base, 'src', 'a.ts'), 'export {};\n');
    writeFileSync(`${base}.lock`, '');
    if (sha !== undefined) {
      writeFileSync(`${base}.last-used`, '');
      writeFileSync(`${base}.sha`, `${sha}\n`);
    }
    const seconds = createdAt / 1000;
    for (const path of [base, `${base}.lock`, `${base}.last-used`])
      if (existsSync(path)) utimesSync(path, seconds, seconds);
    return base;
  };

  const now = Date.UTC(2026, 8, 24, 12);
  const hour = 60 * 60 * 1000;

  test('keeps the most recent caches and removes the rest with their sidecars', () => {
    const bases = [1, 2, 3, 4, 5, 6].map((age) =>
      makeCache(`age-${age}h`, now - age * hour, `sha-${age}`),
    );

    const removed = pruneFallowBaseCaches(scratch, { now, keep: 4 });

    expect(removed.sort()).toEqual([
      `${FALLOW_BASE_CACHE_PREFIX}age-5h`,
      `${FALLOW_BASE_CACHE_PREFIX}age-6h`,
    ]);
    for (const base of bases.slice(0, 4)) expect(existsSync(base)).toBe(true);
    for (const base of bases.slice(4)) {
      expect(existsSync(base)).toBe(false);
      for (const suffix of ['.last-used', '.lock', '.sha'])
        expect(existsSync(`${base}${suffix}`)).toBe(false);
    }
  });

  test("a live run's recorded base is never removed, whatever its rank or age", () => {
    for (const age of [1, 2, 3, 4])
      makeCache(`age-${age}h`, now - age * hour, `sha-${age}`);
    // fallow never refreshes a reused cache's stamps, so an old cache can be
    // in use: only the run's marker says so.
    const reused = makeCache('reused', now - 48 * hour, 'sha-reused');
    writeFileSync(
      join(scratch, `run-${process.pid}-live.json`),
      JSON.stringify({ pid: process.pid, bases: ['sha-reused'] }),
    );

    expect(pruneFallowBaseCaches(scratch, { now, keep: 4 })).toEqual([]);
    expect(existsSync(reused)).toBe(true);
  });

  test("a dead run's marker is cleared and protects nothing", () => {
    for (const age of [1, 2, 3, 4])
      makeCache(`age-${age}h`, now - age * hour, `sha-${age}`);
    const orphan = makeCache('orphan', now - 48 * hour, 'sha-orphan');
    const pid = deadPid();
    const marker = join(scratch, `run-${pid}-dead.json`);
    writeFileSync(marker, JSON.stringify({ pid, bases: ['sha-orphan'] }));

    pruneFallowBaseCaches(scratch, { now, keep: 4 });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
  });

  test('a cache still being created is kept; an abandoned one is not', () => {
    for (const age of [1, 2, 3, 4])
      makeCache(`age-${age}h`, now - age * hour, `sha-${age}`);
    const creating = makeCache('creating', now - 5 * hour, undefined);
    // Its lock was written a minute ago: fallow is materialising it now.
    const lockSeconds = (now - 60 * 1000) / 1000;
    utimesSync(`${creating}.lock`, lockSeconds, lockSeconds);
    utimesSync(creating, (now - 5 * hour) / 1000, (now - 5 * hour) / 1000);
    const abandoned = makeCache('abandoned', now - 6 * hour, undefined);

    // Ranked by its fresh lock, the creating cache is first; push it out of
    // the kept ranks so only the creation rule can keep it.
    const removed = pruneFallowBaseCaches(scratch, { now, keep: 0 });
    expect(existsSync(creating)).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
    expect(removed).toContain(`${FALLOW_BASE_CACHE_PREFIX}abandoned`);
  });

  test('one prune removes at most its cap; the backlog drains on later runs', () => {
    for (const age of [1, 2, 3, 4, 5, 6, 7, 8])
      makeCache(`age-${age}h`, now - age * hour, `sha-${age}`);
    expect(
      pruneFallowBaseCaches(scratch, { now, keep: 2, maxRemovals: 3 }),
    ).toHaveLength(3);
    expect(cachesIn(scratch)).toHaveLength(5);
  });

  test('a run waits out a live prune lock and does not prune under it; a dead holder is broken', () => {
    const { repo } = gitRepo();
    process.env.STATION_TEMP_ROOT = join(scratch, 'station-root');
    const fallowDir = join(scratch, 'station-root', 'fallow');
    mkdirSync(join(fallowDir, 'prune.lock'), { recursive: true });
    writeFileSync(join(fallowDir, 'prune.lock', 'pid'), String(process.pid));
    const stale = join(fallowDir, `${FALLOW_BASE_CACHE_PREFIX}stale`);
    mkdirSync(stale);
    writeFileSync(`${stale}.sha`, 'sha-stale\n');
    const old = (Date.now() - 48 * hour) / 1000;
    for (const [i, name] of ['a', 'b', 'c', 'd'].entries()) {
      const fresh = join(fallowDir, `${FALLOW_BASE_CACHE_PREFIX}${name}`);
      mkdirSync(fresh);
      writeFileSync(`${fresh}.sha`, `sha-${name}\n`);
      utimesSync(fresh, Date.now() / 1000 - i, Date.now() / 1000 - i);
    }
    utimesSync(stale, old, old);
    utimesSync(`${stale}.sha`, old, old);

    // A live holder (this process): the run gives up waiting and does not prune.
    const held = prepareFallowRun(repo, process.env, { lockWaitMs: 300 });
    expect(existsSync(stale)).toBe(true);
    held.release();

    // A dead holder: the lock is broken and the prune runs.
    writeFileSync(join(fallowDir, 'prune.lock', 'pid'), String(deadPid()));
    const run = prepareFallowRun(repo, process.env, { lockWaitMs: 300 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(fallowDir, 'prune.lock'))).toBe(false);
    expect(runMarkers(fallowDir)).toHaveLength(1);
    run.release();
    expect(runMarkers(fallowDir)).toEqual([]);
  });
});
