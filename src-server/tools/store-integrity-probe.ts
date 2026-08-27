#!/usr/bin/env node
/**
 * store-integrity-probe — a short-lived child process that runs
 * `PRAGMA quick_check` against Station's SQLite stores and prints the verdict
 * as JSON.
 *
 * It exists as a SEPARATE PROCESS because `node:sqlite`'s `DatabaseSync` is
 * synchronous. Running the check in the server would stall the event loop for
 * the whole duration (587 ms cold on a 61 MB store, measured in station#3215)
 * — blocking SSE frames, the terminal WebSocket, and every in-flight turn.
 * Moving that stall from boot to mid-session is not an improvement; moving it
 * off the loop is. There are no `worker_threads` in this repo, so a bundled
 * sidecar under `src-server/tools/` is the established alternative
 * (`self-update-watchdog-runner.ts`, `instance-registry-bridge.ts`).
 *
 * Invoked as: node store-integrity-probe.js <databasePath> [<databasePath>…]
 *
 * Exit codes are `STORE_INTEGRITY_EXIT_CODE`: 0 ok, 1 corrupt, 2 unavailable,
 * 3 usage. `corrupt` and `unavailable` stay distinct because only the first
 * is grounds for touching a user's history.
 *
 * The same entry point is what `station home verify` reports, so an operator
 * and the scheduler read one verdict rather than two that agree today.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  STORE_INTEGRITY_EXIT_CODE,
  type StoreIntegrityReport,
  storeIntegrityExitCode,
  verifySqliteStore,
} from '@kontourai/station-shared/sqlite-store-integrity';

export interface StoreIntegrityProbeDeps {
  verify?: typeof verifySqliteStore;
  now?: () => Date;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

const USAGE = 'Usage: store-integrity-probe <databasePath> [<databasePath>...]';

/**
 * The whole probe body, injectable so it can be unit-tested without a spawn.
 * The process contract it implements — stdout JSON plus an exit code — is
 * proven separately against a real child, because a returned number is not an
 * exit status.
 */
export function runStoreIntegrityProbe(
  argv: readonly string[],
  deps: StoreIntegrityProbeDeps = {},
): number {
  const verify = deps.verify ?? verifySqliteStore;
  const now = deps.now ?? (() => new Date());
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const writeError =
    deps.writeError ?? ((line: string) => process.stderr.write(line));

  const databasePaths = argv.slice(2).filter((value) => value.length > 0);
  if (databasePaths.length === 0) {
    writeError(`${USAGE}\n`);
    return STORE_INTEGRITY_EXIT_CODE.usage;
  }

  const report: StoreIntegrityReport = {
    checkedAt: now().toISOString(),
    // Every path is checked even after one comes back corrupt: an operator
    // asking about their home wants the state of all of it, and the caller
    // decides per store what to do with each verdict.
    results: databasePaths.map((databasePath) => verify(databasePath)),
  };
  write(`${JSON.stringify(report)}\n`);
  return storeIntegrityExitCode(report.results);
}

/**
 * Only runs when this file is the actual entry point, never on import — which
 * is what makes `runStoreIntegrityProbe` testable without a real spawn.
 *
 * Compared through `realpath`, unlike `self-update-watchdog-runner.ts`'s
 * otherwise-identical guard. Node resolves an entry module's `import.meta.url`
 * through symlinks while `process.argv[1]` stays the string it was invoked
 * with, so a bundle spawned via any symlinked path — `/tmp` and
 * `/var/folders` are both symlinks on macOS, and so is a home directory on
 * plenty of installs — fails the naive comparison. The failure mode is the
 * bad one: the process starts, does nothing, and exits 0, which reads as a
 * clean verification.
 */
function invokedAsEntrypoint(moduleUrl: string, argv1?: string): boolean {
  if (argv1 === undefined) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

const isEntrypoint = invokedAsEntrypoint(import.meta.url, process.argv[1]);

if (isEntrypoint) {
  try {
    process.exitCode = runStoreIntegrityProbe(process.argv);
  } catch (error) {
    // A probe that crashed did not observe corruption. It must exit
    // `unavailable`, never `corrupt`: the caller acts on `corrupt` by
    // recording a marker against the user's history, and a crash is no
    // evidence at all about the bytes.
    process.stderr.write(
      `store-integrity-probe: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = STORE_INTEGRITY_EXIT_CODE.unavailable;
  }
}
