import { execFileSyncBounded } from './bounded-capture.mjs';

function git(args) {
  return execFileSyncBounded('git', args, {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

/** Resolve a local Git ref to a commit, or return null when it is absent. */
export function resolveRef(ref, run = git) {
  try {
    return run(['rev-parse', '--verify', `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

/**
 * The commit this checkout grew from on `ref`: `git merge-base ref HEAD`, or
 * null when either side is missing or they share no history.
 *
 * A ratchet that asks "did this change add a baseline entry?" must compare
 * against this commit, not against `ref`'s tip. Against the tip, an unmerged
 * branch still carrying an entry that main has since removed reads as an
 * addition, so the gate fails whoever checks next because main moved
 * (#3101, slice F).
 */
export function mergeBaseWith(ref, run = git) {
  try {
    return run(['merge-base', ref, 'HEAD']) || null;
  } catch {
    return null;
  }
}
