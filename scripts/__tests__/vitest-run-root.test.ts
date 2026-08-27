import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('is unique per call, so concurrent runs cannot share one', () => {
    const first = track(createVitestRunRoot());
    const second = track(createVitestRunRoot());
    expect(first).not.toBe(second);
  });

  it('lives under the Station temp root so the day-old sweep reclaims it', () => {
    const root = track(createVitestRunRoot());
    expect(
      root.startsWith(join(stationTempRoot(), VITEST_RUN_ROOT_PREFIX)),
    ).toBe(true);
  });

  // The whole point is that one run's teardown cannot reach another's homes.
  // Deleting a run root must therefore leave a sibling run root untouched.
  it('keeps a sibling run root intact when one is removed', () => {
    const mine = track(createVitestRunRoot());
    const theirs = track(createVitestRunRoot());
    const theirHome = mkdtempSync(join(theirs, 'home-'));
    const theirFile = join(theirHome, 'jobs.json');
    writeFileSync(theirFile, '[]');

    rmSync(mine, { recursive: true, force: true });

    expect(() => rmSync(theirFile, { recursive: false })).not.toThrow();
  });
});
