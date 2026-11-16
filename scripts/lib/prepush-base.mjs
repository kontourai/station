/**
 * The base a pre-push check compares a pushed commit against, and whether a
 * verdict against it can be trusted.
 *
 * The new pre-push steps refuse only on positive evidence of a defect in what
 * is being pushed (`--no-verify` is not allowed, so a wrongful refusal has no
 * way around it). When the base cannot support a verdict, they warn, say what
 * they could not check, and leave it to CI. This module names those cases:
 *
 * - `no-ref`: the base ref (normally `origin/main`) is not known here;
 * - `no-merge-base`: the pushed commit shares no history with it (an orphan
 *   branch);
 * - `stale`: the pushed range merges commits the local base does not contain,
 *   which is what a branch that merged a newer main looks like when the local
 *   `origin/main` was not fetched since: main's own changes would then be
 *   judged as the branch's. Merging another unpublished branch looks the
 *   same, and also gets a warning rather than a verdict.
 */
import { spawnSync } from 'node:child_process';

function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * @returns {{ state: 'ok', mergeBase: string }
 *   | { state: 'no-ref' | 'no-merge-base' }
 *   | { state: 'stale', mergeBase: string, merges: string[] }}
 */
export function resolvePushBase(baseRef, sha) {
  if (git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]) === null)
    return { state: 'no-ref' };
  const mergeBase = git(['merge-base', baseRef, sha]);
  if (!mergeBase) return { state: 'no-merge-base' };
  const foreign = [
    ...new Set(
      (git(['rev-list', '--merges', '--parents', `${mergeBase}..${sha}`]) ?? '')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => line.split(' ').slice(2)),
    ),
  ].filter(
    (parent) => git(['merge-base', '--is-ancestor', parent, baseRef]) === null,
  );
  return foreign.length > 0
    ? { state: 'stale', mergeBase, merges: foreign }
    : { state: 'ok', mergeBase };
}

/** One sentence for a base that cannot support a verdict. */
export function describeUnusableBase(baseRef, base) {
  if (base.state === 'no-ref')
    return `there is no ${baseRef} here to compare against (\`git fetch origin main\` adds it)`;
  if (base.state === 'no-merge-base')
    return `the pushed commit shares no history with ${baseRef} (an orphan branch?), so there is no merge base to compare against`;
  if (base.state === 'stale')
    return `the pushed range merges ${base.merges.length} commit(s) the local ${baseRef} does not contain (${base.merges
      .slice(0, 3)
      .map((sha) => sha.slice(0, 12))
      .join(
        ', ',
      )}): either the local ${baseRef} is behind (\`git fetch origin main\` fixes that) or a branch not yet on main was merged (fetching will not help), so a comparison against it would count those commits as this branch's`;
  return '';
}
