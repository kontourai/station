/**
 * The real-tree half of `test-import-existence-gate.test.ts`, moved here
 * unchanged (#2176) so the `repo-scans` pull-request job can run it: both
 * tests enumerate the repository with `git ls-files`, which no import edge
 * connects to this test. `runGate` is repeated from the original file, where
 * the fixture-repo cases still use it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { TEST_FILE_PATTERN } from '../test-import-existence-gate.mjs';
import { VITEST_TEST_FILE_PATTERN } from '../verification-policy-gate.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const gatePath = join(repoRoot, 'scripts/test-import-existence-gate.mjs');

describe('the gate as a real child process', () => {
  function runGate(root: string) {
    const result = spawnSync(process.execPath, [gatePath, '--root', root], {
      encoding: 'utf8',
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }

  test('positive control: the real repository passes today (station#3423 fixed the one prior offender)', () => {
    // Independently derived from `git ls-files`, NOT via the gate's own
    // `listTrackedTestFiles` — a scope bug added inside that function (e.g.
    // an accidental `packages/**` exclusion) must move the gate's printed
    // count away from this independently-computed figure, or the gate could
    // silently drop hundreds of files and still print a confident `OK:`
    // (station#3423 review MEDIUM-1: reproduced live, 1759 -> 1469 files,
    // 290 dropped including qr-round-trip.test.ts itself, exit 0 throughout).
    const trackedFiles = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    const expectedCount = trackedFiles.filter((file) =>
      TEST_FILE_PATTERN.test(file),
    ).length;
    expect(expectedCount).toBeGreaterThan(0);

    const { status, output } = runGate(repoRoot);
    expect(status).toBe(0);
    expect(output).toContain('OK:');
    expect(output).toContain(
      `OK: every statically-extractable bare import in ${expectedCount} test file(s) resolves to an installed package.`,
    );
  });

  // The count check above derives `expectedCount` from `TEST_FILE_PATTERN` —
  // the SAME predicate `listTrackedTestFiles` filters with — so it proves the
  // gate's git-ls-files-plus-filter plumbing is wired correctly, but has zero
  // power over the predicate itself: a `TEST_FILE_PATTERN` narrowed to drop a
  // real extension would shrink the "expected" side and the gate's actual
  // side identically, and the test would stay green while both silently
  // dropped the same files (station#3435 review MEDIUM-1 — the tautology
  // moved up a level rather than closing). Cross-check against
  // `VITEST_TEST_FILE_PATTERN`: a pre-existing, independently declared,
  // strictly broader test-file predicate `verification-policy-gate.mjs`
  // already uses to discover this repo's tracked Vitest corpus for an
  // unrelated gate (the resource-manifest partition check). Every tracked
  // path must classify identically under both, so a narrowing of either
  // predicate alone reds this test by name, file, and pattern — it cannot
  // hide behind a re-derivation that shares the bug.
  test('TEST_FILE_PATTERN classifies every tracked path identically to the independent VITEST_TEST_FILE_PATTERN oracle (station#3435 review MEDIUM-1)', () => {
    const trackedFiles = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(trackedFiles.length).toBeGreaterThan(0);

    const mismatches = trackedFiles.filter(
      (file) =>
        TEST_FILE_PATTERN.test(file) !== VITEST_TEST_FILE_PATTERN.test(file),
    );
    expect(mismatches).toEqual([]);
  });
});
