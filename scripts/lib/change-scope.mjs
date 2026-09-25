/**
 * Branch-delta helpers shared by the scoped pre-push guards and the CI bundle
 * delta report: which paths a branch changes, and how to name a match set
 * without printing an unbounded list.
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

/** Paths this branch changes relative to `base`, as repo-relative strings. */
export function changedPathsSince(base, run = git) {
  return run(['diff', '--name-only', '-z', `${base}...HEAD`])
    .split('\0')
    .filter(Boolean);
}

export function describeMatches(matched, limit = 3) {
  const shown = matched.slice(0, limit).join(', ');
  const remaining = matched.length - Math.min(limit, matched.length);
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}
