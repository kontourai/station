/**
 * Whether a checkout's git directory belongs to the Project (#2363), shared
 * by every route that runs git in a member-writable folder: the coding
 * toolbar's Commit and Push, and the File Preview's per-file Changes read.
 * Moved here unchanged from coding-git-actions.ts.
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { execGit } from '../../utils/git-exec.js';

/** Names the repository explicitly, so git never discovers another one. */
export function repositoryArgs(root: string): string[] {
  return [`--git-dir=${join(root, '.git')}`, `--work-tree=${root}`];
}

/**
 * Whether `target`'s git directory is the Project's own (#2363). A `.git`
 * FILE can point anywhere, and `--git-dir=<target>/.git` follows it, so a
 * member could otherwise make Commit or Push act on another repository of
 * the operator's. Both the git directory and the common directory must lie
 * inside `projectRoot` (both already symlink-resolved), except for a
 * genuine linked worktree: its git directory is `<common>/worktrees/<name>`
 * OUTSIDE the Project, whose `gitdir` back-pointer names `<target>/.git`.
 * A member cannot write that file, so they cannot forge the exception.
 * A symlinked `.git` is refused outright, and so is a real one whose OWN
 * entries lead elsewhere (`redirectedGitEntry`).
 */
export type GitDirectoryVerdict =
  | { verdict: 'inside' | 'linked-worktree' }
  | { verdict: 'outside'; reason: string };

export async function gitDirectoryInsideProject(
  target: string,
  projectRoot: string,
): Promise<GitDirectoryVerdict> {
  const outside = (reason: string): GitDirectoryVerdict => ({
    verdict: 'outside',
    reason,
  });
  const dotGit = join(target, '.git');
  try {
    if ((await lstat(dotGit)).isSymbolicLink()) {
      return outside('.git is a symbolic link');
    }
  } catch {
    return outside('.git is missing');
  }
  let gitDir: string;
  let commonDir: string;
  try {
    const { stdout } = await execGit(
      [
        ...repositoryArgs(target),
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
      ],
      { cwd: target, encoding: 'utf-8', timeout: 10_000 },
    );
    const [rawGitDir, rawCommonDir] = stdout.trim().split('\n');
    gitDir = await realpath(rawGitDir ?? '');
    commonDir = await realpath(rawCommonDir ?? '');
  } catch {
    return outside('git could not locate its git directory');
  }
  const inside = (path: string) =>
    path === projectRoot || path.startsWith(projectRoot + sep);
  // A directory inside the Project is member-writable: its entries may be
  // symlinks into, or alternates of, another repository.
  for (const dir of new Set([gitDir, commonDir])) {
    if (!inside(dir)) continue;
    const redirected = await redirectedGitEntry(dir, inside);
    if (redirected) return outside(redirected);
  }
  if (inside(gitDir) && inside(commonDir)) return { verdict: 'inside' };
  if (inside(gitDir) || dirname(dirname(gitDir)) !== commonDir) {
    return outside('.git points at a repository outside this Project');
  }
  try {
    const backPointer = (
      await readFile(join(gitDir, 'gitdir'), 'utf-8')
    ).trim();
    return (await realpath(backPointer)) === (await realpath(dotGit))
      ? { verdict: 'linked-worktree' }
      : outside(".git points at another checkout's worktree entry");
  } catch {
    return outside('.git points at a repository outside this Project');
  }
}

/**
 * The most directory entries the symlink walk will examine in one git
 * directory before giving up. A repository past it is refused as
 * unverifiable rather than walked without bound; loose refs are normally
 * few (git packs them), so an ordinary repository is far below it.
 */
const MAX_WALKED_ENTRIES = 50_000;

class WalkLimitExceeded extends Error {}

/**
 * True when `gitDir` borrows another repository's storage (#2363 review
 * rounds 2 and 3). Git never creates a symbolic link in a repository it
 * made (the legacy `core.preferSymlinkRefs` HEAD aside, which is refused
 * too), and it READS through one: a linked loose ref resolves a branch to
 * another repository's commit, a linked pack or fan-out directory serves
 * another repository's objects, and a push then sends them. So, rather
 * than naming the dangerous entries, ANY symbolic link is refused among:
 * - the git directory's top-level entries (HEAD, index, config, …);
 * - everything under `refs/` and `logs/`, recursively;
 * - `objects/`'s own entries (each fan-out directory by its own lstat,
 *   without descending into loose objects), and every entry of
 *   `objects/pack/` and `objects/info/`.
 * Alternates (`objects/info/alternates`, `http-alternates`) are refused
 * outright: they make git read another repository's objects.
 */
async function redirectedGitEntry(
  gitDir: string,
  insideProject: (path: string) => boolean,
): Promise<string | null> {
  let walked = 0;
  // Entries of `dir` by `readdir`'s own type (an lstat: a link is a link).
  const entries = async (dir: string) => {
    let list: Dirent[];
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    walked += list.length;
    if (walked > MAX_WALKED_ENTRIES) throw new WalkLimitExceeded();
    return list;
  };
  const named = (path: string) => `.git/${relative(gitDir, path)}`;
  const linkBelow = async (dir: string): Promise<string | null> => {
    for (const entry of await entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) return path;
      if (entry.isDirectory()) {
        const found = await linkBelow(path);
        if (found) return found;
      }
    }
    return null;
  };
  const linkIn = async (
    dir: string,
    allowed: (path: string) => boolean | Promise<boolean>,
  ) => {
    for (const entry of await entries(dir)) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() && !(await allowed(path))) return path;
    }
    return null;
  };
  const never = () => false;
  // `hooks` is the one entry a link is ordinary for (`.git/hooks ->
  // ../scripts/hooks`), and it is not storage: hooks are off for every
  // call but the operator's own Commit and Push, which run them as a
  // terminal would. Allowed when it resolves inside the Project.
  const hooksInsideProject = async (path: string) => {
    if (relative(gitDir, path) !== 'hooks') return false;
    try {
      return insideProject(await realpath(path));
    } catch {
      return false;
    }
  };
  try {
    const found =
      (await linkIn(gitDir, hooksInsideProject)) ??
      (await linkBelow(join(gitDir, 'refs'))) ??
      (await linkBelow(join(gitDir, 'logs'))) ??
      (await linkIn(join(gitDir, 'objects'), never)) ??
      (await linkIn(join(gitDir, 'objects', 'pack'), never)) ??
      (await linkIn(join(gitDir, 'objects', 'info'), never));
    if (found) return `${named(found)} is a symbolic link`;
  } catch (error) {
    if (error instanceof WalkLimitExceeded) {
      return `.git holds more than ${MAX_WALKED_ENTRIES} entries to check`;
    }
    throw error;
  }
  for (const alternates of ['alternates', 'http-alternates']) {
    try {
      await lstat(join(gitDir, 'objects', 'info', alternates));
      return `.git/objects/info/${alternates} borrows another repository's objects`;
    } catch {
      // Absent: the ordinary case.
    }
  }
  return null;
}
