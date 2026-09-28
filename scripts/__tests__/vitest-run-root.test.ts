import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stationTempRoot } from '@kontourai/station-shared/temp-dir';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createVitestRunRoot,
  VITEST_RUN_ROOT_PREFIX,
} from '../../vitest.global-setup.js';

/**
 * A vitest run root must belong to one process.
 *
 * It was a fixed path (`<station-temp>/vitest`) shared by every vitest process
 * on the machine, while `globalSetup`'s teardown deletes its run root
 * wholesale. Two overlapping runs — routine in a checkout with dozens of
 * worktrees — meant the first to finish deleted the second's `STATION_HOME`
 * directories mid-test. Reproduced at 2 failures in 12 runs, surfacing as
 * `expected [] to have a length of 1 but got +0` in `scheduler.test.ts`:
 * `JsonFileStore`'s missing-file fallback, because the file's directory had
 * been removed between the write and the read.
 *
 * This pins the property that prevents it, not the wording of the fix.
 */
describe('vitest run root', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function track(dir: string): string {
    created.push(dir);
    return dir;
  }

  // Unique and siblings: one run's teardown deletes its root wholesale, so a
  // second root nested inside the first would be deleted with it.
  it('is a unique sibling per call, so concurrent runs cannot share one', () => {
    const first = track(createVitestRunRoot());
    const second = track(createVitestRunRoot());
    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(stationTempRoot());
    expect(dirname(second)).toBe(stationTempRoot());
  });

  it('lives under the Station temp root so the day-old sweep reclaims it', () => {
    const root = track(createVitestRunRoot());
    expect(
      root.startsWith(join(stationTempRoot(), VITEST_RUN_ROOT_PREFIX)),
    ).toBe(true);
  });
});
