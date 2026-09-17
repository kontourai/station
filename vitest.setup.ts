import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stationTempRoot } from '@kontourai/station-shared/temp-dir';
import { installNodeHttpCompatibility } from './packages/shared/src/node-http-compat.mjs';
import { enableFixtureSqliteSynchronousOffForTest } from './src-server/utils/sqlite-fixture-durability.js';

installNodeHttpCompatibility();

/**
 * Testing Library's `waitFor` / `findBy*` give up after 1,000 ms by default.
 * That figure is a latency assertion nobody wrote, in the same class as the
 * inherited 5 s `testTimeout` the config below replaced (#1531): a jsdom suite
 * that mounts a real provider tree and awaits a lazy chunk can exceed one
 * second on a loaded runner while being entirely correct, and the corpus has
 * 261 files that wait this way. The wait now scales with the test budget --
 * a genuine hang still fails inside `testTimeout`, just not in the time it
 * takes a busy machine to do real work.
 *
 * Only under jsdom: the DOM package is not loaded for node-environment
 * suites, and importing it there would drag a DOM into every server worker.
 * Negative waits (`expect(findBy…).rejects`) pass their own shorter timeout
 * already; the ones that did not would become slower, not wrong, and the
 * corpus has none (grep'd at the time of writing).
 */
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/dom');
  configure({ asyncUtilTimeout: 10_000 });
}

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
// src-server/utils/sqlite-fixture-durability.ts, applied by sqlite-wal.ts).
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
