/**
 * Branch-delta helpers shared by the scoped pre-push guards and the CI bundle
 * delta report: which paths a branch changes, and how to name a match set
 * without printing an unbounded list.
 */
import { execFileSyncBounded } from './bounded-capture.mjs';

function git(args) {
  return execFileSyncBounded('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/**
 * Paths this branch changes relative to `base`, as repo-relative strings.
 *
 * `--no-renames` reports both sides of a move. With rename detection git
 * prints only the destination, so a file moved OUT of a gated root would be
 * invisible to the scope guard that reads that root.
 */
export function changedPathsSince(base, run = git) {
  return run(['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`])
    .split('\0')
    .filter(Boolean);
}

export function describeMatches(matched, limit = 3) {
  const shown = matched.slice(0, limit).join(', ');
  const remaining = matched.length - Math.min(limit, matched.length);
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}
