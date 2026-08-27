/**
 * Shared git-tracked-file helpers for the checked-in-baseline "ratchet" gate family
 * (state-primitives-ratchet.mjs, shell-conformance-ratchet.mjs, claim-fixture-ratchet.mjs).
 * Extracted after `listGitTrackedFiles`/`assertClaimSurfacesAreGitTracked` in
 * claim-fixture-ratchet.mjs turned out to be the second line-for-line duplicate of
 * shell-conformance-ratchet.mjs's `listGitTrackedFiles`/`assertTrackedViewsAreGitTracked` (a third
 * copy counting state-primitives-ratchet.mjs's own `listTrackedTsxFiles`, which shares the same
 * `git ls-files` + encoding/windowsHide + trim/split/filter boilerplate even though it scans a glob
 * rather than verifying an explicit list) — this is the threshold where extraction pays for itself.
 */
import { execFileSync } from 'node:child_process';

/**
 * Runs `git ls-files` with the given argv (a glob, or `['--', ...explicitPaths]`) and returns the
 * matched tracked paths as a plain array, blank lines dropped. The one real duplicated primitive:
 * every caller in this family used the identical `execFileSync` invocation (encoding, windowsHide)
 * before this extraction.
 */
export function gitLsFiles(args) {
  const out = execFileSync('git', ['ls-files', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.trim().split('\n').filter(Boolean);
}

/**
 * Given an explicit list of paths, returns the subset `git ls-files` confirms are actually tracked
 * (committed or staged), as a Set. Empty `paths` short-circuits to an empty Set WITHOUT calling
 * git — an empty `--` filter would otherwise list every tracked file in the repo, which is never
 * what a caller here wants.
 */
export function listGitTrackedFiles(paths) {
  if (paths.length === 0) return new Set();
  return new Set(gitLsFiles(['--', ...paths]));
}

/**
 * Given an explicit list of paths, returns the subset that are NOT git-tracked (empty when
 * everything is tracked, as expected in normal operation). Shared by every ratchet gate in this
 * family that refuses to trust the content of a registered file it cannot prove is
 * committed/staged (the "tracked-simulation practice" — see shell-conformance-ratchet.mjs's file
 * header for the fuller rationale).
 */
export function assertFilesAreGitTracked(paths) {
  const trackedSet = listGitTrackedFiles(paths);
  return paths.filter((file) => !trackedSet.has(file));
}
