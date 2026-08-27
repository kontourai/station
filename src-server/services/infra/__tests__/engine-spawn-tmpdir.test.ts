import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  engineSpawnTmpDirPath,
  ensureEngineSpawnTmpDir,
  reapEngineSpawnTmpDir,
} from '../engine-spawn-tmpdir.js';

describe('engine-spawn-tmpdir (station#1908)', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'station-engine-tmp-home-'));
    scratchDirs.push(home);
    return home;
  }

  test('engineSpawnTmpDirPath is a fixed tmp/engine-spawn dir under the given home', () => {
    const home = makeHome();
    expect(engineSpawnTmpDirPath(home)).toBe(join(home, 'tmp', 'engine-spawn'));
  });

  test('ensureEngineSpawnTmpDir creates the directory and is idempotent', () => {
    const home = makeHome();
    const dir = ensureEngineSpawnTmpDir(home);
    expect(dir).toBe(join(home, 'tmp', 'engine-spawn'));
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);

    // Calling again on an already-created dir must not throw.
    expect(() => ensureEngineSpawnTmpDir(home)).not.toThrow();
  });

  test('reapEngineSpawnTmpDir deletes only entries at or past maxAgeMs, keeping fresher ones', () => {
    const home = makeHome();
    const dir = ensureEngineSpawnTmpDir(home);

    const oldFile = join(dir, '.3af87ffefe1fdffa-00000000.so');
    const freshFile = join(dir, '.9911aa22bb33cc44-00000000.so');
    writeFileSync(oldFile, Buffer.alloc(1024));
    writeFileSync(freshFile, Buffer.alloc(1024));

    const now = Date.now();
    const tenMinutesMs = 10 * 60_000;
    // Backdate only the "old" file's mtime -- reproduces the exact leak
    // pattern from station#1908 (orphaned, unmapped, never reclaimed
    // extracted `.so` files sitting for hours).
    const oldStat = statSync(oldFile);
    utimesSync(oldFile, oldStat.atime, new Date(now - tenMinutesMs - 1));

    const reaped = reapEngineSpawnTmpDir(dir, tenMinutesMs, now);

    expect(reaped).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    // The root directory itself persists for reuse by the next spawn.
    expect(existsSync(dir)).toBe(true);
  });

  test('reapEngineSpawnTmpDir on a missing directory is a safe no-op', () => {
    const home = makeHome();
    const dir = engineSpawnTmpDirPath(home);
    expect(existsSync(dir)).toBe(false);
    expect(reapEngineSpawnTmpDir(dir, 60_000)).toBe(0);
  });
});
