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
  prepareFallowRun,
  removeAbandonedFallowRuns,
} from '../lib/fallow-base-cache.mjs';
import { runFallowAnalysis } from '../run-fallow-audit.mjs';

/**
 * #2529: `fallow audit` leaves a full base checkout in its temp directory per
 * base commit and never removes it. Each run gets a private temp directory
 * under the Station temp root, removed when the run ends.
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

const listing = (directory: string) =>
  existsSync(directory) ? readdirSync(directory) : [];

describe('fallow audit base snapshots (#2529)', () => {
  test('the real audit builds its base checkout in a private run directory and removes it when the run ends', async () => {
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
    // A change against the base, so the audit needs a base checkout.
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

    // Watch the run directory while fallow runs: the checkout must be built
    // there, not merely be absent everywhere.
    const seen = new Set<string>();
    const watcher = setInterval(() => {
      for (const run of listing(join(stationRoot, 'fallow')))
        for (const entry of listing(join(stationRoot, 'fallow', run)))
          seen.add(entry);
    }, 20);
    try {
      await runFallowAnalysis(repo, 'audit', join(scratch, 'audit.json'));
    } finally {
      clearInterval(watcher);
    }

    expect(
      [...seen].some((entry) => entry.startsWith('fallow-audit-base-cache-')),
    ).toBe(true);
    expect(listing(join(stationRoot, 'fallow'))).toEqual([]);
    expect(listing(systemTemp)).toEqual([]);
  }, 60_000);

  test('a run directory is removed when released, even if fallow left files in it', () => {
    process.env.STATION_TEMP_ROOT = join(scratch, 'station-root');
    const run = prepareFallowRun();
    writeFileSync(join(run.directory, 'fallow-audit-base-cache-x.lock'), '');
    mkdirSync(join(run.directory, 'fallow-audit-base-cache-x', 'src'), {
      recursive: true,
    });
    run.release();
    expect(existsSync(run.directory)).toBe(false);
  });

  test('two concurrent runs get different directories, and releasing one leaves the other', () => {
    process.env.STATION_TEMP_ROOT = join(scratch, 'station-root');
    const first = prepareFallowRun();
    const second = prepareFallowRun();
    expect(first.directory).not.toBe(second.directory);
    first.release();
    expect(existsSync(second.directory)).toBe(true);
    second.release();
  });

  test('a run left behind by a killed audit is removed once it is older than any live run', () => {
    const root = join(scratch, 'fallow');
    const now = Date.UTC(2026, 8, 24, 12);
    const makeRun = (name: string, ageMs: number) => {
      const path = join(root, name);
      mkdirSync(join(path, 'fallow-audit-base-cache-x'), { recursive: true });
      const seconds = (now - ageMs) / 1000;
      utimesSync(path, seconds, seconds);
      return path;
    };
    const abandoned = makeRun('run-abandoned', 2 * 60 * 60 * 1000);
    const live = makeRun('run-live', 90 * 1000);
    const unrelated = join(root, 'not-a-run');
    mkdirSync(unrelated);
    utimesSync(unrelated, 0, 0);

    expect(removeAbandonedFallowRuns(root, { now })).toEqual(['run-abandoned']);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
