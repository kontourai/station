/**
 * Which repository git may act on for a folder of a Project, and how a READ
 * (status, log, diff, branches, the repository listing, a checkpoint) runs.
 *
 * git discovers its repository from the folder it runs in, and a Project's
 * folders are member-writable. A `.git` FILE can name another repository's
 * git directory, a `.git` can be a symbolic link, a git directory's entries
 * can be links into another repository or borrow its objects
 * (`objects/info/alternates`), and a real git directory can set
 * `core.worktree` to a folder above the Project. Each would make a read
 * report another repository of the host's: its commits, its branch names
 * and, through `git diff`, its file contents.
 *
 * So ONE discovery runs in the requested folder, and nothing else. The pair
 * it reports (work tree, git directory) is classified by where the work
 * tree starts and checked ({@link resolveProjectRepositoryForRead}).
 *
 * WHAT A READ RUNS GIT WITH. Not the repository's git directory: a
 * directory Station owns, built once per read ({@link
 * openRepositorySnapshot}) and named with `--git-dir`. It holds
 * - `config`: the repository's own configuration as git listed it at that
 *   moment, written out again key by key. Includes are already resolved in
 *   it, per-worktree configuration is already folded in, and
 *   `extensions.worktreeConfig` is not carried, so git reads no
 *   `config.worktree` and no included file later;
 * - `HEAD`, and a COPY of the index (a read never writes the member's);
 * - `objects`, `refs` and `packed-refs`, linked back to the repository.
 * `info/attributes`, hooks and reflogs are not carried. A repository's
 * config can name programs (a clean filter, a diff driver), and it can be
 * rewritten in place between Station judging it and git reading it; this
 * way the bytes Station judged are the only configuration git has, and
 * in-tree `.gitattributes` can only select a filter or driver they do not
 * define.
 *
 * WHAT A WRITE RUNS GIT WITH. A checkout, and a `worktree add` (worktree
 * provisioning, the independent review), must land in the repository's own
 * per-worktree files: HEAD, the index, the HEAD reflog, the new worktree's
 * entry. They run git with `--git-dir` naming the repository's OWN git
 * directory and `GIT_COMMON_DIR` naming the same copy ({@link
 * RepositorySnapshot.live}). git takes its configuration from the common
 * directory, so it reads the copy and nothing else, while HEAD, the index
 * and `logs/HEAD` are read and written where they live; objects, refs and
 * the reflogs go through the copy's links to the repository; `worktrees` is
 * linked too for a `worktree add`, and git names the new entry by its real
 * path (measured on git 2.50: the `.git` file it writes names the
 * repository's `worktrees/<name>`, not the copy's). The copy's `packed-refs`
 * is a link, which a rewrite would replace in the copy alone, so no
 * operation that repacks or deletes refs runs this way.
 *
 * WHAT A SWAP CAN STILL DO. `objects` and `refs` are links to PATHS, and
 * git opens them when it runs. A member can swap `.git`, or a folder above
 * the repository, after the check and put it back afterwards. git cannot be
 * handed an already-opened directory, so the check cannot be made atomic
 * with the command. {@link readProjectRepository} checks again afterwards
 * and discards the output unless everything the check looked at has the
 * same identity and change times as before (the guard's `unchanged`). What
 * that leaves:
 * - a swap-and-restore that the file system's change times do not record.
 *   A rename updates the renamed entry's change time on APFS (measured);
 *   ext4, XFS and Btrfs document the same and were NOT measured here. The
 *   folder the repository sits DIRECTLY in the member-writable root is
 *   watched by its own change time alone, because the root's times change
 *   whenever anything is created in it. Where Linux stamps files from its
 *   coarse clock, a swap-and-restore inside one tick (a few milliseconds)
 *   is not recorded; a check-read-check spans several git processes and
 *   outlasts that in practice, which is an observation, not a proof;
 * - content a member can reach WITHOUT a link, such as a hard link to
 *   another repository's object file. That takes an account that can
 *   already read that file.
 *
 * It also means a repository that is being written (a commit landing, an
 * object being added) reads as changed. The read is repeated a few times
 * and then answered `busy`, which is not a refusal: a new entry in a
 * fan-out directory is exactly what a linked loose object looks like, and
 * one planted during the read and replaced by an ordinary file afterwards
 * cannot be told from an honest write once it is over.
 */
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
import {
  type GitDirectoryCheckOptions,
  gitDirectoryInsideProject,
  readSmallRegularFile,
} from './git-directory-confinement.js';
import {
  judgeRepositoryConfigEntries,
  type RepositoryConfigEntry,
} from './git-repository-config.js';

export type ProjectRepositoryForRead =
  | {
      ok: true;
      /** The work tree's root, symlink-resolved. Run git here. */
      top: string;
      /**
       * `--git-dir=… --work-tree=…` naming the repository ITSELF. For a
       * write; a read runs git with a snapshot's arguments instead.
       */
      repoArgs: string[];
      /** Symlink-resolved. */
      gitDir: string;
      /** Symlink-resolved. */
      commonDir: string;
      /**
       * Whether what was checked is still what is there. Ask after the last
       * git call of a read and discard the output on `false`; ask
       * immediately before a write.
       */
      unchanged: () => Promise<boolean>;
      /** After a write: still the same files, whatever their times. */
      sameIdentity: () => Promise<boolean>;
    }
  | { ok: false; state: 'not-a-repository' }
  /** `reason` names entries relative to `.git`, never a host path. */
  | { ok: false; state: 'refused'; reason: string };

export interface ProjectRepositoryReadOptions {
  /**
   * The verified worktrees of the Project's repository (session worktrees
   * and the main checkout), symlink-resolved, from `listVerifiedWorktrees`
   * (which trusts the Project's repository only when it is its own). Asked
   * for only when the folder's work tree is neither inside the Project nor
   * above it. Absent: there are none.
   */
  registeredWorktrees?: () => Promise<readonly string[]>;
  /** Deadline for each discovery call. A deadline throws; it is not "no". */
  timeoutMs?: number;
  /** See `GitDirectoryCheckOptions.storage`. */
  storage?: GitDirectoryCheckOptions['storage'];
}

const DEFAULT_TIMEOUT_MS = 10_000;

const NOT_A_REPOSITORY: ProjectRepositoryForRead = {
  ok: false,
  state: 'not-a-repository',
};

const refused = (reason: string): ProjectRepositoryForRead => ({
  ok: false,
  state: 'refused',
  reason,
});

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** The runner marks a child it killed on its deadline. */
function timedOut(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown };
  return failure?.killed === true || failure?.signal === 'SIGTERM';
}

type Discovery =
  | { found: true; top: string; gitDir: string; commonDir: string }
  | { found: false; unparseable: boolean };

/**
 * What git discovers from `cwd`: the work tree's root, its git directory
 * and its common directory, from one `rev-parse`, each symlink-resolved.
 * Not found when git finds no work tree there (not a repository, a bare
 * one, a folder inside `.git`). `rev-parse` cannot NUL-terminate paths, so
 * anything but exactly three lines (a path holding a line break) is
 * `unparseable` and is never guessed at.
 */
async function discover(cwd: string, timeoutMs: number): Promise<Discovery> {
  let stdout: string;
  try {
    ({ stdout } = await execGit(
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
      ],
      { cwd, encoding: 'utf-8', timeout: timeoutMs },
    ));
  } catch (error) {
    if (timedOut(error)) throw error;
    return { found: false, unparseable: false };
  }
  const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== 3) return { found: false, unparseable: true };
  try {
    return {
      found: true,
      top: await realpath(lines[0]),
      gitDir: await realpath(lines[1]),
      commonDir: await realpath(lines[2]),
    };
  } catch {
    return { found: false, unparseable: true };
  }
}

const UNPARSEABLE = 'git reported a location Station could not read';

/**
 * The discovered pair when `top`'s own `.git` belongs to the Project (the
 * verdict Commit and Push require, which also admits a genuine linked
 * worktree) and IS the git directory discovery reported.
 */
async function confined(
  found: { top: string; gitDir: string; commonDir: string },
  projectRoot: string,
  alsoMemberWritable: readonly string[],
  storage: GitDirectoryCheckOptions['storage'],
): Promise<ProjectRepositoryForRead> {
  const verdict = await gitDirectoryInsideProject(found.top, projectRoot, {
    alsoMemberWritable,
    storage,
  });
  if (verdict.verdict === 'outside') return refused(verdict.reason);
  if (
    verdict.gitDir !== found.gitDir ||
    verdict.commonDir !== found.commonDir
  ) {
    return refused('.git changed while Station was checking it');
  }
  return {
    ok: true,
    top: found.top,
    repoArgs: [`--git-dir=${found.gitDir}`, `--work-tree=${found.top}`],
    gitDir: found.gitDir,
    commonDir: found.commonDir,
    unchanged: verdict.unchanged,
    sameIdentity: verdict.sameIdentity,
  };
}

/**
 * The repository git may act on for `folder`, or why there is none.
 * `projectRoot` and `folder` are symlink-resolved, and `folder` is one the
 * caller already admitted (inside the Project, a registered worktree, or
 * the checkout above the Project).
 *
 * - Work tree inside the Project: its `.git` must be the Project's own.
 * - Work tree above the Project (the repository that contains it): outside
 *   the member-written area, but trusted only when the git directory is not
 *   inside the Project AND the folder above reports the same pair itself. A
 *   member-written git directory inside the Project can set `core.worktree`
 *   to a folder above it, which would pair that work tree with the wrong
 *   repository.
 * - A registered worktree of the Project's repository: its own `.git`, with
 *   the same checks (the worktree is member-writable too). Which
 *   worktrees are registered is `listVerifiedWorktrees`' answer, which is
 *   empty unless the Project's own repository passes these checks.
 * - Anything else is not a repository of this Project's.
 */
export async function resolveProjectRepositoryForRead(
  projectRoot: string,
  folder: string,
  options: ProjectRepositoryReadOptions = {},
): Promise<ProjectRepositoryForRead> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const found = await discover(folder, timeoutMs);
  if (!found.found) {
    return found.unparseable ? refused(UNPARSEABLE) : NOT_A_REPOSITORY;
  }
  const { top } = found;
  if (within(top, projectRoot)) {
    // A git directory elsewhere in the Project can claim `top` through
    // `core.worktree`; the folder must be part of the work tree it names.
    if (!within(folder, top)) {
      return refused('its git directory names a work tree elsewhere');
    }
    return confined(found, projectRoot, [], options.storage);
  }
  if (within(projectRoot, top)) {
    const confirmed = within(found.gitDir, projectRoot)
      ? null
      : await discover(top, timeoutMs);
    if (
      !confirmed?.found ||
      confirmed.top !== top ||
      confirmed.gitDir !== found.gitDir ||
      confirmed.commonDir !== found.commonDir
    ) {
      return refused('its git directory names a work tree above this Project');
    }
    return {
      ok: true,
      top,
      repoArgs: [`--git-dir=${found.gitDir}`, `--work-tree=${top}`],
      gitDir: found.gitDir,
      commonDir: found.commonDir,
      // Above the Project: not a place a member writes.
      unchanged: async () => true,
      sameIdentity: async () => true,
    };
  }
  const worktrees = (await options.registeredWorktrees?.()) ?? [];
  // Only the worktree's root: a repository nested in a session worktree is
  // not the Project's.
  if (!worktrees.includes(top)) return NOT_A_REPOSITORY;
  return confined(found, projectRoot, [top], options.storage);
}

/**
 * The Project's own repository at `folder`, or a refusal, for a caller that
 * is about to run git there and has no request to answer: the repository
 * git would discover from a member-writable folder is not trusted (a `.git`
 * file there can name any repository on this computer). `projectRoot` is
 * the member-writable root `folder` is in (the Project's working directory;
 * the folder itself when that is what the caller was given). Both are
 * resolved through symlinks here.
 */
export async function requireProjectRepository(
  folder: string,
  projectRoot: string,
  options: Pick<ProjectRepositoryReadOptions, 'storage'> = {},
): Promise<Extract<ProjectRepositoryForRead, { ok: true }>> {
  let root: string;
  let target: string;
  try {
    root = await realpath(projectRoot);
    target = folder === projectRoot ? root : await realpath(folder);
  } catch {
    throw new ProjectRepositoryRefusedError('the folder does not exist');
  }
  const repository = await resolveProjectRepositoryForRead(
    root,
    target,
    options,
  );
  if (repository.ok) return repository;
  throw new ProjectRepositoryRefusedError(
    repository.state === 'refused'
      ? repository.reason
      : 'it is not in a git repository',
  );
}

/**
 * {@link requireProjectRepository}, as the arguments a caller that used to
 * run `git -C <folder> …` puts in front of its command instead:
 * `-C <top> --git-dir=… --work-tree=…`, so git does not discover again.
 */
export async function ownRepositoryGitArgs(
  folder: string,
  projectRoot: string,
): Promise<{ top: string; args: string[]; unchanged: () => Promise<boolean> }> {
  const repository = await requireProjectRepository(folder, projectRoot);
  return {
    top: repository.top,
    args: ['-C', repository.top, ...repository.repoArgs],
    unchanged: repository.unchanged,
  };
}

export class ProjectRepositoryRefusedError extends Error {
  constructor(readonly reason: string) {
    super(
      `That folder's git repository is not the Project's own (${reason}), so Station does not run git in it`,
    );
    this.name = 'ProjectRepositoryRefusedError';
  }
}

/** The repository's own configuration sets `keys` Station does not run git
 * with (`git-repository-config.ts`); empty when it could not be read. */
export class RepositoryConfigRefusedError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(
      keys.length > 0
        ? `this repository's own configuration sets ${keys.join(', ')}`
        : "git could not read this repository's configuration",
    );
    this.name = 'RepositoryConfigRefusedError';
  }
}

/**
 * A repository opened for a write git must make in its own per-worktree
 * files (a checkout, a `worktree add`): see "WHAT A WRITE RUNS GIT WITH" in
 * the header. Its configuration was judged on the copy git then runs with.
 */
export interface LiveRepository {
  /** The work tree's root, symlink-resolved. */
  top: string;
  gitDir: string;
  commonDir: string;
  /** `--git-dir=<its own> --work-tree=<top>`, on every git call. */
  repoArgs: string[];
  /** `GIT_COMMON_DIR` naming the copy, as `env` on every git call. */
  env: { GIT_COMMON_DIR: string };
  /** See `ProjectRepositoryForRead`. Ask immediately before the write. */
  unchanged: () => Promise<boolean>;
  sameIdentity: () => Promise<boolean>;
  /** Removes the copy. After it, git must not be run with `env` again. */
  dispose: () => Promise<void>;
}

export type LiveRepositoryResult =
  | { ok: true; repository: LiveRepository }
  | Exclude<ProjectRepositoryForRead, { ok: true }>
  | Exclude<RepositorySnapshotResult, { ok: true }>;

export interface LiveRepositoryOptions extends ProjectRepositoryReadOptions {
  /**
   * The write creates a worktree: the folder's per-worktree configuration
   * is not carried, and the repository's `worktrees` directory is linked
   * (created first when the repository has none, before the repository is
   * checked, so the check sees it).
   */
  newWorktree?: boolean;
}

/**
 * Resolves `folder`'s repository as {@link resolveProjectRepositoryForRead}
 * does and opens it for a write. The caller disposes it.
 */
export async function openLiveRepository(
  projectRoot: string,
  folder: string,
  options: LiveRepositoryOptions = {},
): Promise<LiveRepositoryResult> {
  let repository = await resolveProjectRepositoryForRead(
    projectRoot,
    folder,
    options,
  );
  if (!repository.ok) return repository;
  if (
    options.newWorktree &&
    !(await exists(join(repository.commonDir, 'worktrees')))
  ) {
    // git creates it on the first `worktree add`; through the copy, that
    // would land in the copy. Created now, the check below records it.
    await mkdir(join(repository.commonDir, 'worktrees'));
    repository = await resolveProjectRepositoryForRead(
      projectRoot,
      folder,
      options,
    );
    if (!repository.ok) return repository;
  }
  const opened = await openRepositorySnapshot(repository, {
    timeoutMs: options.timeoutMs,
    scope: options.newWorktree ? 'new-worktree' : 'this-worktree',
  });
  if (!opened.ok) return opened;
  const { snapshot } = opened;
  const verdict = judgeRepositoryConfigEntries(snapshot.config, 'read');
  if (!verdict.ok) {
    await snapshot.dispose();
    return verdict.code === 'repository-config-refused'
      ? { ok: false, state: 'config-refused', keys: verdict.keys }
      : { ok: false, state: 'config-unreadable' };
  }
  try {
    // Reflogs land in the repository; so does a new worktree's entry.
    await snapshot.link(
      ['logs', ...(options.newWorktree ? ['worktrees'] : [])],
      false,
    );
  } catch {
    await snapshot.dispose();
    return {
      ok: false,
      state: 'refused',
      reason: '.git holds an entry Station could not link',
    };
  }
  return {
    ok: true,
    repository: {
      top: repository.top,
      gitDir: repository.gitDir,
      commonDir: repository.commonDir,
      repoArgs: snapshot.live.repoArgs,
      env: snapshot.live.env,
      unchanged: repository.unchanged,
      sameIdentity: repository.sameIdentity,
      dispose: snapshot.dispose,
    },
  };
}

/**
 * {@link openLiveRepository} for a caller with no request to answer, with
 * the path handling of {@link requireProjectRepository}: throws
 * {@link ProjectRepositoryRefusedError} or {@link RepositoryConfigRefusedError}.
 */
export async function requireLiveRepository(
  folder: string,
  projectRoot: string,
  options: Pick<LiveRepositoryOptions, 'newWorktree' | 'storage'> = {},
): Promise<LiveRepository> {
  let root: string;
  let target: string;
  try {
    root = await realpath(projectRoot);
    target = folder === projectRoot ? root : await realpath(folder);
  } catch {
    throw new ProjectRepositoryRefusedError('the folder does not exist');
  }
  const opened = await openLiveRepository(root, target, options);
  if (opened.ok) return opened.repository;
  switch (opened.state) {
    case 'config-refused':
      throw new RepositoryConfigRefusedError(opened.keys);
    case 'config-unreadable':
      throw new RepositoryConfigRefusedError([]);
    case 'refused':
      throw new ProjectRepositoryRefusedError(opened.reason);
    default:
      throw new ProjectRepositoryRefusedError('it is not in a git repository');
  }
}

/** The most bytes of a repository file Station copies for a read. */
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

/** Keys that are not carried into a snapshot's config. See the header. */
const NOT_CARRIED = [
  /^extensions\.worktreeconfig$/,
  /^core\.(?:worktree|bare)$/,
  /^include\./,
  /^includeif\./,
];

const CONFIG_NAME = /^[A-Za-z0-9-]+$/;

/**
 * Configuration text git parses back to exactly `entries`, or `null` when
 * an entry cannot be written (a key git itself would not have produced).
 * Every value is quoted, with the escapes git reads inside quotes, so no
 * value can end a line, open a section or start a comment.
 */
export function serializeRepositoryConfig(
  entries: readonly Pick<RepositoryConfigEntry, 'key' | 'value'>[],
): string | null {
  const lines: string[] = [];
  for (const { key, value } of entries) {
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    if (first <= 0 || last === key.length - 1) return null;
    const section = key.slice(0, first);
    const name = key.slice(last + 1);
    const subsection = first === last ? null : key.slice(first + 1, last);
    if (!CONFIG_NAME.test(section) || !CONFIG_NAME.test(name)) return null;
    if (subsection !== null && /[\n\0]/.test(subsection)) return null;
    if (value?.includes('\0')) return null;
    lines.push(
      subsection === null
        ? `[${section}]`
        : `[${section} "${subsection.replace(/[\\"]/g, '\\$&')}"]`,
    );
    lines.push(
      value === null
        ? `\t${name}`
        : `\t${name} = "${value
            .replace(/[\\"]/g, '\\$&')
            .replace(/\n/g, '\\n')
            .replace(/\t/g, '\\t')
            .replace(/[\b]/g, '\\b')}"`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** `git config --list --show-scope --show-origin -z`, parsed. */
function parseConfigListing(
  stdout: string,
): Array<RepositoryConfigEntry & { origin: string }> {
  const tokens = stdout.split('\0');
  const entries: Array<RepositoryConfigEntry & { origin: string }> = [];
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const record = tokens[index + 2];
    const newline = record.indexOf('\n');
    entries.push({
      scope: tokens[index],
      origin: tokens[index + 1],
      key: newline === -1 ? record : record.slice(0, newline),
      value: newline === -1 ? null : record.slice(newline + 1),
    });
  }
  return entries;
}

/** Links `target` at `path`; a file is copied where links need privilege. */
async function linkOrCopy(
  target: string,
  path: string,
  kind: 'dir' | 'file',
): Promise<void> {
  try {
    await symlink(target, path, kind === 'dir' ? 'junction' : 'file');
  } catch (error) {
    if (kind === 'dir') throw error;
    await copyFile(target, path);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A git directory Station owns, standing in for a repository's. */
export interface RepositorySnapshot {
  /** The copy itself. */
  dir: string;
  /** `--git-dir=<the copy> --work-tree=<top>`, for every git call. */
  repoArgs: string[];
  /**
   * For a write that git must make in the repository's own per-worktree
   * files (see the header): `--git-dir=<the repository's own> --work-tree`,
   * and the environment that makes the copy git's common directory. Both on
   * every git call.
   */
  live: { repoArgs: string[]; env: { GIT_COMMON_DIR: string } };
  /** The repository's own configuration, as carried into the copy. */
  config: RepositoryConfigEntry[];
  /**
   * Links directories of the common directory (named relative to it) into
   * the copy, so git reaches them through it: a checkpoint's refs and
   * their reflogs. With `create`, each is created in the repository first
   * when missing; without, a missing one is left out.
   */
  link: (names: readonly string[], create: boolean) => Promise<void>;
  dispose: () => Promise<void>;
}

export type RepositorySnapshotResult =
  | { ok: true; snapshot: RepositorySnapshot }
  /** The configuration includes a file from outside the repository. */
  | { ok: false; state: 'config-refused'; keys: string[] }
  | { ok: false; state: 'config-unreadable' }
  | { ok: false; state: 'refused'; reason: string };

export interface RepositorySnapshotOptions {
  /** Copy the index too (status and diff need it). */
  index?: boolean;
  timeoutMs?: number;
  /**
   * Which of the repository's configuration applies: the folder's own
   * worktree (its per-worktree configuration folded in; the default), or a
   * worktree about to be created, to which the folder's per-worktree
   * settings do not apply and are neither carried nor judged.
   */
  scope?: 'this-worktree' | 'new-worktree';
}

type ConfigListing = Array<RepositoryConfigEntry & { origin: string }>;

/**
 * Configuration listings by git directory, reused while every file they
 * came from (the config, the per-worktree config, each included file, and
 * HEAD, which an `includeIf "onbranch:"` reads) has the stamp it had. The
 * same reliance on change times as the directory listings in
 * `git-directory-confinement.ts`, with the same guard: nothing changed
 * within the last two seconds is remembered. It saves the one git process a
 * read would otherwise spend on `git config --list`.
 */
const configListings = new Map<
  string,
  { stamps: Map<string, string>; listing: ConfigListing }
>();
const MAX_CACHED_CONFIG_LISTINGS = 2_000;
const CONFIG_RACY_MS = 2_000;

/** For tests: forget every remembered configuration listing. */
export function forgetRepositoryConfigListings(): void {
  configListings.clear();
}

async function stampsNow(
  paths: Iterable<string>,
): Promise<Map<string, string>> {
  const stamps = new Map<string, string>();
  for (const path of paths) stamps.set(path, await fileStamp(path));
  return stamps;
}

/** Identity, size and change times, by `lstat`; `absent` when nothing is there. */
async function fileStamp(path: string): Promise<string> {
  try {
    const stats = await lstat(path, { bigint: true });
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch {
    return 'absent';
  }
}

async function changedWithin(path: string, ms: number): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return Date.now() - Math.max(stats.mtimeMs, stats.ctimeMs) < ms;
  } catch {
    return false;
  }
}

/**
 * The repository's own configuration as git lists it (`git config --list`,
 * which runs no filter, hook or helper), with the file each entry came
 * from; from the cache above when nothing it came from has changed.
 */
async function listRepositoryConfig(
  repository: Extract<ProjectRepositoryForRead, { ok: true }>,
  timeoutMs: number,
): Promise<ConfigListing | null> {
  const { top, gitDir, commonDir } = repository;
  const watched = [
    join(commonDir, 'config'),
    join(gitDir, 'config.worktree'),
    join(gitDir, 'HEAD'),
  ];
  const known = configListings.get(gitDir);
  if (known) {
    const now = await stampsNow(known.stamps.keys());
    if ([...known.stamps].every(([path, stamp]) => now.get(path) === stamp)) {
      return known.listing;
    }
    configListings.delete(gitDir);
  }
  let listing: ConfigListing;
  try {
    listing = parseConfigListing(
      (
        await execGit(
          [
            ...repository.repoArgs,
            'config',
            '--list',
            '--show-scope',
            '--show-origin',
            '-z',
          ],
          {
            cwd: top,
            encoding: 'utf-8',
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
          },
        )
      ).stdout,
    ).filter((entry) => entry.scope === 'local' || entry.scope === 'worktree');
  } catch (error) {
    if (timedOut(error)) throw error;
    return null;
  }
  const origins = new Set(watched);
  for (const entry of listing) {
    if (entry.origin.startsWith('file:')) {
      origins.add(resolve(top, entry.origin.slice('file:'.length)));
    }
  }
  const stamps = await stampsNow(origins);
  let racy = false;
  for (const path of origins) {
    if (await changedWithin(path, CONFIG_RACY_MS)) racy = true;
  }
  if (!racy) {
    if (configListings.size >= MAX_CACHED_CONFIG_LISTINGS) {
      const oldest = configListings.keys().next().value;
      if (oldest !== undefined) configListings.delete(oldest);
    }
    configListings.set(gitDir, { stamps, listing });
  }
  return listing;
}

/**
 * Builds the Station-owned git directory described in the header for a
 * repository {@link resolveProjectRepositoryForRead} admitted. The caller
 * judges `config` and must `dispose` it.
 */
export async function openRepositorySnapshot(
  repository: Extract<ProjectRepositoryForRead, { ok: true }>,
  options: RepositorySnapshotOptions = {},
): Promise<RepositorySnapshotResult> {
  const { top, gitDir, commonDir } = repository;
  // The one time git reads the repository's configuration for this read.
  const listed = await listRepositoryConfig(
    repository,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (listed === null) return { ok: false, state: 'config-unreadable' };
  const listing = listed.filter(
    (entry) =>
      entry.scope === 'local' ||
      (entry.scope === 'worktree' && options.scope !== 'new-worktree'),
  );
  // Every file the configuration came from is the repository's own: its
  // config, its per-worktree config, or a file an include names INSIDE the
  // work tree or the git directory. One from anywhere else would put a
  // file the member cannot read into the configuration git runs with.
  const origins = new Set(listing.map((entry) => entry.origin));
  for (const origin of origins) {
    let file: string | null = null;
    if (origin.startsWith('file:')) {
      try {
        file = await realpath(resolve(top, origin.slice('file:'.length)));
      } catch {
        file = null;
      }
    }
    if (
      !file ||
      !(within(file, top) || within(file, commonDir) || within(file, gitDir))
    ) {
      return { ok: false, state: 'config-refused', keys: ['include.path'] };
    }
  }
  const config = listing.map(({ scope, key, value }) => ({
    scope,
    key,
    value,
  }));
  const text = serializeRepositoryConfig(
    config.filter(
      (entry) =>
        !NOT_CARRIED.some((rule) => rule.test(entry.key.toLowerCase())),
    ),
  );
  if (text === null) return { ok: false, state: 'config-unreadable' };

  const dir = await mkdtemp(join(tmpdir(), 'station-git-read-'));
  const fail = async (reason: string): Promise<RepositorySnapshotResult> => {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, state: 'refused', reason };
  };
  try {
    const head = await readSmallRegularFile(join(gitDir, 'HEAD'), 4096);
    if (!head) return await fail('.git/HEAD is missing');
    await writeFile(join(dir, 'config'), text, { mode: 0o600 });
    await writeFile(join(dir, 'HEAD'), head);
    await linkOrCopy(join(commonDir, 'objects'), join(dir, 'objects'), 'dir');
    await linkOrCopy(join(commonDir, 'refs'), join(dir, 'refs'), 'dir');
    if (await exists(join(commonDir, 'reftable'))) {
      // A linked worktree keeps its own HEAD in its own reftable stack,
      // which a single directory cannot stand in for.
      if (gitDir !== commonDir) {
        return await fail(
          'it is a linked worktree of a repository that stores its refs as a reftable, which Station does not read',
        );
      }
      await linkOrCopy(
        join(commonDir, 'reftable'),
        join(dir, 'reftable'),
        'dir',
      );
    }
    for (const file of ['packed-refs', 'shallow']) {
      if (await exists(join(commonDir, file))) {
        await linkOrCopy(join(commonDir, file), join(dir, file), 'file');
      }
    }
    const exclude = await readSmallRegularFile(
      join(commonDir, 'info', 'exclude'),
      MAX_SNAPSHOT_FILE_BYTES,
    );
    if (exclude) {
      await mkdir(join(dir, 'info'));
      await writeFile(join(dir, 'info', 'exclude'), exclude);
    }
    if (options.index) {
      const index = join(gitDir, 'index');
      const stats = await lstat(index).catch(() => null);
      if (stats && !stats.isFile()) {
        return await fail('.git/index is not an ordinary file');
      }
      if (stats) {
        // A copy: git may refresh it, and the member's is never written.
        await copyFile(index, join(dir, 'index'), constants.COPYFILE_FICLONE);
        // With the index's own timestamp, not the copy's. git trusts an
        // entry's cached size and mtime unless the file was modified in the
        // same second the index was written (a "racy" entry, re-read by
        // content). A fresh copy is newer than every entry, so a file
        // rewritten to the same size within a second of the index landing
        // (a checkout, a commit, a `git add`) read as unchanged: measured on
        // APFS, 3 of 20 runs of the Changes read's own tests.
        await utimes(join(dir, 'index'), stats.atime, stats.mtime);
        // A split index names its shared half by file name beside it.
        for await (const entry of await opendir(gitDir)) {
          if (entry.isFile() && entry.name.startsWith('sharedindex.')) {
            await linkOrCopy(
              join(gitDir, entry.name),
              join(dir, entry.name),
              'file',
            );
          }
        }
      }
    }
  } catch {
    return await fail('.git holds a file Station could not copy');
  }
  return {
    ok: true,
    snapshot: {
      dir,
      repoArgs: [`--git-dir=${dir}`, `--work-tree=${top}`],
      live: {
        repoArgs: [`--git-dir=${gitDir}`, `--work-tree=${top}`],
        env: { GIT_COMMON_DIR: dir },
      },
      config,
      link: async (names, create) => {
        for (const name of names) {
          if (await exists(join(dir, name))) continue;
          if (create) await mkdir(join(commonDir, name), { recursive: true });
          else if (!(await exists(join(commonDir, name)))) continue;
          await mkdir(dirname(join(dir, name)), { recursive: true });
          await linkOrCopy(join(commonDir, name), join(dir, name), 'dir');
        }
      },
      dispose: () => rm(dir, { recursive: true, force: true }),
    },
  };
}

/** What a read runs git with. */
export interface ReadRepository {
  top: string;
  /** `--git-dir=… --work-tree=…`, to prefix every git call with. */
  repoArgs: string[];
}

/** Attempts before a repository that keeps changing is answered `busy`. */
const READ_ATTEMPTS = 4;
/** Pause before each further attempt, times the attempt's number. */
const READ_RETRY_PAUSE_MS = 40;

export type ProjectRepositoryRead<T> =
  | { ok: true; top: string; value: T }
  | { ok: false; state: 'not-a-repository' }
  | { ok: false; state: 'refused'; reason: string }
  /** The repository's own config sets `keys`, which Station does not run
   * git with (`git-repository-config.ts`), or could not be read at all. */
  | { ok: false; state: 'config-refused'; keys: string[] }
  | { ok: false; state: 'config-unreadable' }
  /** It kept changing while it was read. Not a refusal: try again. */
  | { ok: false; state: 'busy' };

/**
 * Runs `read` against a snapshot of the repository {@link
 * resolveProjectRepositoryForRead} admits, after judging the snapshot's
 * config, and returns its result only if the repository is unchanged
 * afterwards. A change (a commit landing, an object being written, or a
 * swapped `.git`) discards the result and reads again, a bounded number of
 * times; a repository that never holds still is `busy`. A `read` that
 * throws is treated the same way while the repository is changing, so a
 * failure caused by a swap is never reported in git's words. Every git call
 * `read` makes must carry the `repoArgs` it is given.
 */
export async function readProjectRepository<T>(
  projectRoot: string,
  folder: string,
  options: ProjectRepositoryReadOptions,
  read: (repository: ReadRepository) => Promise<T>,
): Promise<ProjectRepositoryRead<T>> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((done) =>
        setTimeout(done, READ_RETRY_PAUSE_MS * attempt),
      );
    }
    const repository = await resolveProjectRepositoryForRead(
      projectRoot,
      folder,
      { ...options, storage: 'read' },
    );
    if (!repository.ok) return repository;
    const opened = await openRepositorySnapshot(repository, {
      index: true,
      timeoutMs: options.timeoutMs,
    });
    if (!opened.ok) {
      // A refusal reached while the repository was changing may be the
      // change's doing (a half-written config); look again first.
      if (!(await repository.unchanged())) continue;
      return opened;
    }
    const { snapshot } = opened;
    let outcome: { value: T } | { error: unknown };
    try {
      const verdict = judgeRepositoryConfigEntries(snapshot.config, 'read');
      if (!verdict.ok) {
        if (!(await repository.unchanged())) continue;
        return verdict.code === 'repository-config-refused'
          ? { ok: false, state: 'config-refused', keys: verdict.keys }
          : { ok: false, state: 'config-unreadable' };
      }
      outcome = {
        value: await read({ top: repository.top, repoArgs: snapshot.repoArgs }),
      };
    } catch (error) {
      outcome = { error };
    } finally {
      await snapshot.dispose();
    }
    if (!(await repository.unchanged())) continue;
    if ('error' in outcome) throw outcome.error;
    return { ok: true, top: repository.top, value: outcome.value };
  }
  return { ok: false, state: 'busy' };
}
