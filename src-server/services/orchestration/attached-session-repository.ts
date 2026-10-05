/**
 * #3386 Phase A: which git repository an attached session's folder belongs
 * to, so a session that runs in a worktree OUTSIDE a project's folder (a
 * sibling `../<repo>-worktrees/<lane>`, or another tool's worktree root such
 * as `~/.t3/worktrees/<repo>/<name>`) can still be attributed to the project
 * whose folder is a checkout of the same repository.
 *
 * Found the way git finds it, by reading the `.git` entry and its
 * `commondir` pointer (`locateGitDirectories`), never by running git: this
 * runs on the two-second attached-session poll.
 */
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { expandTilde } from '../../utils/paths.js';
import { locateGitDirectories } from '../projects/git-directory-confinement.js';

/** Where a folder sits in its repository. */
export interface RepositoryLocation {
  /** The repository's common git directory, symlink-resolved: one per repository, shared by all its worktrees. */
  commonDir: string;
  /** The folder's path inside its worktree, `''` at the worktree root; compare with {@link isWithinRepositoryPath}. */
  pathInWorktree: string;
}

/** Looks up a folder's repository; `undefined` when it is in none (or no longer exists). */
export type RepositoryLookup = (
  path: string,
) => Promise<RepositoryLocation | undefined>;

/**
 * How many folders above the start a lookup climbs before giving up. Far
 * deeper than any real checkout; it only bounds a pathological path.
 */
const MAX_ANCESTORS = 128;

/**
 * The repository `path` belongs to: the nearest folder at or above it with a
 * `.git` entry, as git would pick it. So a session in a nested repository
 * belongs to the nested one, not the outer one.
 *
 * A folder that no longer exists (a removed worktree) is not an error: its
 * missing ancestors simply have no `.git`, and the climb continues to the
 * first one that does, or ends with `undefined`. A `.git` that names
 * nothing readable ends the climb with `undefined` too, rather than skipping
 * to an outer repository git itself would not have chosen.
 */
export async function locateRepository(
  path: string,
): Promise<RepositoryLocation | undefined> {
  if (!path) return undefined;
  // Climb from the real folder, as git does from its real working directory:
  // a symlinked cwd belongs to the repository its target is in.
  const absolute = resolve(expandTilde(path));
  const start = await realpath(absolute).catch(() => absolute);
  let folder = start;
  for (let depth = 0; depth <= MAX_ANCESTORS; depth += 1) {
    const dotGit = join(folder, '.git');
    const stats = await lstat(dotGit, { bigint: true }).catch(() => undefined);
    if (stats) {
      const located = await locateGitDirectories(folder, dotGit, stats);
      if (!located) return undefined;
      return {
        commonDir: located.commonDir,
        pathInWorktree: relative(folder, start),
      };
    }
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
  return undefined;
}

/** Whether `candidate` is `root` or a folder inside it, both relative to their worktree. */
export function isWithinRepositoryPath(
  candidate: string,
  root: string,
): boolean {
  return (
    root === '' || candidate === root || candidate.startsWith(`${root}${sep}`)
  );
}

/**
 * A lookup that reads each folder once per poll. Deliberately not kept
 * across polls: a worktree can be added or removed between them, and a
 * persistent cache keyed by folder would keep answering for one that is
 * gone (`src-server/AGENTS.md`).
 */
export function createPollRepositoryLookup(
  locate: RepositoryLookup = locateRepository,
): RepositoryLookup {
  const cache = new Map<string, Promise<RepositoryLocation | undefined>>();
  return (path) => {
    let found = cache.get(path);
    if (!found) {
      found = locate(path).catch(() => undefined);
      cache.set(path, found);
    }
    return found;
  };
}
