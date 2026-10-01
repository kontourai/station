import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import {
  WORKSPACE_FILE_CHANGES_MAX_BYTES,
  type WorkspaceFileChanges,
} from '@kontourai/station-contracts/workspace-file-preview';
import { execGit } from '../../utils/git-exec.js';
import { gitDirectoryInsideProject } from './git-directory-confinement.js';
import { checkRepositoryConfig } from './git-repository-config.js';
import type { WorkspaceFilePreviewService } from './workspace-file-preview-service.js';

const GIT_QUICK_TIMEOUT_MS = 10_000;
const GIT_DIFF_TIMEOUT_MS = 30_000;
/**
 * Changes reads computing at once for one workspace. The File Preview asks
 * for a file's changes as it opens (for the Changes pip), so switching files
 * quickly would otherwise start one `git diff` per file; beyond this they
 * queue. Identical in-flight requests share one read.
 */
export const WORKSPACE_FILE_CHANGES_CONCURRENCY = 2;

type GitRunner = (
  args: string[],
  cwd: string,
  maxBuffer?: number,
) => Promise<string>;

const defaultRunner: GitRunner = async (args, cwd, maxBuffer) =>
  (
    await execGit(args, {
      cwd,
      encoding: 'utf-8',
      timeout: args.includes('diff')
        ? GIT_DIFF_TIMEOUT_MS
        : GIT_QUICK_TIMEOUT_MS,
      ...(maxBuffer ? { maxBuffer } : {}),
    })
  ).stdout;

function exceededBuffer(error: unknown): boolean {
  return (
    error instanceof Error &&
    /maxBuffer/i.test(`${error.message} ${(error as { code?: unknown }).code}`)
  );
}

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  return typeof stderr === 'string' ? stderr : '';
}

/** `execFile`-style deadline kill, as the coding routes classify it. */
export function gitTimedOut(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown };
  return failure?.killed === true || failure?.signal === 'SIGTERM';
}

/** A small FIFO semaphore per key. */
class KeyedLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  constructor(private readonly limit: number) {}
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    if ((this.active.get(key) ?? 0) >= this.limit)
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(key) ?? [];
        queue.push(resolve);
        this.waiting.set(key, queue);
      });
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const left = (this.active.get(key) ?? 1) - 1;
      if (left) this.active.set(key, left);
      else this.active.delete(key);
      const queue = this.waiting.get(key);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.waiting.delete(key);
      next?.();
    }
  }
}

interface ChangesLocation {
  root: string;
  target: string;
  existingAncestor: string;
}

/**
 * One previewed file's changes against HEAD, for the File Preview's Changes
 * view.
 *
 * The file's folder is member-writable, so the repository git would
 * discover from it is not trusted (#2363): a `.git` FILE can name another
 * repository's git directory, a `.git` can be a symbolic link, and a git
 * directory's `objects/info/alternates` can borrow another repository's
 * objects. Only discovery runs before the check. A repository found inside
 * the preview's root must have its git directory and common directory
 * inside that root too (or be a genuine linked worktree of it), with no
 * redirected entries: the verdict Commit and Push require
 * (`gitDirectoryInsideProject`). A repository that CONTAINS the root from
 * above, which the coding diff route also reads, is outside the
 * member-written area. Every later call names the resolved git directory
 * explicitly, so git does not discover again. The repository-config read
 * refusal then applies before `git diff` runs, with `--no-ext-diff` and
 * `--no-textconv`.
 */
export class WorkspaceFileChangesService {
  private readonly inFlight = new Map<
    string,
    Promise<WorkspaceFileChanges | null>
  >();
  private readonly limiter = new KeyedLimiter(
    WORKSPACE_FILE_CHANGES_CONCURRENCY,
  );

  constructor(
    private readonly preview: Pick<
      WorkspaceFilePreviewService,
      'changesTarget'
    >,
    private readonly git: GitRunner = defaultRunner,
    private readonly checkConfig: typeof checkRepositoryConfig = checkRepositoryConfig,
    private readonly confine: typeof gitDirectoryInsideProject = gitDirectoryInsideProject,
  ) {}

  /**
   * Throws on a path the preview would refuse (the route answers 400) and
   * on a git failure it cannot classify, including a deadline (504).
   */
  changes(
    workingDirectory: string,
    path: string,
  ): Promise<WorkspaceFileChanges | null> {
    // Path validation runs per request, before any sharing, so a refused
    // path is refused for every caller that sends it.
    const located = this.preview.changesTarget(workingDirectory, path);
    if (!located) return Promise.resolve(null);
    const key = `${located.root}\0${located.target}`;
    const shared = this.inFlight.get(key);
    if (shared) return shared;
    const read = this.limiter
      .run(located.root, () => this.read(located))
      .finally(() => {
        if (this.inFlight.get(key) === read) this.inFlight.delete(key);
      });
    this.inFlight.set(key, read);
    return read;
  }

  private async read({
    root,
    target,
    existingAncestor,
  }: ChangesLocation): Promise<WorkspaceFileChanges> {
    let top: string;
    let discoveredGitDir: string;
    try {
      // Discovery only: where the work tree starts, and which git directory
      // claimed it.
      const [rawTop, rawGitDir] = (
        await this.git(
          [
            'rev-parse',
            '--path-format=absolute',
            '--show-toplevel',
            '--git-dir',
          ],
          existingAncestor,
        )
      )
        .trim()
        .split('\n');
      top = await realpath(rawTop ?? '');
      discoveredGitDir = await realpath(rawGitDir ?? '');
    } catch (error) {
      if (gitTimedOut(error)) throw error;
      const stderr = stderrOf(error);
      if (/dubious ownership/i.test(stderr))
        return {
          state: 'refused',
          reason:
            'git refused this repository because another user owns it (safe.directory), so Station does not read it.',
        };
      if (/not a git repository/i.test(stderr))
        return { state: 'not-a-repository' };
      throw error;
    }
    const insideRoot = top === root || top.startsWith(root + sep);
    const aboveRoot = root.startsWith(top + sep);
    if (!insideRoot && !aboveRoot) return { state: 'not-a-repository' };
    if (aboveRoot) {
      // "Above" is only trusted when the folder above says so itself. A
      // member-written git directory inside the root can set `core.worktree`
      // to a folder above it, which would steer discovery here past the
      // confinement check and pair the operator's repository with the wrong
      // work tree.
      const gitDirInsideRoot =
        discoveredGitDir === root || discoveredGitDir.startsWith(root + sep);
      let confirmedTop: string | null = null;
      if (!gitDirInsideRoot) {
        try {
          confirmedTop = await realpath(
            (await this.git(['rev-parse', '--show-toplevel'], top)).trim(),
          );
        } catch (error) {
          if (gitTimedOut(error)) throw error;
        }
      }
      if (confirmedTop !== top)
        return {
          state: 'refused',
          reason:
            "This file's git directory claims a work tree outside the Project, so Station does not read it.",
        };
    }
    let gitDir: string;
    try {
      if (insideRoot) {
        const verdict = await this.confine(top, root);
        if (verdict.verdict === 'outside')
          return {
            state: 'refused',
            reason: `This file's git directory is not the Project's own (${verdict.reason}), so Station does not read it.`,
          };
      }
      gitDir = await realpath(
        (
          await this.git(
            ['rev-parse', '--path-format=absolute', '--git-dir'],
            top,
          )
        ).trim(),
      );
    } catch (error) {
      if (gitTimedOut(error)) throw error;
      return {
        state: 'refused',
        reason:
          'git could not locate this repository, so Station does not read it.',
      };
    }
    const repo = [`--git-dir=${gitDir}`, `--work-tree=${top}`];
    const fromTop = relative(top, target);
    if (!fromTop || fromTop.startsWith(`..${sep}`) || fromTop === '..')
      return { state: 'not-a-repository' };
    const verdict = await this.checkConfig(top, 'read', repo);
    if (!verdict.ok)
      return {
        state: 'refused',
        reason:
          verdict.code === 'repository-config-refused'
            ? `This repository's own configuration defines programs git diff would run (${verdict.keys.join(', ')}), so Station does not diff it.`
            : "git could not read this repository's configuration.",
      };
    try {
      await this.git(
        [...repo, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
        top,
      );
    } catch (error) {
      if (gitTimedOut(error)) throw error;
      return { state: 'no-commits' };
    }
    // `top` and `literal`: the path is the file's own name from the
    // repository root, never a glob a file name could smuggle in.
    const pathspec = `:(top,literal)${fromTop.split(sep).join('/')}`;
    let patch: string;
    try {
      patch = await this.git(
        [
          ...repo,
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          'HEAD',
          '--',
          pathspec,
        ],
        top,
        WORKSPACE_FILE_CHANGES_MAX_BYTES + 1,
      );
    } catch (error) {
      if (exceededBuffer(error))
        return {
          state: 'oversized',
          limitBytes: WORKSPACE_FILE_CHANGES_MAX_BYTES,
        };
      throw error;
    }
    if (Buffer.byteLength(patch, 'utf8') > WORKSPACE_FILE_CHANGES_MAX_BYTES)
      return {
        state: 'oversized',
        limitBytes: WORKSPACE_FILE_CHANGES_MAX_BYTES,
      };
    if (patch.trim()) return { state: 'changed', base: 'HEAD', patch };
    const untracked = await this.git(
      [...repo, 'ls-files', '--others', '--', pathspec],
      top,
    );
    return untracked.trim()
      ? { state: 'untracked' }
      : { state: 'unchanged', base: 'HEAD' };
  }
}
