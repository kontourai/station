import { existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKPOINT_REF_ROOT,
  checkpointRefName,
  checkpointRefPath,
  enumerateThreadCheckpointRefs,
  isSafeCheckpointRefSegment,
  removeThreadCheckpointRefs,
} from '@kontourai/station-shared/checkpoints';
import { execGit, killGitProcessTree, spawnGit } from '../../utils/git-exec.js';
import {
  openRepositorySnapshot,
  ProjectRepositoryRefusedError,
  requireProjectRepository,
} from '../projects/git-read-repository.js';
import {
  judgeRepositoryConfigEntries,
  type RepositoryConfigEntry,
} from '../projects/git-repository-config.js';

/**
 * Workspace checkpoint ref store (archive#2802, slice 1).
 *
 * A checkpoint is a commit object snapshotting a repository's ENTIRE working
 * tree (tracked modifications plus untracked-but-not-ignored files) at a
 * moment in time, addressed by a station-owned ref. It is written with a
 * TEMPORARY index (`GIT_INDEX_FILE`) so the user's real index, HEAD, and
 * branches are never touched: no staging, no user-visible commit, no ref
 * movement. Every git invocation goes through `execGit` (see
 * `utils/git-exec.ts` — an inherited GIT_DIR/GIT_WORK_TREE must never
 * retarget a spawned git at the wrong repository) and is bounded by
 * CHECKPOINT_GIT_TIMEOUT_MS so a wedged filter driver degrades into a
 * typed record instead of wedging the thread's capture tail forever.
 *
 * ## Why the refs are pseudo-refs, not `refs/station/checkpoints/…`
 *
 * The namespace is `STATION_CHECKPOINTS/<threadId>/<checkpointId>` — a
 * pseudo-ref hierarchy stored as plain files under the git COMMON dir
 * (`.git/STATION_CHECKPOINTS/…`), deliberately OUTSIDE `refs/`. Empirically
 * (git 2.50), anything under `refs/` — including unknown namespaces like
 * `refs/station/*` and per-worktree `refs/worktree/*` — IS traversed by
 * `git log --all`, which would surface checkpoint commits in every user's
 * log. Pseudo-refs are enumerated by none of `git branch`, `git tag`,
 * `git log --all`, or `git for-each-ref`.
 *
 * ## Retention (measured, fix-round corrected)
 *
 * The trade the pseudo-ref namespace buys is GC reachability: git's
 * reachability walk does NOT follow pseudo-refs themselves, but it DOES
 * follow their reflogs (`logs/STATION_CHECKPOINTS/…`), so every checkpoint
 * ref is created with `--create-reflog`. Consequence, measured against git
 * 2.50: checkpoint objects are NOT collected by `gc.reflogExpireUnreachable`
 * (default 30 days) — the checkpoint commit IS the ref tip, i.e. reachable,
 * so that knob never sees it as unreachable. What governs is
 * `gc.reflogExpire` (default **90 days**): after a reflog entry expires,
 * its checkpoint becomes gc-collectable. `git reflog expire --expire=now
 * --all` (or deleting the ref files, which `station checkpoints prune`
 * does per thread) reclaims immediately. Until then `git gc --prune=now`
 * deliberately CANNOT reclaim them — that is the durability this slice
 * promises, and the disk cost is why capture is behind the default-OFF
 * `workspaceCheckpoints` setting with a CLI to inspect and prune it.
 *
 * ## The git side is self-describing
 *
 * Each checkpoint commit message carries the turnId and the exact
 * capturedAt timestamp (plus phase and ref name), so the Station-home index
 * is a REBUILDABLE CACHE, not the only record: given the refs, the mapping
 * checkpoint -> turn -> boundary can be reconstructed from git alone.
 *
 * In a linked worktree the pseudo-ref lands in the shared COMMON git dir
 * (verified), so checkpoints of every worktree of a repository share one
 * namespace keyed by thread — names are thread/checkpoint-scoped and cannot
 * collide.
 */

/**
 * Bound for every git invocation the store makes. Generous for legitimate
 * work (a `git add -A` over a large tree can take seconds), bounded for the
 * pathological case (a clean/smudge filter waiting on an unreachable
 * endpoint blocks forever): a timeout kills the git child, the capture
 * degrades to a typed `git_timeout` record, and the thread's capture tail
 * stays healthy for the next boundary.
 */
const CHECKPOINT_GIT_TIMEOUT_MS = 60_000;

/** Fixed committer/author identity so checkpoint commits never depend on the
 * user's git config being set (they would otherwise fail `commit-tree` in a
 * config-less repository) and never attribute work to a human. */
const CHECKPOINT_IDENT = {
  name: 'Station Checkpoints',
  email: 'checkpoints@station.local',
} as const;

type CheckpointDegradedReason =
  | 'not_a_git_repository'
  | 'unborn_head'
  | 'detached_head'
  | 'rebase_in_progress'
  | 'git_timeout'
  | 'capture_failed'
  | 'repository_config_refused';

export interface CapturedCheckpoint {
  checkpointId: string;
  commitSha: string;
  treeSha: string;
  repoRoot: string;
  capturedAt: string;
}

export type CheckpointCaptureResult =
  | { status: 'captured'; checkpoint: CapturedCheckpoint }
  | {
      status: 'degraded';
      reason: CheckpointDegradedReason;
      detail?: string;
    };

interface ReadCheckpointResult {
  status: 'ok' | 'missing' | 'object_pruned';
  checkpoint?: CapturedCheckpoint;
}

type CheckpointRefStoreCaptureInput = {
  repoDir: string;
  threadId: string;
  checkpointId: string;
  /** Which boundary produced this checkpoint; labels the commit message. */
  kind: string;
  /**
   * The turn this checkpoint belongs to. Written into the commit message
   * (and the reflog entry) so the git side alone can answer "which turn
   * was this a checkpoint of" — the durable link the home index caches.
   */
  turnId: string;
};

interface CheckpointRefStoreOptions {
  /** Per-invocation git timeout. Default CHECKPOINT_GIT_TIMEOUT_MS. */
  gitTimeoutMs?: number;
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

/** execFile reports a timeout kill via `killed`/`signal` on the error. */
function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (('killed' in error && (error as { killed?: unknown }).killed === true) ||
      ('signal' in error &&
        typeof (error as { signal?: unknown }).signal === 'string'))
  );
}

/**
 * Runs `build` with git writing every NEW object into a directory Station
 * owns (`GIT_OBJECT_DIRECTORY`, reading the repository's through the
 * alternate), and moves them into the repository's object store only once
 * the repository is still the one that was checked. Without it, `add -A`,
 * `write-tree` and `commit-tree` write through the snapshot's `objects`
 * link for as long as they run, and a `.git` swapped for a link to another
 * repository meanwhile put the Project's files into THAT repository's
 * object store (measured: 43 objects over 80 captures under a flipping
 * link). Now only the move itself goes through the path, after the check,
 * and git is then asked for the objects without the quarantine, so a move
 * that did not land fails the operation rather than leaving a ref dangling.
 */
export async function withQuarantinedObjects<T>(
  repository: CheckpointRepository,
  build: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const quarantine = await mkdtemp(
    join(tmpdir(), 'station-checkpoint-objects-'),
  );
  try {
    const built = await build({
      GIT_OBJECT_DIRECTORY: quarantine,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repository.commonDir, 'objects'),
    });
    if (!(await repository.stillOwn())) {
      throw new Error('the repository changed while it was captured');
    }
    const store = join(repository.commonDir, 'objects');
    for await (const fanOut of await opendir(quarantine)) {
      if (!fanOut.isDirectory() || !/^[0-9a-f]{2}$/.test(fanOut.name)) continue;
      const bucket = join(store, fanOut.name);
      await mkdir(bucket, { recursive: true });
      for await (const object of await opendir(join(quarantine, fanOut.name))) {
        if (!object.isFile()) continue;
        const target = join(bucket, object.name);
        if (existsSync(target)) continue;
        // As git writes one: whole under a temporary name, then renamed.
        const staged = `${target}.station-${process.pid}`;
        await copyFile(join(quarantine, fanOut.name, object.name), staged);
        await rename(staged, target);
      }
    }
    return built;
  } finally {
    await rm(quarantine, { recursive: true, force: true }).catch(() => {
      // Best-effort; a survivor is inert.
    });
  }
}

/** What a checkpoint operation runs git with: a snapshot of the folder's
 * own repository (`git-read-repository.ts`). */
export interface CheckpointRepository {
  /** The work tree's root, symlink-resolved. */
  top: string;
  /** The repository's per-worktree git directory, symlink-resolved. */
  gitDir: string;
  /** The repository's common directory, symlink-resolved. */
  commonDir: string;
  /** `--git-dir=<snapshot> --work-tree=<top>`. */
  repoArgs: string[];
  config: RepositoryConfigEntry[];
  /**
   * Creates the checkpoint directories in the repository when they are
   * missing and makes them writable through the snapshot. Only a capture
   * that is about to write its ref asks.
   */
  linkCheckpointDirectories: () => Promise<void>;
  /**
   * Still the folder's own repository, and the same files as when it was
   * checked (whatever their times): asked immediately before anything is
   * written or removed.
   */
  stillOwn: () => Promise<boolean>;
}

export class CheckpointRepositoryRefused extends Error {
  constructor(
    readonly reason: 'not_a_git_repository' | 'repository_config_refused',
    detail: string,
  ) {
    super(detail);
  }
}

/**
 * The directories checkpoints live in, relative to the common directory:
 * the pseudo-refs and their reflogs. git reaches them through the snapshot.
 */
const CHECKPOINT_DIRECTORIES = [
  CHECKPOINT_REF_ROOT,
  join('logs', CHECKPOINT_REF_ROOT),
];

/**
 * Runs `run` with a snapshot of `repoDir`'s OWN repository.
 *
 * `repoDir` is a Project's folder, which is member-writable: a `.git` file
 * there can name any repository on this computer, a `commondir` can name
 * any common directory, and a capture writes objects and a ref into
 * whichever one git finds. So the repository is resolved and checked once
 * (`requireProjectRepository`), and every git call runs against a git
 * directory Station owns: the repository's config as it was judged (so a
 * clean or smudge filter written into `.git/config` afterwards does not
 * exist for this operation), its HEAD, and its objects, refs and
 * checkpoint directories linked back. Nothing here lets git discover a
 * repository from the folder again.
 */
export async function withCheckpointRepository<T>(
  repoDir: string,
  options: { timeoutMs: number },
  run: (repository: CheckpointRepository) => Promise<T>,
): Promise<T> {
  let repository: Awaited<ReturnType<typeof requireProjectRepository>>;
  try {
    repository = await requireProjectRepository(repoDir, repoDir);
  } catch (error) {
    if (!(error instanceof ProjectRepositoryRefusedError)) throw error;
    throw new CheckpointRepositoryRefused(
      'not_a_git_repository',
      error.message,
    );
  }
  // A thread's refs are removed with `rm`, which goes through a linked
  // folder to wherever it leads. git never links these.
  for (const directory of ['logs', ...CHECKPOINT_DIRECTORIES]) {
    const stats = await lstat(join(repository.commonDir, directory)).catch(
      () => null,
    );
    if (stats && !stats.isDirectory()) {
      throw new CheckpointRepositoryRefused(
        'not_a_git_repository',
        `.git/${directory} is not an ordinary folder`,
      );
    }
  }
  const opened = await openRepositorySnapshot(repository, {
    timeoutMs: options.timeoutMs,
  });
  if (!opened.ok) {
    throw new CheckpointRepositoryRefused(
      opened.state === 'config-refused'
        ? 'repository_config_refused'
        : 'not_a_git_repository',
      opened.state === 'config-refused'
        ? `repository config sets ${opened.keys.join(', ')}`
        : opened.state === 'refused'
          ? opened.reason
          : "git could not read the repository's configuration",
    );
  }
  try {
    // What is already there is readable through the snapshot.
    await opened.snapshot.link(CHECKPOINT_DIRECTORIES, false);
    return await run({
      linkCheckpointDirectories: () =>
        opened.snapshot.link(CHECKPOINT_DIRECTORIES, true),
      top: repository.top,
      gitDir: repository.gitDir,
      commonDir: repository.commonDir,
      repoArgs: opened.snapshot.repoArgs,
      config: opened.snapshot.config,
      stillOwn: async () => {
        try {
          const again = await requireProjectRepository(repoDir, repoDir);
          return (
            again.gitDir === repository.gitDir &&
            again.commonDir === repository.commonDir &&
            (await repository.sameIdentity())
          );
        } catch {
          return false;
        }
      },
    });
  } finally {
    await opened.snapshot.dispose();
  }
}

/**
 * A thread's ref and reflog folders must be ordinary folders before
 * anything under them is listed or removed: `rm` follows a linked FOLDER
 * on the way to the file it removes.
 */
async function threadDirectoriesAreOrdinary(
  commonDir: string,
  threadId: string,
): Promise<boolean> {
  for (const directory of CHECKPOINT_DIRECTORIES) {
    const stats = await lstat(join(commonDir, directory, threadId)).catch(
      () => null,
    );
    if (stats && !stats.isDirectory()) return false;
  }
  return true;
}

/**
 * After `add -A`, puts every submodule entry of the index back to what HEAD
 * records (or removes it when HEAD has none). `add` records a nested
 * repository's HEAD commit as a submodule entry, and a nested `.git` file
 * can name any repository on this computer: its commit id would be stored
 * in the checkpoint. A nested repository's files are not captured either
 * way.
 */
export async function dropNestedRepositoryChanges(
  git: (
    args: string[],
    options?: { input?: string },
  ) => Promise<{ stdout: string }>,
): Promise<void> {
  const staged = (await git(['ls-files', '-s', '-z'])).stdout
    .split('\0')
    .filter((line) => line.startsWith('160000 '))
    .map((line) => line.slice(line.indexOf('\t') + 1));
  if (staged.length === 0) return;
  const recorded = new Map<string, string>();
  for (const line of (await git(['ls-tree', '-r', '-z', 'HEAD'])).stdout.split(
    '\0',
  )) {
    const match = /^160000 commit ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    if (match) recorded.set(match[2], match[1]);
  }
  const zero = '0'.repeat(40);
  await git(['update-index', '-z', '--index-info'], {
    input: staged
      .map((path) => {
        const sha = recorded.get(path);
        return sha ? `160000 ${sha}\t${path}\0` : `0 ${zero}\t${path}\0`;
      })
      .join(''),
  });
}

export class CheckpointRefStore {
  private readonly gitTimeoutMs: number;

  constructor(options: CheckpointRefStoreOptions = {}) {
    this.gitTimeoutMs = options.gitTimeoutMs ?? CHECKPOINT_GIT_TIMEOUT_MS;
  }

  /**
   * Snapshot `repoDir`'s working tree as a checkpoint commit addressed by
   * `STATION_CHECKPOINTS/<threadId>/<checkpointId>`.
   *
   * Never touches the user's index, HEAD, or branches. On a failure BEFORE
   * the ref write, the temporary index is removed and no ref exists. On a
   * failure AFTER the ref write (the read-back check), the ref and its
   * reflog are removed again — a half-captured checkpoint would otherwise
   * sit in `.git` pinned by its reflog while every caller records
   * `capture_failed`, invisible and unattributable.
   */
  async capture(
    input: CheckpointRefStoreCaptureInput,
  ): Promise<CheckpointCaptureResult> {
    const ref = checkpointRefName(input.threadId, input.checkpointId);
    if (!ref) {
      return {
        status: 'degraded',
        reason: 'capture_failed',
        detail: 'threadId/checkpointId is not a safe ref segment',
      };
    }
    try {
      return await withCheckpointRepository(
        input.repoDir,
        { timeoutMs: this.gitTimeoutMs },
        (repository) => this.captureIn(repository, ref, input),
      );
    } catch (error) {
      if (isTimeoutError(error)) {
        return {
          status: 'degraded',
          reason: 'git_timeout',
          detail: gitErrorMessage(error),
        };
      }
      // A folder that is not in a repository, or whose repository is not
      // its own, has no checkpoints.
      return {
        status: 'degraded',
        reason:
          error instanceof CheckpointRepositoryRefused
            ? error.reason
            : 'not_a_git_repository',
        detail: gitErrorMessage(error),
      };
    }
  }

  private async captureIn(
    repository: CheckpointRepository,
    ref: string,
    input: CheckpointRefStoreCaptureInput,
  ): Promise<CheckpointCaptureResult> {
    const repoRoot = repository.top;
    // #2410: `add -A` below runs a clean filter the repository's own config
    // defines, as the operator, with nobody having clicked anything. The
    // runner cannot switch a per-file filter off, so such a repository gets
    // no checkpoints, by the same rule the coding routes apply before
    // `status` and `diff` (`git-repository-config.ts`). Judged on every
    // capture, and judged on the very config git then runs with.
    const config = judgeRepositoryConfigEntries(repository.config, 'read');
    if (!config.ok) {
      return {
        status: 'degraded',
        reason:
          config.code === 'repository-config-refused'
            ? 'repository_config_refused'
            : 'capture_failed',
        detail:
          config.code === 'repository-config-refused'
            ? `repository config sets ${config.keys.join(', ')}`
            : "git could not read the repository's configuration",
      };
    }

    try {
      await this.assertHeadSnapshotable(repository);
    } catch (error) {
      if (isTimeoutError(error)) {
        return {
          status: 'degraded',
          reason: 'git_timeout',
          detail: gitErrorMessage(error),
        };
      }
      return {
        status: 'degraded',
        reason:
          error instanceof CheckpointHeadStateError
            ? error.reason
            : 'capture_failed',
        detail: gitErrorMessage(error),
      };
    }

    const capturedAt = new Date().toISOString();
    const tempDir = await mkdtemp(join(tmpdir(), 'station-checkpoint-'));
    let refWritten = false;
    try {
      const indexFile = join(tempDir, 'index');
      // GIT_INDEX_FILE (plus the fixed ident) is injected; the repository
      // is named by `--git-dir`/`--work-tree`, never discovered and never
      // taken from an inherited variable.
      const ident = {
        GIT_INDEX_FILE: indexFile,
        GIT_AUTHOR_NAME: CHECKPOINT_IDENT.name,
        GIT_AUTHOR_EMAIL: CHECKPOINT_IDENT.email,
        GIT_AUTHOR_DATE: capturedAt,
        GIT_COMMITTER_NAME: CHECKPOINT_IDENT.name,
        GIT_COMMITTER_EMAIL: CHECKPOINT_IDENT.email,
        GIT_COMMITTER_DATE: capturedAt,
      };
      const gitWith =
        (env: NodeJS.ProcessEnv) =>
        (args: string[], options: { input?: string } = {}) =>
          execGit([...repository.repoArgs, ...args], {
            cwd: repoRoot,
            encoding: 'utf-8' as const,
            timeout: this.gitTimeoutMs,
            env: { ...ident, ...env },
            ...options,
          });

      // The commit message is the durable, self-describing record: ref
      // name, boundary phase, turnId, and the exact capturedAt timestamp
      // (git author dates are second-granular — the trailer is what
      // round-trips millisecond precision on read).
      const message = [
        `station checkpoint ${ref} (${input.kind})`,
        '',
        `turn=${input.turnId}`,
        `phase=${input.kind}`,
        `captured-at=${capturedAt}`,
      ].join('\n');
      // Every object is built in quarantine and moved into the repository
      // afterwards, once it is still the one that was checked.
      const { tree, commit } = await withQuarantinedObjects(
        repository,
        async (quarantine) => {
          const git = gitWith(quarantine);
          // Seed the temp index with HEAD so the snapshot starts from the
          // committed state, then `add -A` folds in working-tree
          // modifications, deletions, and untracked-but-not-ignored files.
          // Ignored files stay excluded because `add` respects the
          // repository's ignore rules.
          await git(['read-tree', 'HEAD']);
          await git(['add', '-A']);
          await dropNestedRepositoryChanges(git);
          const tree = (await git(['write-tree'])).stdout.trim();
          const commit = (
            await git(['commit-tree', tree, '-p', 'HEAD', '-m', message])
          ).stdout.trim();
          return { tree, commit };
        },
      );
      // From here git reads the repository's own object store, so the ref
      // is only written, and only read back, if the objects landed there.
      const git = gitWith({});

      // The ref is about to be written through the links into the
      // repository. It must still be the repository that was checked (the
      // objects just written changed its times, so identity is what is
      // compared). A `.git` swapped in the moment between this and git
      // opening the path is still followed.
      if (!(await repository.stillOwn())) {
        throw new Error('the repository changed while it was captured');
      }
      await repository.linkCheckpointDirectories();
      // The only mutation of repository refs in the whole capture: one
      // atomic update-ref creating the hidden pseudo-ref, with a reflog so
      // the commit stays reachable for git's reachability walk. The reflog
      // message carries the turnId too — `git reflog
      // STATION_CHECKPOINTS/<t>/<c>` then answers "which turn" without
      // reading the commit.
      await git([
        'update-ref',
        '--create-reflog',
        ref,
        commit,
        '-m',
        `${input.kind} turn=${input.turnId}`,
      ]);
      refWritten = true;

      // Read back through the ref (not the local `commit` variable) so a
      // store that somehow wrote a different value reports capture_failed
      // instead of success.
      const readBack = (await git(['rev-parse', ref])).stdout.trim();
      if (readBack !== commit) {
        throw new Error(
          `checkpoint ref ${ref} read back ${readBack}, expected ${commit}`,
        );
      }
      if (!(await repository.stillOwn())) {
        throw new Error('the repository changed while it was captured');
      }

      return {
        status: 'captured',
        checkpoint: {
          checkpointId: input.checkpointId,
          commitSha: commit,
          treeSha: tree,
          repoRoot,
          capturedAt,
        },
      };
    } catch (error) {
      // A ref that was already written must not survive a failed capture:
      // pinned by its reflog, it would be invisible, unattributable `.git`
      // growth with no index record saying it exists.
      if (
        refWritten &&
        (await repository.stillOwn()) &&
        (await threadDirectoriesAreOrdinary(
          repository.commonDir,
          input.threadId,
        ))
      ) {
        await removeThreadCheckpointRefs(
          repository.commonDir,
          input.threadId,
        ).catch(() => {
          // Best-effort: the degraded record below still tells the truth.
        });
      }
      return {
        status: 'degraded',
        reason: isTimeoutError(error) ? 'git_timeout' : 'capture_failed',
        detail: gitErrorMessage(error),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup of a temp directory; a survivor is inert.
      });
    }
  }

  async readCheckpoint(input: {
    repoDir: string;
    threadId: string;
    checkpointId: string;
  }): Promise<ReadCheckpointResult> {
    try {
      return await withCheckpointRepository(
        input.repoDir,
        { timeoutMs: this.gitTimeoutMs },
        (repository) =>
          this.readCheckpointIn(repository, input.threadId, input.checkpointId),
      );
    } catch {
      return { status: 'missing' };
    }
  }

  private async readCheckpointIn(
    repository: CheckpointRepository,
    threadId: string,
    checkpointId: string,
  ): Promise<ReadCheckpointResult> {
    const ref = checkpointRefName(threadId, checkpointId);
    if (!ref) return { status: 'missing' };
    const git = (args: string[]) =>
      execGit([...repository.repoArgs, ...args], {
        cwd: repository.top,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
    try {
      const commit = (await git(['rev-parse', '--verify', ref])).stdout.trim();
      const meta = await git(['show', '-s', '--format=%T%n%B', commit]);
      const [treeSha, ...bodyLines] = meta.stdout.trim().split('\n');
      const body = bodyLines.join('\n');
      // captured-at trailer first (exact, millisecond-precise — L1);
      // %aI second-granularity is only the fallback for a foreign commit.
      const trailer = /captured-at=(\S+)/.exec(body)?.[1];
      const capturedAt =
        trailer ??
        (await git(['show', '-s', '--format=%aI', commit])).stdout.trim();
      return {
        status: 'ok',
        checkpoint: {
          checkpointId,
          commitSha: commit,
          treeSha,
          repoRoot: repository.top,
          capturedAt,
        },
      };
    } catch {
      // Distinguish "no such checkpoint" from "checkpoint object expired":
      // rev-parse failing on the ref itself is `missing`; the ref resolving
      // but `show` failing means the object was pruned (see file header).
      try {
        await git(['rev-parse', '--verify', ref]);
        return { status: 'object_pruned' };
      } catch {
        return { status: 'missing' };
      }
    }
  }

  /** A thread's checkpoint ids, from its ordinary ref folder. */
  private async threadCheckpointIds(
    repository: CheckpointRepository,
    threadId: string,
  ): Promise<string[]> {
    if (!(await threadDirectoriesAreOrdinary(repository.commonDir, threadId))) {
      throw new Error('checkpoint refs for this thread are not a folder');
    }
    return enumerateThreadCheckpointRefs(repository.commonDir, threadId);
  }

  /** All checkpoints recorded for a thread, oldest first. */
  async listCheckpoints(input: {
    repoDir: string;
    threadId: string;
  }): Promise<CapturedCheckpoint[]> {
    if (!isSafeCheckpointRefSegment(input.threadId)) return [];
    try {
      return await withCheckpointRepository(
        input.repoDir,
        { timeoutMs: this.gitTimeoutMs },
        async (repository) => {
          const checkpoints: CapturedCheckpoint[] = [];
          for (const checkpointId of await this.threadCheckpointIds(
            repository,
            input.threadId,
          )) {
            const read = await this.readCheckpointIn(
              repository,
              input.threadId,
              checkpointId,
            );
            if (read.status === 'ok' && read.checkpoint) {
              checkpoints.push(read.checkpoint);
            }
          }
          // Full-precision capturedAt (the trailer) makes this a stable
          // ordering even for a baseline/settle pair inside one second.
          return checkpoints.sort((a, b) =>
            a.capturedAt.localeCompare(b.capturedAt),
          );
        },
      );
    } catch {
      return [];
    }
  }

  /** Retention variant: repository/Git failures are not an empty ref set. */
  async listCheckpointsForRetention(input: {
    repoDir: string;
    threadId: string;
  }): Promise<CapturedCheckpoint[]> {
    if (!isSafeCheckpointRefSegment(input.threadId)) {
      throw new Error('invalid checkpoint thread id');
    }
    return withCheckpointRepository(
      input.repoDir,
      { timeoutMs: this.gitTimeoutMs },
      async (repository) => {
        const checkpoints: CapturedCheckpoint[] = [];
        for (const checkpointId of await this.threadCheckpointIds(
          repository,
          input.threadId,
        )) {
          const read = await this.readCheckpointIn(
            repository,
            input.threadId,
            checkpointId,
          );
          if (read.status !== 'ok' || !read.checkpoint) {
            throw new Error(`checkpoint ${checkpointId} is not readable`);
          }
          checkpoints.push(read.checkpoint);
        }
        return checkpoints.sort((a, b) =>
          a.capturedAt.localeCompare(b.capturedAt),
        );
      },
    );
  }

  /**
   * Removes one checkpoint's ref and reflog from the folder's OWN
   * repository. These are `rm` calls on paths under the common directory,
   * so the common directory is the one that was checked (never one a
   * `commondir` file names from outside), the thread's folders must be
   * ordinary folders, and the repository must still be the same files
   * immediately before anything is removed.
   */
  private async removeCheckpoint(
    repoDir: string,
    threadId: string,
    ref: string,
  ): Promise<'deleted' | 'missing'> {
    return withCheckpointRepository(
      repoDir,
      { timeoutMs: this.gitTimeoutMs },
      async (repository) => {
        const { commonDir } = repository;
        if (
          !(await threadDirectoriesAreOrdinary(commonDir, threadId)) ||
          !(await repository.stillOwn())
        ) {
          throw new Error('checkpoint refs for this thread are not a folder');
        }
        const refPath = checkpointRefPath(commonDir, ref);
        const present = existsSync(refPath);
        // Also when the ref is already gone: complete a prior crash between
        // pseudo-ref and reflog unlink, so an undiscoverable reflog cannot
        // keep the checkpoint object pinned.
        if (present) await rm(refPath);
        await rm(join(commonDir, 'logs', ref), { force: true });
        return present ? 'deleted' : 'missing';
      },
    );
  }

  /** Retention variant: deletion failures remain distinguishable from missing. */
  async deleteCheckpointForRetention(input: {
    repoDir: string;
    threadId: string;
    checkpointId: string;
  }): Promise<'deleted' | 'missing'> {
    const ref = checkpointRefName(input.threadId, input.checkpointId);
    if (!ref) throw new Error('invalid checkpoint ref');
    return this.removeCheckpoint(input.repoDir, input.threadId, ref);
  }

  async deleteCheckpoint(input: {
    repoDir: string;
    threadId: string;
    checkpointId: string;
  }): Promise<'deleted' | 'missing'> {
    const ref = checkpointRefName(input.threadId, input.checkpointId);
    if (!ref) return 'missing';
    try {
      return await this.removeCheckpoint(input.repoDir, input.threadId, ref);
    } catch {
      return 'missing';
    }
  }

  /**
   * Remove every checkpoint ref (and reflog) for a thread. Returns the number
   * of checkpoint refs removed. Used by the `station checkpoints prune` CLI
   * path — the documented way to reclaim checkpoint disk (the objects then
   * become gc-collectable; `prune --gc` runs the gc for you).
   */
  async pruneThreadCheckpoints(input: {
    repoDir: string;
    threadId: string;
  }): Promise<number> {
    if (!isSafeCheckpointRefSegment(input.threadId)) return 0;
    try {
      return await withCheckpointRepository(
        input.repoDir,
        { timeoutMs: this.gitTimeoutMs },
        async (repository) => {
          if (
            !(await threadDirectoriesAreOrdinary(
              repository.commonDir,
              input.threadId,
            )) ||
            !(await repository.stillOwn())
          ) {
            return 0;
          }
          return removeThreadCheckpointRefs(
            repository.commonDir,
            input.threadId,
          );
        },
      );
    } catch {
      return 0;
    }
  }

  /**
   * Verify, for a batch of recorded checkpoints, whether the git objects
   * still exist — the read-path half of the retention contract (M3): the
   * home index can still say `captured` for a commit whose reflog expired
   * and whose object `git gc` pruned, and an index record served without
   * observing that is indistinguishable from a working checkpoint.
   *
   * One `cat-file --batch-check` per repo (not per checkpoint: a thread at
   * its documented bound holds up to 2×maxTurnsPerThread refs), plus one
   * directory listing to distinguish `missing` (ref deleted/pruned) from
   * `object_pruned` (ref present, object gone).
   */
  async verifyThreadCheckpoints(input: {
    repoDir: string;
    threadId: string;
    checkpoints: Array<{ checkpointId: string; commitSha: string }>;
  }): Promise<Map<string, 'ok' | 'missing' | 'object_pruned'>> {
    const verdicts = new Map<string, 'ok' | 'missing' | 'object_pruned'>();
    if (input.checkpoints.length === 0) return verdicts;
    for (const entry of input.checkpoints) {
      verdicts.set(entry.checkpointId, 'missing');
    }
    try {
      await withCheckpointRepository(
        input.repoDir,
        { timeoutMs: this.gitTimeoutMs },
        async (repository) => {
          const present = new Set(
            await this.threadCheckpointIds(repository, input.threadId),
          );
          const toCheck = input.checkpoints.filter((entry) =>
            present.has(entry.checkpointId),
          );
          if (toCheck.length === 0) return;
          // `execGit` is promisified `execFile`, which — unlike
          // `execFileSync` — has NO `input` option here: `cat-file
          // --batch-check` would wait on a stdin that never closes until
          // the timeout SIGTERMs it, and every live checkpoint would then
          // be reported `missing`. Drive stdin explicitly through
          // `spawnGit`.
          const stdout = await batchCheckObjects(
            repository,
            toCheck.map((entry) => entry.commitSha),
            this.gitTimeoutMs,
          );
          // A failed batch is NOT evidence of absence. Returning here
          // leaves the pre-seeded `missing` verdicts in place; overwriting
          // them below would report `object_pruned` — a definite claim
          // about git state derived from having observed nothing, which is
          // the exact defect this annotation exists to prevent
          // (archive#2802 M3).
          if (stdout === null) return;
          const existing = new Set(
            stdout
              .split('\n')
              .map((line) => line.trim().split(/\s+/))
              .filter(
                (parts) =>
                  parts.length === 2 &&
                  parts[0].length > 0 &&
                  parts[1] !== 'missing',
              )
              .map((parts) => parts[0]),
          );
          for (const entry of toCheck) {
            verdicts.set(
              entry.checkpointId,
              existing.has(entry.commitSha) ? 'ok' : 'object_pruned',
            );
          }
        },
      );
    } catch {
      // The repository is unreachable (unmounted, deleted) or is not the
      // folder's own: leave the pre-set `missing` verdicts — the caller
      // surfaces them as unverified rather than intact.
    }
    return verdicts;
  }

  /**
   * Typed degradation for the HEAD states a checkpoint deliberately refuses
   * to snapshot: unborn HEAD (no commits yet), an in-progress rebase, and
   * detached HEAD. Order matters: a rebase holds HEAD detached at its base
   * commit, so the rebase probe runs BEFORE the detached probe or every
   * mid-rebase capture would report the less specific `detached_head`.
   * Detached HEAD is technically snapshotable; it is excluded on purpose
   * because a checkpoint whose parentage cannot name a branch makes later
   * diff/restore slices reason about an anchor users do not recognize.
   *
   * The rebase probe is worktree-aware: the state lives in the worktree's
   * OWN git directory (`<common>/worktrees/<name>/rebase-merge` in a linked
   * worktree, `<common>/rebase-merge` in the primary) — probing the common
   * dir directly misreads BOTH directions (a main-checkout rebase would
   * block all ~100 sibling worktrees; a genuine linked-worktree rebase
   * would be misreported as detached_head).
   */
  private async assertHeadSnapshotable(
    repository: CheckpointRepository,
  ): Promise<void> {
    const git = (args: string[]) =>
      execGit([...repository.repoArgs, ...args], {
        cwd: repository.top,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
    try {
      await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch {
      throw new CheckpointHeadStateError('unborn_head');
    }
    for (const state of ['rebase-merge', 'rebase-apply']) {
      if (existsSync(join(repository.gitDir, state))) {
        throw new CheckpointHeadStateError('rebase_in_progress');
      }
    }
    try {
      await git(['symbolic-ref', '--quiet', 'HEAD']);
    } catch {
      throw new CheckpointHeadStateError('detached_head');
    }
  }
}

class CheckpointHeadStateError extends Error {
  constructor(public readonly reason: CheckpointDegradedReason) {
    super(`checkpoint capture refused for HEAD state: ${reason}`);
    this.name = 'CheckpointHeadStateError';
  }
}

/**
 * `git cat-file --batch-check` over an explicit stdin stream.
 *
 * Batch mode reads object names from stdin and only exits once stdin is
 * closed, so it cannot be driven through `execFile` (whose `input` option
 * does not exist — that is `execFileSync`). We spawn it, write the shas,
 * end stdin, and bound the whole thing with a timer that kills the child.
 * Returns `null` — distinct from an empty-but-successful `''` — when the
 * batch could not be observed at all (spawn failure, non-zero exit, or a
 * timeout kill). The caller must treat `null` as "unknown" and keep its
 * pre-seeded verdicts; deriving either `ok` or `object_pruned` from a
 * batch that never ran is a claim nothing computed.
 */
async function batchCheckObjects(
  repository: CheckpointRepository,
  shas: string[],
  timeoutMs: number,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawnGit(
      [
        ...repository.repoArgs,
        'cat-file',
        '--batch-check=%(objectname) %(objecttype)',
      ],
      { cwd: repository.top, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // The whole process group: git behind macOS's xcrun shim included.
      killGitProcessTree(child, 'SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
    child.stdin?.on('error', () => finish(null));
    child.stdin?.end(`${shas.join('\n')}\n`);
  });
}
