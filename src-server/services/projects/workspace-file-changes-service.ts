import { relative, sep } from 'node:path';
import {
  WORKSPACE_FILE_CHANGES_MAX_BYTES,
  type WorkspaceFileChanges,
} from '@kontourai/station-contracts/workspace-file-preview';
import { execGit } from '../../utils/git-exec.js';
import {
  type ReadRepository,
  readProjectRepository,
} from './git-read-repository.js';
import type { WorkspaceFilePreviewService } from './workspace-file-preview-service.js';

/** Discovery and the ref check; `git diff` reads the whole file. */
const GIT_QUICK_TIMEOUT_MS = 10_000;
const GIT_DIFF_TIMEOUT_MS = 30_000;
/**
 * Changes reads computing at once for one workspace. The File Preview asks
 * for a file's changes as it opens (for the Changes pip), so switching files
 * quickly would otherwise start one `git diff` per file; beyond this they
 * queue. Identical in-flight requests share one read.
 */
export const WORKSPACE_FILE_CHANGES_CONCURRENCY = 2;

/**
 * What one read answers: a result the pane renders, or `busy`, which is not
 * a result. The repository was being changed each time Station read it (a
 * commit landing, or a `.git` swapped under the read), and a read is only
 * answered from a repository that held still; the route says so with a
 * retryable status, never as a refusal.
 */
export type WorkspaceFileChangesRead = WorkspaceFileChanges | { state: 'busy' };

/** The read of a Project repository the shared resolver performs. */
type ReadRepositoryFn = typeof readProjectRepository;

function exceededBuffer(error: unknown): boolean {
  return (
    error instanceof Error &&
    /maxBuffer/i.test(`${error.message} ${(error as { code?: unknown }).code}`)
  );
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
 * discover from it is not trusted (#2363). Which repository may be read for
 * it, and what git runs with, is the shared resolver's decision
 * (`git-read-repository.ts`, as the coding status, log and diff routes use
 * it): one discovery from the file's folder, checked against the Project's
 * root; git run on a Station-owned git directory built from a judged copy of
 * the repository's configuration; the output discarded, and the read
 * repeated, when the repository changed under it. This service only names
 * the file and reads its diff with the arguments it is handed.
 */
export class WorkspaceFileChangesService {
  private readonly inFlight = new Map<
    string,
    Promise<WorkspaceFileChangesRead | null>
  >();
  private readonly limiter = new KeyedLimiter(
    WORKSPACE_FILE_CHANGES_CONCURRENCY,
  );

  constructor(
    private readonly preview: Pick<
      WorkspaceFilePreviewService,
      'changesTarget'
    >,
    private readonly readRepository: ReadRepositoryFn = readProjectRepository,
  ) {}

  /**
   * Throws on a path the preview would refuse (the route answers 400) and
   * on a git failure the resolver does not classify, including a deadline
   * (504).
   */
  changes(
    workingDirectory: string,
    path: string,
  ): Promise<WorkspaceFileChangesRead | null> {
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
  }: ChangesLocation): Promise<WorkspaceFileChangesRead> {
    const outcome = await this.readRepository(
      root,
      existingAncestor,
      { timeoutMs: GIT_QUICK_TIMEOUT_MS },
      (repository) => diffAgainstHead(repository, target),
    );
    if (outcome.ok) return outcome.value;
    switch (outcome.state) {
      case 'not-a-repository':
        return { state: 'not-a-repository' };
      case 'refused':
        return {
          state: 'refused',
          reason: `This file's git directory is not the Project's own (${outcome.reason}), so Station does not read it.`,
        };
      case 'config-refused':
        return {
          state: 'refused',
          reason: `This repository's own configuration sets ${outcome.keys.join(', ')}, which Station does not run git with, so it does not diff this file.`,
        };
      case 'config-unreadable':
        return {
          state: 'refused',
          reason: "git could not read this repository's configuration.",
        };
      default:
        return { state: 'busy' };
    }
  }
}

/**
 * The file's patch against HEAD, every call carrying the resolver's
 * `repoArgs` so git discovers nothing itself. `target` is inside `top`: the
 * resolver admits a folder only as part of the work tree it reports.
 */
async function diffAgainstHead(
  { top, repoArgs }: ReadRepository,
  target: string,
): Promise<WorkspaceFileChanges> {
  const git = async (args: string[], maxBuffer?: number) =>
    (
      await execGit([...repoArgs, ...args], {
        cwd: top,
        encoding: 'utf-8',
        timeout:
          args[0] === 'diff' ? GIT_DIFF_TIMEOUT_MS : GIT_QUICK_TIMEOUT_MS,
        ...(maxBuffer ? { maxBuffer } : {}),
      })
    ).stdout;
  try {
    await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  } catch (error) {
    if (gitTimedOut(error)) throw error;
    return { state: 'no-commits' };
  }
  // `top` and `literal`: the path is the file's own name from the
  // repository root, never a glob a file name could smuggle in.
  const pathspec = `:(top,literal)${relative(top, target).split(sep).join('/')}`;
  let patch: string;
  try {
    patch = await git(
      ['diff', '--no-color', 'HEAD', '--', pathspec],
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
  const untracked = await git(['ls-files', '--others', '--', pathspec]);
  return untracked.trim()
    ? { state: 'untracked' }
    : { state: 'unchanged', base: 'HEAD' };
}
