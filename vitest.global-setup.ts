import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  stationTempRoot,
  sweepStationTempRoot,
} from '@kontourai/station-shared/temp-dir';

/**
 * Prefix for a run root. Kept distinct so the day-old sweep and any human
 * reading `<tmp>/station/` can tell test-run homes from product temp dirs.
 */
export const VITEST_RUN_ROOT_PREFIX = 'vitest-';

/**
 * A run root belongs to exactly ONE vitest process.
 *
 * This used to be the fixed path `<station-temp>/vitest`, shared by every
 * vitest process on the machine — and the teardown below deletes its run root
 * wholesale. On a checkout with dozens of worktrees, two runs overlap
 * constantly, so the first one to finish deleted the *other* run's
 * `STATION_HOME` directories out from under it mid-test.
 *
 * That is not theoretical. With two concurrent vitest processes sharing the
 * old fixed root and no other interference, `scheduler.test.ts` failed 2 runs
 * in 12 — including the reported one, verbatim:
 *
 *     × BuiltinScheduler > runJob records failure on agent error
 *       → expected [] to have a length of 1 but got +0
 *
 * `[]` is `JsonFileStore`'s missing-file fallback: the job log was written and
 * then the directory holding it vanished before the test read it back. Which
 * test loses the race varies (a Scheduler Routes test lost run 9), which is
 * why it reads as an unrelated intermittent rather than as one broken test.
 *
 * A per-process root makes each run's teardown affect only its own homes.
 */
export function createVitestRunRoot(): string {
  const root = stationTempRoot();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, VITEST_RUN_ROOT_PREFIX));
}

/**
 * Own the lifetime of every temp directory a test run creates.
 *
 * `setupFiles` runs inside pooled workers that vitest may kill outright, so
 * per-worker cleanup is best-effort only. This runs in the main vitest process,
 * whose teardown is reliable, and removes the whole run root in one call.
 *
 * It also sweeps Station temp directories older than a day so a machine that
 * accumulated leaks under the previous setup drains itself instead of needing a
 * manual `rm`.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const runRoot = createVitestRunRoot();
  process.env.STATION_VITEST_RUN_ROOT = runRoot;

  const reclaimed = await sweepStationTempRoot();
  if (reclaimed > 0) {
    console.log(
      `[vitest] reclaimed ${reclaimed} stale Station temp directories`,
    );
  }

  return async () => {
    // `force` suppresses ENOENT, not ENOTEMPTY. A pooled worker still writing
    // under the run root while this walks it makes the directory gain entries
    // between the walk and the final rmdir, and the throw surfaces as a
    // *collect error against whichever test file was in flight* — so an
    // unrelated test gets blamed for an infrastructure race. The comment above
    // is explicit that workers may be killed outright, so a worker outliving
    // this teardown is expected rather than exceptional.
    await rm(runRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    }).catch((error: NodeJS.ErrnoException) => {
      // Still contended after retries: leave it. The day-old sweep on the next
      // run reclaims it, and failing the run here would blame a test again.
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') throw error;
    });
  };
}
