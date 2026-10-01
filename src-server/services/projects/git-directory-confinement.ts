/**
 * Whether a checkout's git directory belongs to the Project (#2363), shared
 * by everything that runs git in a member-writable folder: the coding
 * toolbar's Commit and Push, and every coding git read
 * (`git-read-repository.ts`).
 */
import type { BigIntStats, Dirent } from 'node:fs';
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
 *
 * `alsoMemberWritable` names further member-writable roots (a session
 * worktree beside the Project): a git directory or common directory inside
 * one counts as inside, and is walked the same way.
 *
 * An accepting verdict carries the git directory and common directory it
 * checked, and a `fingerprint` of everything the check looked at: the `.git`
 * entry, every directory it listed, and the `commondir` pointer. A caller
 * that runs git afterwards asks again and compares, so a `.git` swapped (or
 * an entry planted and removed) while git ran is noticed. See
 * `fingerprint`'s limits in `git-read-repository.ts`.
 */
export type GitDirectoryVerdict =
  | {
      verdict: 'inside' | 'linked-worktree';
      /** Symlink-resolved. */
      gitDir: string;
      /** Symlink-resolved. */
      commonDir: string;
      fingerprint: string;
    }
  | { verdict: 'outside'; reason: string };

/** Identity and change times of one path, by `lstat` (a link is a link). */
function stampOf(path: string, stats: BigIntStats): string {
  return `${path}\0${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

export async function gitDirectoryInsideProject(
  target: string,
  projectRoot: string,
  alsoMemberWritable: readonly string[] = [],
): Promise<GitDirectoryVerdict> {
  const outside = (reason: string): GitDirectoryVerdict => ({
    verdict: 'outside',
    reason,
  });
  const dotGit = join(target, '.git');
  const stamps: string[] = [];
  try {
    const stats = await lstat(dotGit, { bigint: true });
    if (stats.isSymbolicLink()) {
      return outside('.git is a symbolic link');
    }
    stamps.push(stampOf(dotGit, stats));
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
    // Exactly two lines: a path holding a line break is not guessed at.
    const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length !== 2) throw new Error('unexpected rev-parse output');
    gitDir = await realpath(lines[0]);
    commonDir = await realpath(lines[1]);
  } catch {
    return outside('git could not locate its git directory');
  }
  const inside = (path: string) =>
    [projectRoot, ...alsoMemberWritable].some(
      (root) => path === root || path.startsWith(root + sep),
    );
  // A directory inside the Project is member-writable: its entries may be
  // symlinks into, or alternates of, another repository.
  for (const dir of new Set([gitDir, commonDir])) {
    if (!inside(dir)) continue;
    const redirected = await redirectedGitEntry(dir, inside, stamps);
    if (redirected) return outside(redirected);
  }
  const accepted = (verdict: 'inside' | 'linked-worktree') => ({
    verdict,
    gitDir,
    commonDir,
    fingerprint: stamps.join('\n'),
  });
  if (inside(gitDir) && inside(commonDir)) return accepted('inside');
  if (inside(gitDir) || dirname(dirname(gitDir)) !== commonDir) {
    return outside('.git points at a repository outside this Project');
  }
  try {
    const backPointer = (
      await readFile(join(gitDir, 'gitdir'), 'utf-8')
    ).trim();
    return (await realpath(backPointer)) === (await realpath(dotGit))
      ? accepted('linked-worktree')
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

/**
 * The same bound for `objects/`, counted on its own. Loose objects are not
 * few: git only packs them when its automatic maintenance runs, and a
 * repository agents commit in all day was measured holding 90,000 of them,
 * which the bound above would refuse outright. Listing them costs one
 * `readdir` per fan-out directory whatever their number, so the bound is
 * there to stop a directory tree built to be walked forever, not to limit
 * an ordinary repository.
 */
const MAX_WALKED_OBJECT_ENTRIES = 2_000_000;

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
 * - everything under `refs/`, `logs/` and `objects/`, recursively. That
 *   includes each loose object inside its fan-out directory: a linked
 *   `objects/ab/cdef…` serves another repository's object as surely as a
 *   linked fan-out directory does. Entries are read with `readdir`'s own
 *   types, one call per directory and no `lstat` per object, so the walk
 *   costs one listing for each of at most 256 fan-out directories.
 * Alternates (`objects/info/alternates`, `http-alternates`) are refused
 * outright: they make git read another repository's objects.
 *
 * `stamps` collects the identity and change times of every directory
 * listed, taken BEFORE its listing, and of the `commondir` pointer.
 */
async function redirectedGitEntry(
  gitDir: string,
  insideProject: (path: string) => boolean,
  stamps: string[],
): Promise<string | null> {
  let walked = 0;
  let limit = MAX_WALKED_ENTRIES;
  // Entries of `dir` by `readdir`'s own type (an lstat: a link is a link).
  const entries = async (dir: string) => {
    let list: Dirent[];
    try {
      stamps.push(stampOf(dir, await lstat(dir, { bigint: true })));
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      stamps.push(`${dir}\0absent`);
      return [];
    }
    walked += list.length;
    if (walked > limit) throw new WalkLimitExceeded();
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
    let found =
      (await linkIn(gitDir, hooksInsideProject)) ??
      (await linkBelow(join(gitDir, 'refs'))) ??
      (await linkBelow(join(gitDir, 'logs')));
    if (!found) {
      walked = 0;
      limit = MAX_WALKED_OBJECT_ENTRIES;
      found = await linkBelow(join(gitDir, 'objects'));
    }
    if (found) return `${named(found)} is a symbolic link`;
  } catch (error) {
    if (error instanceof WalkLimitExceeded) {
      return `.git holds more than ${limit} entries to check`;
    }
    throw error;
  }
  // `commondir` names where this git directory's objects and refs live; its
  // content can be rewritten in place, which no directory's times record.
  const commonPointer = join(gitDir, 'commondir');
  try {
    stamps.push(
      stampOf(commonPointer, await lstat(commonPointer, { bigint: true })),
    );
  } catch {
    stamps.push(`${commonPointer}\0absent`);
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
