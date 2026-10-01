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
 * WHAT A SWAP CAN STILL DO, and what closes it. The arguments name a PATH,
 * and git opens it when it runs. A member can swap `.git` (or plant an
 * entry inside it) after the check and put it back afterwards. git has no
 * way to be handed an already-opened directory, so the check cannot be made
 * atomic with the read. Instead {@link readProjectRepository} checks again
 * AFTER the read and discards the output unless the `.git` entry, every
 * directory the check listed, and the `commondir` pointer have the same
 * identity and change times as before (the guard's `fingerprint`). A rename
 * changes the renamed entry's change time and its directory's, and a change
 * time cannot be set back, so swap-and-restore is noticed too. What that
 * leaves:
 * - a swap-and-restore that completes within one tick of the file system's
 *   change-time clock, around the read. The tick is nanoseconds on APFS and
 *   up to a few milliseconds where Linux stamps files from its coarse
 *   clock; a check-read-check spans several git processes and outlasts
 *   that in practice, which is an observation, not a proof;
 * - content a member can reach WITHOUT a link, such as a hard link to
 *   another repository's object file. That takes an account that can
 *   already read that file.
 */
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { execGit } from '../../utils/git-exec.js';
import { gitDirectoryInsideProject } from './git-directory-confinement.js';

export type ProjectRepositoryForRead =
  | {
      ok: true;
      /** The work tree's root, symlink-resolved. Run git here. */
      top: string;
      /** `--git-dir=… --work-tree=…`, to prefix every git call with. */
      repoArgs: string[];
      /**
       * Whether what was checked is still what is there. Ask after the last
       * git call and discard the output on `false`.
       */
      unchanged: () => Promise<boolean>;
    }
  | { ok: false; state: 'not-a-repository' }
  /** `reason` names entries relative to `.git`, never a host path. */
  | { ok: false; state: 'refused'; reason: string };

export interface ProjectRepositoryReadOptions {
  /**
   * The verified worktrees of the Project's repository (session worktrees
   * and the main checkout), symlink-resolved. Asked for only when the
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
  | { found: true; top: string; gitDir: string }
  | { found: false; unparseable: boolean };

/**
 * What git discovers from `cwd`: the work tree's root and its git
 * directory, from one `rev-parse`, each symlink-resolved. Not found when
 * git finds no work tree there (not a repository, a bare one, a folder
 * inside `.git`). `rev-parse` cannot NUL-terminate paths, so anything but
 * exactly two lines (a path holding a line break) is `unparseable` and is
 * never guessed at.
 */
async function discover(cwd: string, timeoutMs: number): Promise<Discovery> {
  let stdout: string;
  try {
    ({ stdout } = await execGit(
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir'],
      { cwd, encoding: 'utf-8', timeout: timeoutMs },
    ));
  } catch (error) {
    if (timedOut(error)) throw error;
    return { found: false, unparseable: false };
  }
  const lines = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== 2) return { found: false, unparseable: true };
  try {
    return {
      found: true,
      top: await realpath(lines[0]),
      gitDir: await realpath(lines[1]),
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
  found: { top: string; gitDir: string },
  projectRoot: string,
  alsoMemberWritable: readonly string[],
): Promise<ProjectRepositoryForRead> {
  const check = () =>
    gitDirectoryInsideProject(found.top, projectRoot, alsoMemberWritable);
  const verdict = await check();
  if (verdict.verdict === 'outside') return refused(verdict.reason);
  if (verdict.gitDir !== found.gitDir) {
    return refused('.git changed while Station was checking it');
  }
  return {
    ok: true,
    top: found.top,
    repoArgs: [`--git-dir=${found.gitDir}`, `--work-tree=${found.top}`],
    unchanged: async () => {
      const after = await check();
      return (
        after.verdict === verdict.verdict &&
        after.gitDir === verdict.gitDir &&
        after.commonDir === verdict.commonDir &&
        after.fingerprint === verdict.fingerprint
      );
    },
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
 *   the same checks (the worktree is member-writable too), and only when
 *   the Project's own repository passes them.
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
      confirmed.gitDir !== found.gitDir
    ) {
      return refused('its git directory names a work tree above this Project');
    }
    return {
      ok: true,
      top,
      repoArgs: [`--git-dir=${found.gitDir}`, `--work-tree=${top}`],
      // Above the Project: not a place a member writes.
      unchanged: async () => true,
    };
  }
  const worktrees = (await options.registeredWorktrees?.()) ?? [];
  // Only the worktree's root: a repository nested in a session worktree is
  // not the Project's.
  if (!worktrees.includes(top)) return NOT_A_REPOSITORY;
  // "Registered" is what git reports from the Project's folder, so it is
  // only as good as the Project's own repository: a `.git` planted at the
  // Project's root would register another repository's checkouts.
  const project = await resolveProjectRepositoryForRead(
    projectRoot,
    projectRoot,
    { timeoutMs },
  );
  if (!project.ok) return project;
  return confined(found, projectRoot, [top]);
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
 * failure caused by a swap is never reported in git's words.
 */
export async function readProjectRepository<T>(
  projectRoot: string,
  folder: string,
  options: ProjectRepositoryReadOptions,
  read: (repository: { top: string; repoArgs: string[] }) => Promise<T>,
): Promise<ProjectRepositoryRead<T>> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const repository = await resolveProjectRepositoryForRead(
      projectRoot,
      folder,
      options,
    );
    if (!repository.ok) return repository;
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await read(repository) };
    } catch (error) {
      outcome = { error };
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
