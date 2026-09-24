import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  FALLOW_BASE_CACHE_PREFIX,
  pruneFallowBaseCaches,
} from '../lib/fallow-base-cache.mjs';
import { runFallowAnalysis } from '../run-fallow-audit.mjs';

/**
 * #2529: `fallow audit` leaves a full base checkout in its temp directory per
 * base commit. The audit runs with that directory inside the Station temp
 * root, and each run prunes it to the most recently used caches.
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

describe('fallow audit base snapshots (#2529)', () => {
  test('the real audit writes its base snapshot under the Station temp root, not the system temp directory', async () => {
    const repo = join(scratch, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
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

    expect(cachesIn(join(stationRoot, 'fallow'))).toHaveLength(1);
    expect(cachesIn(systemTemp)).toEqual([]);
  }, 60_000);

  const makeCache = (directory: string, name: string, usedAt: number) => {
    const base = join(directory, `${FALLOW_BASE_CACHE_PREFIX}${name}`);
    mkdirSync(join(base, 'src'), { recursive: true });
    writeFileSync(join(base, 'src', 'a.ts'), 'export {};\n');
    for (const suffix of ['.last-used', '.lock', '.sha'])
      writeFileSync(`${base}${suffix}`, '');
    const seconds = usedAt / 1000;
    utimesSync(`${base}.last-used`, seconds, seconds);
    utimesSync(`${base}.lock`, seconds, seconds);
    utimesSync(base, seconds, seconds);
    return base;
  };

  test('keeps the most recently used caches and removes the rest with their sidecars', () => {
    const now = Date.UTC(2026, 8, 24, 12);
    const hour = 60 * 60 * 1000;
    const bases = [1, 2, 3, 4, 5, 6].map((age) =>
      makeCache(scratch, `age-${age}h`, now - age * hour),
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

  test('never removes a cache used within the in-use window, whatever its rank', () => {
    const now = Date.UTC(2026, 8, 24, 12);
    const minute = 60 * 1000;
    const bases = [1, 2, 3, 4, 5, 6].map((age) =>
      makeCache(scratch, `age-${age}m`, now - age * minute),
    );

    expect(pruneFallowBaseCaches(scratch, { now, keep: 4 })).toEqual([]);
    for (const base of bases) expect(existsSync(base)).toBe(true);
  });

  test("a cache's lock counts as use even when its last-used stamp is old", () => {
    const now = Date.UTC(2026, 8, 24, 12);
    const minute = 60 * 1000;
    // Four caches used more recently than the lock, so rank alone would not
    // keep the locked one: only counting its lock as use does.
    for (const age of [2, 3, 4, 5])
      makeCache(scratch, `recent-${age}m`, now - age * minute);
    const locked = makeCache(scratch, 'locked', now - 10 * 60 * minute);
    const lockSeconds = (now - 10 * minute) / 1000;
    utimesSync(`${locked}.lock`, lockSeconds, lockSeconds);

    expect(pruneFallowBaseCaches(scratch, { now, keep: 4 })).toEqual([]);
    expect(existsSync(locked)).toBe(true);
  });
});
