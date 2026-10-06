/**
 * Whether a checkout's git directory belongs to the Project (#2363), shared
 * by everything that runs git in a member-writable folder: the coding
 * toolbar's Commit and Push, and everything that resolves a repository
 * through `git-read-repository.ts`.
 */
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Names the repository explicitly, so git never discovers another one. */
export function repositoryArgs(root: string): string[] {
  return [`--git-dir=${join(root, '.git')}`, `--work-tree=${root}`];
}

/** Thrown for a path that is there but is not a small regular file. */
export class NotARegularFileError extends Error {}

/**
 * The bytes of a small regular file at a member-controlled path, or `null`
 * when nothing is there. The path is opened without following a link and
 * without blocking (a FIFO planted there would otherwise hold the caller
 * until someone wrote to it), and it is the OPENED file that is checked: a
 * regular file of at most `maxBytes`. Anything else throws.
 */
export async function readSmallRegularFile(
  path: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // ELOOP (a link), ENXIO (a socket), EISDIR, EACCES, …
    throw new NotARegularFileError(`not a readable regular file: ${path}`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      throw new NotARegularFileError(`not a small regular file: ${path}`);
    }
    const bytes = Buffer.alloc(stats.size);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        read,
        bytes.length - read,
        read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

/** A `.git` file, a `commondir` or a `gitdir` pointer is one short line. */
const MAX_POINTER_BYTES = 8 * 1024;

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
 * The two directories are found the way git finds them, by reading the
 * `.git` entry and the `commondir` pointer, not by asking git: this runs
 * before every read, and a git process costs more than the reads it guards.
 *
 * `alsoMemberWritable` names further member-writable roots (a session
 * worktree beside the Project): a git directory or common directory inside
 * one counts as inside, and is walked the same way.
 *
 * An accepting verdict carries the git directory and common directory it
 * checked, and two ways to ask whether that is still what is there:
 *
 * - `unchanged`: everything the check looked at still has the identity and
 *   change times it had. That is every folder from the member-writable root
 *   down to `target` (renaming a folder ABOVE the repository swaps the whole
 *   repository without touching anything inside it), the `.git` entry,
 *   every directory the check listed, and the files whose content steers
 *   git (`STEERING_FILES`). For after a READ: on `false` the output is
 *   discarded. It costs one `lstat` per path and lists nothing again:
 *   adding, removing or renaming an entry changes its directory's times.
 * - `sameIdentity`: the folders down to `target`, the `.git` entry and the
 *   git directories are still the same files (device and inode), whatever
 *   their times. For after a WRITE, which changes the times itself.
 *
 * Their limits are in `git-read-repository.ts`.
 *
 * NOT CLOSED, by choice: a linked worktree's registration is what vouches
 * for it, and a registration can outlive its folder (a worktree removed
 * without `git worktree prune`). Whoever recreates that folder's `.git`
 * file inside the Project gets the worktree back, and Station cannot tell
 * that file from the one git wrote: the content is the same, and judging by
 * file times would refuse a genuine worktree after a restore from backup.
 * It takes a repository the operator once checked out at that very path.
 */
export type GitDirectoryVerdict =
  | {
      verdict: 'inside' | 'linked-worktree';
      /** Symlink-resolved. */
      gitDir: string;
      /** Symlink-resolved. */
      commonDir: string;
      unchanged: () => Promise<boolean>;
      sameIdentity: () => Promise<boolean>;
    }
  | { verdict: 'outside'; reason: string };

export interface GitDirectoryCheckOptions {
  alsoMemberWritable?: readonly string[];
  /**
   * What the caller's git will read through this directory. `read`: a
   * Station-owned copy of the per-worktree files with `objects` and `refs`
   * linked back (`git-read-repository.ts`), which never opens `logs/`, so
   * reflogs are neither listed nor counted. `all` (the default): the
   * directory itself, as Commit and Push use it.
   */
  storage?: 'read' | 'all';
  /** The walk's bounds; for tests of the bounds themselves. */
  limits?: { entries: number; objectEntries: number };
}

/** Identity and change times of one path, by `lstat` (a link is a link). */
function stampOf(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** The device and inode of a stamp. */
function identityOf(stamp: string): string {
  return stamp.split(':').slice(0, 2).join(':');
}

const ABSENT = 'absent';

/** The stamp `path` has now. */
async function currentStamp(path: string): Promise<string> {
  try {
    return stampOf(await lstat(path, { bigint: true }));
  } catch {
    return ABSENT;
  }
}

/** Paths stamped at once when checking them again. */
const STAMP_BATCH = 64;

async function stampsHold(
  stamps: ReadonlyMap<string, string>,
  same: (before: string, now: string) => boolean,
): Promise<boolean> {
  const all = [...stamps];
  for (let start = 0; start < all.length; start += STAMP_BATCH) {
    const held = await Promise.all(
      all
        .slice(start, start + STAMP_BATCH)
        .map(async ([path, stamp]) => same(stamp, await currentStamp(path))),
    );
    if (held.includes(false)) return false;
  }
  return true;
}

/**
 * What a check recorded. `pinned` is what must stay the SAME FILES even
 * across a write; `listed` is everything else that must not change at all.
 */
interface Stamps {
  pinned: Map<string, string>;
  listed: Map<string, string>;
}

/**
 * Files in a git directory whose content steers git, and which can be
 * rewritten in place (which no directory's times record): the config, the
 * per-worktree config, the attributes, the packed refs (a ref repointed at
 * another repository's commit), and where HEAD points.
 */
const STEERING_FILES = [
  'config',
  'config.worktree',
  join('info', 'attributes'),
  'packed-refs',
  'HEAD',
];

/**
 * The git directory and common directory `target/.git` leads to, as git
 * resolves them: a directory is the git directory; a file names it
 * (`gitdir: <path>`, relative to `target`); a `commondir` file inside it
 * names the common directory (relative to the git directory). Both are
 * symlink-resolved; `null` when the entry names nothing readable.
 */
export async function locateGitDirectories(
  target: string,
  dotGit: string,
  dotGitStats: BigIntStats,
): Promise<{ gitDir: string; commonDir: string } | null> {
  try {
    let gitDir: string;
    if (dotGitStats.isDirectory()) {
      gitDir = await realpath(dotGit);
    } else {
      const pointer = await readSmallRegularFile(dotGit, MAX_POINTER_BYTES);
      const named = /^gitdir: ([^\r\n]+)/.exec(pointer?.toString('utf8') ?? '');
      if (!named) return null;
      gitDir = await realpath(resolve(target, named[1].trim()));
    }
    const common = await readSmallRegularFile(
      join(gitDir, 'commondir'),
      MAX_POINTER_BYTES,
    );
    const commonDir = common
      ? await realpath(resolve(gitDir, common.toString('utf8').trim()))
      : gitDir;
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

export async function gitDirectoryInsideProject(
  target: string,
  projectRoot: string,
  options: GitDirectoryCheckOptions = {},
): Promise<GitDirectoryVerdict> {
  const memberWritable = [projectRoot, ...(options.alsoMemberWritable ?? [])];
  const outside = (reason: string): GitDirectoryVerdict => ({
    verdict: 'outside',
    reason,
  });
  const dotGit = join(target, '.git');
  const stamps: Stamps = { pinned: new Map(), listed: new Map() };
  // Every folder below the member-writable root, down to `target`: any of
  // them can be renamed away and another put in its place.
  const root = memberWritable
    .filter((candidate) => target.startsWith(candidate + sep))
    .sort((a, b) => b.length - a.length)[0];
  if (root) {
    let folder = root;
    for (const segment of relative(root, target).split(sep)) {
      folder = join(folder, segment);
      stamps.pinned.set(folder, await currentStamp(folder));
    }
  }
  let dotGitStats: BigIntStats;
  try {
    dotGitStats = await lstat(dotGit, { bigint: true });
  } catch {
    return outside('.git is missing');
  }
  if (dotGitStats.isSymbolicLink()) return outside('.git is a symbolic link');
  stamps.pinned.set(dotGit, stampOf(dotGitStats));
  const located = await locateGitDirectories(target, dotGit, dotGitStats);
  if (!located) return outside('git could not locate its git directory');
  const { gitDir, commonDir } = located;
  const inside = (path: string) =>
    memberWritable.some(
      (writable) => path === writable || path.startsWith(writable + sep),
    );
  // A directory inside the Project is member-writable: its entries may be
  // symlinks into, or alternates of, another repository.
  for (const dir of new Set([gitDir, commonDir])) {
    if (!inside(dir)) continue;
    const redirected = await redirectedGitEntry(dir, inside, stamps, {
      limits: options.limits ?? DEFAULT_LIMITS,
      reflogs: options.storage !== 'read',
    });
    if (redirected) return outside(redirected);
  }
  const accepted = (verdict: 'inside' | 'linked-worktree') => ({
    verdict,
    gitDir,
    commonDir,
    unchanged: async () =>
      (await stampsHold(stamps.pinned, (before, now) => before === now)) &&
      (await stampsHold(stamps.listed, (before, now) => before === now)),
    sameIdentity: () =>
      stampsHold(
        stamps.pinned,
        (before, now) =>
          (before === ABSENT) === (now === ABSENT) &&
          identityOf(before) === identityOf(now),
      ),
  });
  if (inside(gitDir) && inside(commonDir)) return accepted('inside');
  if (inside(gitDir) || dirname(dirname(gitDir)) !== commonDir) {
    return outside('.git points at a repository outside this Project');
  }
  try {
    const backPointer = await readSmallRegularFile(
      join(gitDir, 'gitdir'),
      MAX_POINTER_BYTES,
    );
    if (!backPointer) {
      return outside('.git points at a repository outside this Project');
    }
    // git writes it absolute, or relative to the entry it lives in
    // (`worktree.useRelativePaths`, `git worktree add --relative-paths`).
    return (await realpath(
      resolve(gitDir, backPointer.toString('utf8').trim()),
    )) === (await realpath(dotGit))
      ? accepted('linked-worktree')
      : outside(".git points at another checkout's worktree entry");
  } catch {
    return outside('.git points at a repository outside this Project');
  }
}

/**
 * The most entries the symlink walk will examine among a git directory's
 * own entries, its refs and (for Commit and Push) its reflogs before giving
 * up. A repository past it is refused as unverifiable rather than walked
 * without bound.
 */
const MAX_WALKED_ENTRIES = 200_000;

/**
 * The same bound for `objects/`, counted on its own. Loose objects are not
 * few: git only packs them when its automatic maintenance runs, and a
 * repository agents commit in all day was measured holding 90,000 of them.
 * The bound is there to stop a directory tree built to be walked forever,
 * not to limit an ordinary repository.
 */
const MAX_WALKED_OBJECT_ENTRIES = 2_000_000;

const DEFAULT_LIMITS = {
  entries: MAX_WALKED_ENTRIES,
  objectEntries: MAX_WALKED_OBJECT_ENTRIES,
};

class WalkLimitExceeded extends Error {}

/** What one listing of a directory found. Names only where they matter. */
interface Listing {
  stamp: string;
  count: number;
  links: string[];
  subdirectories: string[];
}

/**
 * Listings by directory, reused while the directory's stamp is the one the
 * listing was taken under. Adding, removing or renaming an entry changes a
 * directory's times, which is what the after-read check already relies on,
 * so an unchanged stamp means the listing still holds and the directory is
 * not read again: a repository holding 96,000 loose objects cost 165 ms to
 * walk on every read, and costs one `lstat` per fan-out directory this way.
 *
 * Not reused when the directory changed within `RACY_NS` of being listed: a
 * file system that stamps from a coarse clock could give a later change the
 * same times, and a stale listing here would be believed for as long as the
 * process lives, not for one read.
 */
const listings = new Map<string, Listing>();
const MAX_CACHED_LISTINGS = 20_000;
const RACY_NS = 2_000_000_000n;

function remember(dir: string, listing: Listing, stats: BigIntStats): void {
  const newest = stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs;
  if (BigInt(Date.now()) * 1_000_000n - newest < RACY_NS) {
    listings.delete(dir);
    return;
  }
  if (listings.size >= MAX_CACHED_LISTINGS && !listings.has(dir)) {
    const oldest = listings.keys().next().value;
    if (oldest !== undefined) listings.delete(oldest);
  }
  listings.set(dir, listing);
}

/**
 * True when `gitDir` borrows another repository's storage (#2363 review
 * rounds 2 and 3). Git never creates a symbolic link in a repository it
 * made (the legacy `core.preferSymlinkRefs` HEAD aside, which is refused
 * too), and it READS through one: a linked loose ref resolves a branch to
 * another repository's commit, a linked pack or fan-out directory serves
 * another repository's objects, and a push then sends them. So, rather
 * than naming the dangerous entries, ANY symbolic link is refused among:
 * - the git directory's top-level entries (HEAD, index, config, …);
 * - everything under `refs/` and `objects/`, recursively, and under
 *   `logs/` when the caller's git reads reflogs. That includes each loose
 *   object inside its fan-out directory: a linked `objects/ab/cdef…` serves
 *   another repository's object as surely as a linked fan-out directory
 *   does.
 * Alternates (`objects/info/alternates`, `http-alternates`) are refused
 * outright: they make git read another repository's objects.
 *
 * `stamps` collects the identity and change times of the git directory
 * itself and its `commondir` pointer (pinned), and of every directory
 * listed, taken BEFORE its listing, and the steering files (listed).
 */
async function redirectedGitEntry(
  gitDir: string,
  insideProject: (path: string) => boolean,
  stamps: Stamps,
  options: {
    limits: { entries: number; objectEntries: number };
    reflogs: boolean;
  },
): Promise<string | null> {
  let walked = 0;
  let limit = options.limits.entries;
  // What `dir` holds, by the directory's own types (an lstat: a link is a
  // link), read one entry at a time so the bound stops the listing itself:
  // a directory holding millions of entries is never held in memory whole.
  const listingOf = async (dir: string): Promise<Listing> => {
    const record = dir === gitDir ? stamps.pinned : stamps.listed;
    const empty = (stamp: string): Listing => ({
      stamp,
      count: 0,
      links: [],
      subdirectories: [],
    });
    let stats: BigIntStats;
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      stats = await lstat(dir, { bigint: true });
      record.set(dir, stampOf(stats));
      const known = listings.get(dir);
      if (known && known.stamp === stampOf(stats)) {
        walked += known.count;
        if (walked > limit) throw new WalkLimitExceeded();
        return known;
      }
      handle = await opendir(dir);
    } catch (error) {
      if (error instanceof WalkLimitExceeded) throw error;
      // Missing, or not a directory: nothing to list, and it must stay so.
      const stamp = await currentStamp(dir);
      record.set(dir, stamp);
      return empty(stamp);
    }
    const listing = empty(stampOf(stats));
    for await (const entry of handle) {
      walked += 1;
      listing.count += 1;
      if (walked > limit) throw new WalkLimitExceeded();
      if (entry.isSymbolicLink()) listing.links.push(entry.name);
      else if (entry.isDirectory()) listing.subdirectories.push(entry.name);
    }
    remember(dir, listing, stats);
    return listing;
  };
  const named = (path: string) => `.git/${relative(gitDir, path)}`;
  const linkBelow = async (dir: string): Promise<string | null> => {
    const listing = await listingOf(dir);
    if (listing.links.length > 0) return join(dir, listing.links[0]);
    // Subdirectories side by side: `objects/` has up to 256 of them.
    const below = await Promise.all(
      listing.subdirectories.map((name) => linkBelow(join(dir, name))),
    );
    return below.find((found) => found !== null) ?? null;
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
    let found: string | null = null;
    for (const name of (await listingOf(gitDir)).links) {
      const path = join(gitDir, name);
      if (!(await hooksInsideProject(path))) {
        found = path;
        break;
      }
    }
    found ??= await linkBelow(join(gitDir, 'refs'));
    if (!found && options.reflogs) {
      found = await linkBelow(join(gitDir, 'logs'));
    }
    if (!found) {
      walked = 0;
      limit = options.limits.objectEntries;
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
  stamps.pinned.set(commonPointer, await currentStamp(commonPointer));
  // So can these; a read made while one changed is discarded.
  for (const file of STEERING_FILES) {
    const path = join(gitDir, file);
    stamps.listed.set(path, await currentStamp(path));
  }
  for (const alternates of ['alternates', 'http-alternates']) {
    try {
      await lstat(join(gitDir, 'objects', 'info', alternates));
      // What `git clone --shared` and `--reference` leave behind. The way
      // out is git's own: `git repack -a -d` copies the borrowed objects in,
      // after which the file can go.
      return `.git/objects/info/${alternates} borrows another repository's objects; to read this repository here, run \`git repack -a -d\` in it and remove that file`;
    } catch {
      // Absent: the ordinary case.
    }
  }
  return null;
}
