import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stationTempRoot } from '@kontourai/station-shared/temp-dir';
import { enableFixtureSqliteSynchronousOffForTest } from './src-server/utils/sqlite-wal.js';

/**
 * Give every test file an isolated Station root and runtime home.
 *
 * `setupFiles` runs once per test file inside a pooled worker, so a
 * `process.on('exit')` cleanup only ever fires when that worker finally exits —
 * and vitest routinely tears workers down with a signal instead. The result was
 * one leaked directory per test file, forever: this machine had accumulated
 * 220,022 of them.
 *
 * The homes now live under a single run-scoped root that `globalSetup`'s
 * teardown removes wholesale from the main vitest process, which does exit
 * cleanly. The per-worker handler stays as best-effort cleanup for the common
 * case.
 *
 * That root must be this run's own, never a path shared with another vitest
 * process — a shared root means a sibling run's teardown deletes these homes
 * mid-test. `globalSetup` supplies a per-process root; the fallback below only
 * applies when this file is loaded without it, and is made unique for the same
 * reason.
 */
const suppliedRunRoot = process.env.STATION_VITEST_RUN_ROOT;
const runRoot =
  suppliedRunRoot ?? join(stationTempRoot(), `vitest-orphan-${process.pid}`);
mkdirSync(runRoot, { recursive: true });

// setupFiles runs for every test file. Always allocate a client root even
// when an individual suite deliberately supplies STATION_HOME: the latter is
// a runtime override and must never route a test to the owner's profiles.
const testRootDir = mkdtempSync(join(runRoot, 'root-'));
process.env.STATION_ROOT = testRootDir;
// Fixture stores in this worker skip per-commit fsync (see
// `enableFixtureSqliteSynchronousOffForTest` in src-server/utils/sqlite-wal.ts).
// An in-process flag, not an environment variable: child processes a test
// spawns keep production durability.
enableFixtureSqliteSynchronousOffForTest();

if (!process.env.STATION_HOME) {
  const testHomeDir = join(testRootDir, 'instances', 'test');
  mkdirSync(testHomeDir, { recursive: true });
  process.env.STATION_HOME = testHomeDir;

  process.on('exit', () => {
    // With `globalSetup` there is a run-level teardown that owns the root, so
    // clean up only this home. Without one (the two example configs reuse this
    // file alone) nothing else will ever remove the root this worker invented,
    // so take the root too. Best-effort either way — as the note above says,
    // vitest often kills workers before this handler runs. What guarantees
    // reclaim is that each root is now a top-level entry under the Station
    // temp root, so the day-old sweep ages it out; the old shared `vitest`
    // directory had its mtime refreshed by every run and never aged out at
    // all, which let anything leaked inside it accumulate indefinitely.
    rmSync(suppliedRunRoot ? testRootDir : runRoot, {
      recursive: true,
      force: true,
    });
  });
}
