/**
 * Shared git-tracked-file helpers for the gates that scope themselves with `git ls-files`.
 *
 * Extracted when `listGitTrackedFiles`/`assertClaimSurfacesAreGitTracked` in
 * claim-fixture-ratchet.mjs turned out to be a line-for-line duplicate of the same pair in
 * shell-conformance-ratchet.mjs, with a third copy of the `git ls-files` + encoding/windowsHide +
 * trim/split/filter boilerplate in state-primitives-ratchet.mjs. Those two ratchets now list
 * through `lib/gate-scope.mjs`, which builds its extension-filtered listing on `gitLsFiles` here.
 *
 * `gitLsFiles` is the one listing primitive. The gates that scan a pathspec call it directly:
 * random-uuid-guard, lazy-boundary-ratchet, sdk-error-message-ratchet, dialog-surface-class-guard,
 * font-origin-ratchet, ui-glyph-coverage-ratchet, knowledge-kit-import-gate, unsaved-guard-gate,
 * native-platform-boundary, station-vocabulary-gate and proof-repo-guardrails.
 * `assertFilesAreGitTracked` serves claim-fixture-ratchet, which verifies that a declared list of
 * surfaces is actually tracked. A gate the guardrail test harness copies into a scratch repository
 * must name this module in that fixture's `libs`.
 */
import { execFileSyncBounded } from './bounded-capture.mjs';

/**
 * Runs `git ls-files` with the given argv (a glob, or `['--', ...explicitPaths]`) and returns the
 * matched tracked paths as a plain array, blank lines dropped. The one real duplicated primitive:
 * every caller in this family used the identical `execFileSync` invocation (encoding, windowsHide)
 * before this extraction.
 */
export function gitLsFiles(args) {
  const out = execFileSyncBounded('git', ['ls-files', ...args], {
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
