/**
 * Which repository a git READ (status, log, diff, branches, the repository
 * listing, a file's changes) may act on for a folder of a Project.
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
 * tree starts, checked, and handed back as explicit `--git-dir`/
 * `--work-tree` arguments for every later call: git never discovers again,
 * so a `.git` swapped after the check is not followed by a second lookup.
 *
 * WHAT A SWAP CAN STILL DO, and what narrows it. The arguments name a PATH,
 * and git opens it when it runs. A member can swap `.git`, or a folder above
 * the repository, after the check and put it back afterwards. git cannot be
 * handed an already-opened directory, so the check cannot be made atomic
 * with the command.
 *
 * For a READ, {@link readProjectRepository} checks again afterwards and
 * discards the output unless everything the check looked at has the same
 * identity and change times as before (the guard's `unchanged`: the folders
 * down to the repository, the `.git` entry, every directory listed, and the
 * files that steer git). What that leaves:
 * - a swap-and-restore that the file system's change times do not record.
 *   A rename updates the renamed entry's change time on APFS, ext4, XFS and
 *   Btrfs, and the containing folder's times everywhere; the folder the
 *   repository sits DIRECTLY in the member-writable root is watched by its
 *   own change time alone, because the root's times change whenever
 *   anything is created in it. The clock's tick is nanoseconds on APFS and
 *   up to a few milliseconds where Linux stamps files from its coarse
 *   clock; a check-read-check spans several git processes and outlasts
 *   that in practice, which is an observation, not a proof;
 * - content a member can reach WITHOUT a link, such as a hard link to
 *   another repository's object file. That takes an account that can
 *   already read that file.
 *
 * For a WRITE (checkout) there is nothing to discard. The check is repeated
 * immediately before git starts and the identity of what was checked is
 * compared afterwards, which reports a swap but cannot undo it.
 *
 * WHAT A READ RUNS. A repository's config can name programs (a clean filter,
 * a diff driver), and config can be rewritten in place between Station
 * judging it and git reading it. So a read does not read the repository's
 * config at all: {@link readProjectRepository} copies it ONCE into a
 * directory Station owns, has git use that directory as the repository's
 * common directory (`GIT_COMMON_DIR`, with `objects` and `refs` linked
 * back), and the judgement and every git call of the read see those same
 * bytes. `info/attributes` is not carried over, per-worktree config is
 * folded into the copy, and in-tree `.gitattributes` can only select a
 * filter or driver that the copy does not define.
 */
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
import { gitDirectoryInsideProject } from './git-directory-confinement.js';

export type ProjectRepositoryForRead =
  | {
      ok: true;
      /** The work tree's root, symlink-resolved. Run git here. */
      top: string;
      /** `--git-dir=… --work-tree=…`, to prefix every git call with. */
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
   * (which trusts the Project's repository only when it is its own). Asked for only when the
   * folder's work tree is neither inside the Project nor above it. Absent:
   * there are none.
   */
  registeredWorktrees?: () => Promise<readonly string[]>;
  /** Deadline for each discovery call. A deadline throws; it is not "no". */
  timeoutMs?: number;
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
 * and its common directory, from one `rev-parse`, each symlink-resolved. Not found when
 * git finds no work tree there (not a repository, a bare one, a folder
 * inside `.git`). `rev-parse` cannot NUL-terminate paths, so anything but
 * exactly three lines (a path holding a line break) is `unparseable` and is
 * never guessed at.
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
): Promise<ProjectRepositoryForRead> {
  const verdict = await gitDirectoryInsideProject(found.top, projectRoot, {
    alsoMemberWritable,
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
 * The repository a read of `folder` may act on, or why there is none.
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
    return confined(found, projectRoot, []);
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
  return confined(found, projectRoot, [top]);
}

/**
 * The Project's own repository at `folder`, or a refusal, for a caller that
 * is about to run git there and has no request to answer: the repository
 * git would discover from a member-writable folder is not trusted (a `.git`
 * file there can name any repository on this computer). `projectRoot`
 * defaults to the folder itself, for callers given a Project's working
 * directory. Both are resolved through symlinks here.
 */
export async function requireProjectRepository(
  folder: string,
  projectRoot: string = folder,
): Promise<Extract<ProjectRepositoryForRead, { ok: true }>> {
  let root: string;
  let target: string;
  try {
    root = await realpath(projectRoot);
    target = folder === projectRoot ? root : await realpath(folder);
  } catch {
    throw new ProjectRepositoryRefusedError('the folder does not exist');
  }
  const repository = await resolveProjectRepositoryForRead(root, target);
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
  projectRoot: string = folder,
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

/** The most bytes of a repository file Station copies for a read. */
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;

/**
 * The bytes of a regular file, opened without following a link, or `null`
 * when it is absent. Anything else (a link, a directory, an oversized
 * file) throws: it is not copied and not guessed at.
 */
async function regularFileBytes(path: string): Promise<Buffer | null> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw new Error('not a regular file of a size Station copies');
  }
  const handle = await open(path, 'r');
  try {
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error('not a regular file of a size Station copies');
    }
    return bytes;
  } finally {
    await handle.close();
  }
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

/**
 * A common directory Station owns, standing in for the repository's during
 * one read (see WHAT A READ RUNS in the header). `null` when the
 * repository's config cannot be copied as it stands.
 */
async function snapshotCommonDirectory(repository: {
  gitDir: string;
  commonDir: string;
}): Promise<{ dir: string; env: NodeJS.ProcessEnv } | null> {
  const { gitDir, commonDir } = repository;
  const dir = await mkdtemp(join(tmpdir(), 'station-git-read-'));
  try {
    const config = await regularFileBytes(join(commonDir, 'config'));
    if (!config) throw new Error('no config');
    // Per-worktree config is read from the git directory only when the
    // config enables it; folded in here so git reads nothing later.
    const worktreeConfig = /worktreeconfig/i.test(config.toString('latin1'))
      ? await regularFileBytes(join(gitDir, 'config.worktree'))
      : null;
    await writeFile(
      join(dir, 'config'),
      worktreeConfig
        ? Buffer.concat([
            config,
            Buffer.from('\n'),
            worktreeConfig,
            Buffer.from('\n[extensions]\n\tworktreeConfig = false\n'),
          ])
        : config,
      { mode: 0o600 },
    );
    await linkOrCopy(join(commonDir, 'objects'), join(dir, 'objects'), 'dir');
    await linkOrCopy(join(commonDir, 'refs'), join(dir, 'refs'), 'dir');
    if (await exists(join(commonDir, 'reftable'))) {
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
    const exclude = await regularFileBytes(join(commonDir, 'info', 'exclude'));
    if (exclude) {
      await mkdir(join(dir, 'info'));
      await writeFile(join(dir, 'info', 'exclude'), exclude);
    }
    return { dir, env: { GIT_COMMON_DIR: dir } };
  } catch {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
}

/** What a read runs git with. */
export interface ReadRepository {
  top: string;
  /** `--git-dir=… --work-tree=…`, to prefix every git call with. */
  repoArgs: string[];
  /** The environment every git call of the read must carry. */
  repoEnv: NodeJS.ProcessEnv;
}

/** Attempts before a repository that keeps changing is refused. */
const READ_ATTEMPTS = 3;

export type ProjectRepositoryRead<T> =
  | { ok: true; top: string; value: T }
  | { ok: false; state: 'not-a-repository' }
  | { ok: false; state: 'refused'; reason: string };

/**
 * Runs `read` against the repository {@link resolveProjectRepositoryForRead}
 * admits, and returns its result only if the repository is unchanged
 * afterwards. A change (a commit landing, git refreshing its own index, or
 * a swapped `.git`) discards the result and reads again, a bounded number
 * of times; a repository that never holds still is refused. A `read` that
 * throws is treated the same way while the repository is changing, so a
 * failure caused by a swap is never reported in git's words. Every git call
 * `read` makes must carry `repoArgs` AND `repoEnv`: the environment is what
 * keeps git on the copied config (see WHAT A READ RUNS in the header).
 */
export async function readProjectRepository<T>(
  projectRoot: string,
  folder: string,
  options: ProjectRepositoryReadOptions,
  read: (repository: ReadRepository) => Promise<T>,
): Promise<ProjectRepositoryRead<T>> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const repository = await resolveProjectRepositoryForRead(
      projectRoot,
      folder,
      options,
    );
    if (!repository.ok) return repository;
    const snapshot = await snapshotCommonDirectory(repository);
    if (!snapshot) {
      return {
        ok: false,
        state: 'refused',
        reason: '.git/config or .git/info/exclude is not an ordinary file',
      };
    }
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = {
        value: await read({
          top: repository.top,
          repoArgs: repository.repoArgs,
          repoEnv: snapshot.env,
        }),
      };
    } catch (error) {
      outcome = { error };
    } finally {
      await rm(snapshot.dir, { recursive: true, force: true });
    }
    if (!(await repository.unchanged())) continue;
    if ('error' in outcome) throw outcome.error;
    return { ok: true, top: repository.top, value: outcome.value };
  }
  return {
    ok: false,
    state: 'refused',
    reason: '.git kept changing while Station read it',
  };
}
