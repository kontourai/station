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
export type WorkspaceFileChangesRead =
  | WorkspaceFileChanges
  | { state: 'busy' }
  /** Neither tracked, in HEAD, nor present: nothing to compare. */
  | { state: 'not-found' };

/** The read of a Project repository the shared resolver performs. */
type ReadRepositoryFn = typeof readProjectRepository;

function exceededBuffer(error: unknown): boolean {
  return (
    error instanceof Error &&
    /maxBuffer/i.test(`${error.message} ${(error as { code?: unknown }).code}`)
  );
}

/** `execFile`-style deadline kill, as the coding routes classify it. */
function gitTimedOut(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown };
  return failure?.killed === true || failure?.signal === 'SIGTERM';
}

/**
 * Reads waiting for a turn on one workspace beyond the cap. The File
 * Preview asks once per opened file, so a deeper queue is a scroll through
 * files that nobody is waiting for any more; past this the route answers
 * busy and the pane asks again when its reader comes back.
 */
export const WORKSPACE_FILE_CHANGES_MAX_QUEUE = 8;

/** The workspace's queue is full: the route answers `repository-busy`. */
export class WorkspaceFileChangesQueueFullError extends Error {
  constructor() {
    super('Too many Changes reads are waiting on this workspace');
    this.name = 'WorkspaceFileChangesQueueFullError';
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('The read was aborted', 'AbortError')
  );
}

/**
 * A small FIFO semaphore per key, with a bounded queue. A waiter whose
 * signal aborts leaves the queue at once (and never runs its task); one
 * that arrives at a full queue is refused.
 */
class KeyedLimiter {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, Array<() => void>>();
  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}
  async run<T>(
    key: string,
    task: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) throw abortReason(signal);
    if ((this.active.get(key) ?? 0) >= this.limit) {
      const queue = this.waiting.get(key) ?? [];
      if (queue.length >= this.maxQueue) {
        throw new WorkspaceFileChangesQueueFullError();
      }
      await new Promise<void>((resolve, reject) => {
        const turn = () => {
          signal.removeEventListener('abort', leave);
          resolve();
        };
        const leave = () => {
          const index = queue.indexOf(turn);
          if (index !== -1) queue.splice(index, 1);
          if (queue.length === 0 && this.waiting.get(key) === queue) {
            this.waiting.delete(key);
          }
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', leave, { once: true });
        queue.push(turn);
        this.waiting.set(key, queue);
      });
    }
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

/**
 * One read in flight for a file, shared by every request for it. The read
 * is given up (its turn in the queue abandoned) only when every request
 * that asked for it has gone; a read that already runs completes, so a
 * late joiner is answered from it.
 */
interface InFlightRead {
  promise: Promise<WorkspaceFileChangesRead>;
  interested: number;
  controller: AbortController;
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
  private readonly inFlight = new Map<string, InFlightRead>();
  private readonly limiter = new KeyedLimiter(
    WORKSPACE_FILE_CHANGES_CONCURRENCY,
    WORKSPACE_FILE_CHANGES_MAX_QUEUE,
  );

  constructor(
    private readonly preview: Pick<
      WorkspaceFilePreviewService,
      'changesTarget'
    >,
    private readonly readRepository: ReadRepositoryFn = readProjectRepository,
  ) {}

  /**
   * Throws on a path the preview would refuse (the route answers 400), on
   * a full queue (`WorkspaceFileChangesQueueFullError`, 503), when
   * `signal` aborts before the read is answered (its reason), and on a git
   * failure the resolver does not classify, including a deadline (504).
   */
  changes(
    workingDirectory: string,
    path: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<WorkspaceFileChangesRead | null> {
    // Path validation runs per request, before any sharing, so a refused
    // path is refused for every caller that sends it.
    const located = this.preview.changesTarget(workingDirectory, path);
    if (!located) return Promise.resolve(null);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const key = `${located.root}\0${located.target}`;
    let entry = this.inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const started: InFlightRead = {
        controller,
        interested: 0,
        promise: this.limiter
          .run(located.root, () => this.read(located), controller.signal)
          .finally(() => {
            if (this.inFlight.get(key) === started) this.inFlight.delete(key);
          }),
      };
      // Every requester attaches its own handlers below; a read nobody is
      // left waiting for still settles, and must not be an unhandled one.
      started.promise.catch(() => undefined);
      this.inFlight.set(key, started);
      entry = started;
    }
    return this.join(entry, signal);
  }

  /** `entry`'s answer, or `signal`'s reason first; see `InFlightRead`. */
  private join(
    entry: InFlightRead,
    signal: AbortSignal | undefined,
  ): Promise<WorkspaceFileChangesRead> {
    entry.interested += 1;
    if (!signal) return entry.promise;
    return new Promise((resolve, reject) => {
      const leave = () => {
        entry.interested -= 1;
        if (entry.interested === 0) entry.controller.abort(signal.reason);
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', leave, { once: true });
      entry.promise.then(
        (value) => {
          signal.removeEventListener('abort', leave);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', leave);
          reject(error);
        },
      );
    });
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
): Promise<WorkspaceFileChangesRead> {
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
    // `--quiet` makes "HEAD names no commit" exit 1 and say nothing; any
    // other failure (a deadline, a broken repository, exit 128 with a
    // message) is not "no commits yet" and is not labelled so.
    if (!unbornHead(error)) throw error;
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
  // An empty patch is "matches HEAD" only for a file git knows: one in the
  // index (so it is tracked) or one it sees in the work tree (untracked,
  // ignored or not). A path that is neither is nothing to compare.
  const untracked = await git(['ls-files', '--others', '--', pathspec]);
  if (untracked.trim()) return { state: 'untracked' };
  const tracked = await git(['ls-files', '--', pathspec]);
  return tracked.trim()
    ? { state: 'unchanged', base: 'HEAD' }
    : { state: 'not-found' };
}

/** `rev-parse --verify --quiet` finding no commit at HEAD: exit 1, silent. */
function unbornHead(error: unknown): boolean {
  const failure = error as {
    code?: unknown;
    stderr?: unknown;
    killed?: unknown;
  };
  return (
    !gitTimedOut(error) &&
    failure?.code === 1 &&
    (typeof failure.stderr !== 'string' || failure.stderr.trim() === '')
  );
}
