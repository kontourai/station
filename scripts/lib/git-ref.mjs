import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, {
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
