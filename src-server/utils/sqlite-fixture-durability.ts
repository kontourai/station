/**
 * Fixture-only durability relaxation for SQLite stores, switched on
 * in-process and nowhere else.
 *
 * `applyWalJournalMode` (sqlite-wal.ts) applies `PRAGMA synchronous = OFF`
 * to every connection it converts to WAL while this switch is on. OFF skips
 * the fsync a WAL store otherwise pays on every commit. SQLite documents it
 * as safe against an application crash -- a killed process still finds every
 * committed transaction on reopen -- and unsafe only against an
 * operating-system crash or power loss, which is the one failure a throwaway
 * test fixture never has to survive.
 *
 * The switch is a module-level flag that only
 * `enableFixtureSqliteSynchronousOffForTest` sets; `vitest.setup.ts` calls it
 * in every Vitest worker. It is deliberately not an environment variable: an
 * inherited variable would reach any Station started from that shell (the
 * desktop sidecar and service units pass the environment through), and it
 * would also reach the child processes tests spawn, whose stores should keep
 * production durability because they are the production code under test. A
 * module flag cannot cross a process boundary, so a shipped Station -- and
 * every spawned child -- keeps SQLite's own default (FULL under WAL).
 *
 * This module has no imports so that `vitest.setup.ts` can flip the switch
 * without pulling the logger or anything else into every worker's module
 * graph before the first test file loads.
 *
 * Measured on the orchestration EventStore (Apple M-series, APFS):
 * construct+ledger+close 32-40ms -> 19-23ms, appends 0.15-0.25ms/row ->
 * 0.09ms/row. Fifty-five test files build a store per case.
 */
let fixtureSynchronousOff = false;

export function enableFixtureSqliteSynchronousOffForTest(): void {
  fixtureSynchronousOff = true;
}

export function resetFixtureSqliteSynchronousForTest(): void {
  fixtureSynchronousOff = false;
}

/** Current switch position; lets a test prove the worker setup flipped it. */
export function fixtureSqliteSynchronousOffForTest(): boolean {
  return fixtureSynchronousOff;
}
