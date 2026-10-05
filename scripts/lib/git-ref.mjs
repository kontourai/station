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
