import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpointRefName,
  checkpointRefPath,
  enumerateThreadCheckpointRefs,
  isSafeCheckpointRefSegment,
  removeThreadCheckpointRefs,
} from '@kontourai/station-shared/checkpoints';
import { execGit, spawnGit } from '../../utils/git-exec.js';

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
export const CHECKPOINT_GIT_TIMEOUT_MS = 60_000;

/** Fixed committer/author identity so checkpoint commits never depend on the
 * user's git config being set (they would otherwise fail `commit-tree` in a
 * config-less repository) and never attribute work to a human. */
const CHECKPOINT_IDENT = {
  name: 'Station Checkpoints',
  email: 'checkpoints@station.local',
} as const;

export type CheckpointDegradedReason =
  | 'not_a_git_repository'
  | 'unborn_head'
  | 'detached_head'
  | 'rebase_in_progress'
  | 'git_timeout'
  | 'capture_failed';

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

export interface ReadCheckpointResult {
  status: 'ok' | 'missing' | 'object_pruned';
  checkpoint?: CapturedCheckpoint;
}

export type CheckpointRefStoreCaptureInput = {
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

export interface CheckpointRefStoreOptions {
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

async function resolveCommonGitDir(
  repoRoot: string,
  timeoutMs: number = CHECKPOINT_GIT_TIMEOUT_MS,
): Promise<string> {
  // archive#2802 M2: this sits on capture's post-ref-write cleanup path and
  // on every read path, so it must be bounded like its siblings. The
  // conditions that make a capture fail after the ref write (a wedged clean
  // filter, a hung network mount, a held index lock) are the same ones that
  // hang this call — and an unbounded hang here wedges the thread's tail
  // forever with no record written.
  const { stdout } = await execGit(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: repoRoot, encoding: 'utf-8', timeout: timeoutMs },
  );
  const dir = stdout.trim();
  if (!dir) throw new Error('git rev-parse --git-common-dir returned no path');
  return dir;
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

    let repoRoot: string;
    try {
      const inside = await execGit(['rev-parse', '--is-inside-work-tree'], {
        cwd: input.repoDir,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
      if (inside.stdout.trim() !== 'true') {
        return { status: 'degraded', reason: 'not_a_git_repository' };
      }
      const toplevel = await execGit(['rev-parse', '--show-toplevel'], {
        cwd: input.repoDir,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
      repoRoot = toplevel.stdout.trim();
    } catch (error) {
      if (isTimeoutError(error)) {
        return {
          status: 'degraded',
          reason: 'git_timeout',
          detail: gitErrorMessage(error),
        };
      }
      // `git rev-parse` in a non-git directory exits non-zero with
      // "not a git repository" on stderr — the typed shape callers get for
      // a directory that is not inside any work tree.
      return {
        status: 'degraded',
        reason: 'not_a_git_repository',
        detail: gitErrorMessage(error),
      };
    }

    const gitOpts = {
      cwd: repoRoot,
      encoding: 'utf-8' as const,
      timeout: this.gitTimeoutMs,
    };

    try {
      await this.assertHeadSnapshotable(repoRoot);
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
      // Only GIT_INDEX_FILE (plus the fixed ident) is injected; GIT_DIR and
      // GIT_WORK_TREE stay scrubbed by execGit's env so git keeps discovering
      // the repository from `cwd`, never from an inherited variable.
      const env = {
        GIT_INDEX_FILE: indexFile,
        GIT_AUTHOR_NAME: CHECKPOINT_IDENT.name,
        GIT_AUTHOR_EMAIL: CHECKPOINT_IDENT.email,
        GIT_AUTHOR_DATE: capturedAt,
        GIT_COMMITTER_NAME: CHECKPOINT_IDENT.name,
        GIT_COMMITTER_EMAIL: CHECKPOINT_IDENT.email,
        GIT_COMMITTER_DATE: capturedAt,
      };
      const captureOpts = { ...gitOpts, env };

      // Seed the temp index with HEAD so the snapshot starts from the
      // committed state, then `add -A` folds in working-tree modifications,
      // deletions, and untracked-but-not-ignored files. Ignored files stay
      // excluded because `add` respects the repository's ignore rules.
      await execGit(['read-tree', 'HEAD'], captureOpts);
      await execGit(['add', '-A'], captureOpts);
      const tree = (await execGit(['write-tree'], captureOpts)).stdout.trim();
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
      const commit = (
        await execGit(
          ['commit-tree', tree, '-p', 'HEAD', '-m', message],
          captureOpts,
        )
      ).stdout.trim();

      // The only mutation of repository refs in the whole capture: one
      // atomic update-ref creating the hidden pseudo-ref, with a reflog so
      // the commit stays reachable for git's reachability walk. The reflog
      // message carries the turnId too — `git reflog
      // STATION_CHECKPOINTS/<t>/<c>` then answers "which turn" without
      // reading the commit.
      await execGit(
        [
          'update-ref',
          '--create-reflog',
          ref,
          commit,
          '-m',
          `${input.kind} turn=${input.turnId}`,
        ],
        captureOpts,
      );
      refWritten = true;

      // Read back through the ref (not the local `commit` variable) so a
      // store that somehow wrote a different value reports capture_failed
      // instead of success.
      const readBack = (
        await execGit(['rev-parse', ref], captureOpts)
      ).stdout.trim();
      if (readBack !== commit) {
        throw new Error(
          `checkpoint ref ${ref} read back ${readBack}, expected ${commit}`,
        );
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
      if (refWritten) {
        await removeThreadCheckpointRefs(
          await resolveCommonGitDir(repoRoot, this.gitTimeoutMs),
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
    const ref = checkpointRefName(input.threadId, input.checkpointId);
    if (!ref) return { status: 'missing' };
    try {
      const commit = (
        await execGit(['rev-parse', '--verify', ref], {
          cwd: input.repoDir,
          encoding: 'utf-8',
          timeout: this.gitTimeoutMs,
        })
      ).stdout.trim();
      const meta = await execGit(['show', '-s', '--format=%T%n%B', commit], {
        cwd: input.repoDir,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
      const [treeSha, ...bodyLines] = meta.stdout.trim().split('\n');
      const body = bodyLines.join('\n');
      // captured-at trailer first (exact, millisecond-precise — L1);
      // %aI second-granularity is only the fallback for a foreign commit.
      const trailer = /captured-at=(\S+)/.exec(body)?.[1];
      let repoRoot = input.repoDir;
      try {
        repoRoot = (
          await execGit(['rev-parse', '--show-toplevel'], {
            cwd: input.repoDir,
            encoding: 'utf-8',
            timeout: this.gitTimeoutMs,
          })
        ).stdout.trim();
      } catch {
        // keep the caller-provided directory as the best-known root
      }
      if (trailer) {
        return {
          status: 'ok',
          checkpoint: {
            checkpointId: input.checkpointId,
            commitSha: commit,
            treeSha,
            repoRoot: repoRoot || input.repoDir,
            capturedAt: trailer,
          },
        };
      }
      const iso = await execGit(['show', '-s', '--format=%aI', commit], {
        cwd: input.repoDir,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
      return {
        status: 'ok',
        checkpoint: {
          checkpointId: input.checkpointId,
          commitSha: commit,
          treeSha,
          repoRoot: repoRoot || input.repoDir,
          capturedAt: iso.stdout.trim(),
        },
      };
    } catch {
      // Distinguish "no such checkpoint" from "checkpoint object expired":
      // rev-parse failing on the ref itself is `missing`; the ref resolving
      // but `show` failing means the object was pruned (see file header).
      try {
        await execGit(['rev-parse', '--verify', ref], {
          cwd: input.repoDir,
          encoding: 'utf-8',
          timeout: this.gitTimeoutMs,
        });
        return { status: 'object_pruned' };
      } catch {
        return { status: 'missing' };
      }
    }
  }

  /** All checkpoints recorded for a thread, oldest first. */
  async listCheckpoints(input: {
    repoDir: string;
    threadId: string;
  }): Promise<CapturedCheckpoint[]> {
    if (!isSafeCheckpointRefSegment(input.threadId)) return [];
    try {
      const commonDir = await resolveCommonGitDir(
        input.repoDir,
        this.gitTimeoutMs,
      );
      const ids = await enumerateThreadCheckpointRefs(
        commonDir,
        input.threadId,
      );
      const checkpoints: CapturedCheckpoint[] = [];
      for (const checkpointId of ids) {
        const read = await this.readCheckpoint({
          repoDir: input.repoDir,
          threadId: input.threadId,
          checkpointId,
        });
        if (read.status === 'ok' && read.checkpoint) {
          checkpoints.push(read.checkpoint);
        }
      }
      // Full-precision capturedAt (the trailer) makes this a stable
      // ordering even for a baseline/settle pair inside one second.
      checkpoints.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      return checkpoints;
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
    const commonDir = await resolveCommonGitDir(
      input.repoDir,
      this.gitTimeoutMs,
    );
    const ids = await enumerateThreadCheckpointRefs(commonDir, input.threadId);
    const checkpoints: CapturedCheckpoint[] = [];
    for (const checkpointId of ids) {
      const read = await this.readCheckpoint({
        repoDir: input.repoDir,
        threadId: input.threadId,
        checkpointId,
      });
      if (read.status !== 'ok' || !read.checkpoint) {
        throw new Error(`checkpoint ${checkpointId} is not readable`);
      }
      checkpoints.push(read.checkpoint);
    }
    return checkpoints.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }

  /** Retention variant: deletion failures remain distinguishable from missing. */
  async deleteCheckpointForRetention(input: {
    repoDir: string;
    threadId: string;
    checkpointId: string;
  }): Promise<'deleted' | 'missing'> {
    const ref = checkpointRefName(input.threadId, input.checkpointId);
    if (!ref) throw new Error('invalid checkpoint ref');
    const commonDir = await resolveCommonGitDir(
      input.repoDir,
      this.gitTimeoutMs,
    );
    const refPath = checkpointRefPath(commonDir, ref);
    if (!existsSync(refPath)) {
      // Complete a prior crash between pseudo-ref and reflog unlink so an
      // undiscoverable reflog cannot keep the checkpoint object pinned.
      await rm(join(commonDir, 'logs', ref), { force: true });
      return 'missing';
    }
    await rm(refPath);
    await rm(join(commonDir, 'logs', ref), { force: true });
    return 'deleted';
  }

  async deleteCheckpoint(input: {
    repoDir: string;
    threadId: string;
    checkpointId: string;
  }): Promise<'deleted' | 'missing'> {
    const ref = checkpointRefName(input.threadId, input.checkpointId);
    if (!ref) return 'missing';
    try {
      const commonDir = await resolveCommonGitDir(
        input.repoDir,
        this.gitTimeoutMs,
      );
      const refPath = checkpointRefPath(commonDir, ref);
      if (!existsSync(refPath)) return 'missing';
      await rm(refPath, { force: true });
      await rm(join(commonDir, 'logs', ref), { force: true });
      return 'deleted';
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
      const commonDir = await resolveCommonGitDir(
        input.repoDir,
        this.gitTimeoutMs,
      );
      return await removeThreadCheckpointRefs(commonDir, input.threadId);
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
      const commonDir = await resolveCommonGitDir(
        input.repoDir,
        this.gitTimeoutMs,
      );
      const present = new Set(
        await enumerateThreadCheckpointRefs(commonDir, input.threadId),
      );
      const toCheck = input.checkpoints.filter((entry) =>
        present.has(entry.checkpointId),
      );
      if (toCheck.length === 0) return verdicts;
      // `execGit` is promisified `execFile`, which — unlike `execFileSync` —
      // has NO `input` option: passing one is silently ignored, so
      // `cat-file --batch-check` would wait on a stdin that never closes
      // until the timeout SIGTERMs it, and every live checkpoint would then
      // be reported `missing`. Drive stdin explicitly through `spawnGit`.
      const stdout = await batchCheckObjects(
        input.repoDir,
        toCheck.map((entry) => entry.commitSha),
        this.gitTimeoutMs,
      );
      // A failed batch is NOT evidence of absence. Returning here leaves the
      // pre-seeded `missing` verdicts in place; overwriting them below would
      // report `object_pruned` — a definite claim about git state derived
      // from having observed nothing, which is the exact defect this
      // annotation exists to prevent (archive#2802 M3).
      if (stdout === null) return verdicts;
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
    } catch {
      // The repository is unreachable (unmounted, deleted): leave the
      // pre-set `missing` verdicts — the caller surfaces them as
      // unverified rather than intact.
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
   * The rebase probe is worktree-aware: `git rev-parse --git-path
   * rebase-merge` resolves to `<common>/worktrees/<name>/rebase-merge` in a
   * linked worktree and `<common>/rebase-merge` in the primary — probing
   * the common dir directly misreads BOTH directions (a main-checkout
   * rebase would block all ~100 sibling worktrees; a genuine linked-worktree
   * rebase would be misreported as detached_head).
   */
  private async assertHeadSnapshotable(repoRoot: string): Promise<void> {
    try {
      await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
    } catch {
      throw new CheckpointHeadStateError('unborn_head');
    }
    for (const state of ['rebase-merge', 'rebase-apply']) {
      const path = (
        await execGit(
          ['rev-parse', '--path-format=absolute', '--git-path', state],
          {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: this.gitTimeoutMs,
          },
        )
      ).stdout.trim();
      // --git-path is a path COMPUTATION (it answers where the state WOULD
      // live for THIS worktree); existence is checked here.
      if (path && existsSync(path)) {
        throw new CheckpointHeadStateError('rebase_in_progress');
      }
    }
    try {
      await execGit(['symbolic-ref', '--quiet', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: this.gitTimeoutMs,
      });
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
  repoDir: string,
  shas: string[],
  timeoutMs: number,
): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawnGit(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      { cwd: repoDir, stdio: ['pipe', 'pipe', 'ignore'] },
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
      child.kill('SIGTERM');
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
