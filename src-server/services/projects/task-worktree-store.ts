/**
 * #4507: the durable record of each Task's own worktree.
 *
 * Kept in its own home-root file (`task-worktrees.json`) rather than on the
 * Task record: the task store's validator refuses unknown fields, so a Task
 * record carrying this would make every Task unreadable to an older Station
 * after a downgrade or an update rollback. Older builds never read this file.
 *
 * Entries are keyed by Task id and bound to the Task incarnation
 * (`taskCreatedAt`), so a Task recreated under the same id does not inherit
 * the record. Its checkout's path and branch are derived from the Task id
 * alone, though, so such a Task's first dispatch adopts a checkout still
 * registered at that path (Task ids are server-generated, so this needs a
 * restored or hand-edited task store). An entry that does not validate is ignored on its own (never
 * reused, never finalized) instead of making the other Tasks' entries
 * unreadable; the next provisioning for that Task replaces it.
 *
 * A file that cannot be read at all (corrupt, or written by a newer Station
 * in a version this one does not know) reads as having no entries, so every
 * Task still opens and is compared against its Project checkout; it is
 * logged once. Writes still refuse it: `update` never replaces a file it
 * could not read.
 */
import { join } from 'node:path';
import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import {
  acquireFileMutationLockAsync,
  type FileMutationLock,
} from '@kontourai/station-shared/lifecycle-events';
import { createLogger } from '../../utils/logger.js';
import { JsonFileStore } from '../infra/json-store.js';

const logger = createLogger({ name: 'task-worktree-store' });

export const TASK_WORKTREE_STORE_FILE = 'task-worktrees.json';

/**
 * Why a terminal Task's worktree was kept instead of removed. `policy`:
 * its cleanup policy keeps it. `uncommitted` / `unpushed`: removing it would
 * lose work. `session-running`: a Session in it has a running turn, and
 * finalization is retried when that turn ends. `failed`: finalization
 * could not complete (see `detail`).
 */
export type TaskWorktreeKeptReason =
  | 'policy'
  | 'uncommitted'
  | 'unpushed'
  | 'session-running'
  | 'unsafe-config'
  | 'failed';

export interface TaskWorktreeEntry {
  taskCreatedAt: string;
  worktree: WorktreeSessionMetadata;
  kept?: { reason: TaskWorktreeKeptReason; at: string; detail?: string };
}

interface TaskWorktreeStoreData {
  version: 1;
  entries: Record<string, unknown>;
}

const ENTRY_KEYS = ['taskCreatedAt', 'worktree', 'kept'] as const;
const WORKTREE_KEYS = [
  'mode',
  'repoPath',
  'path',
  'branch',
  'baseRef',
  'baseCommit',
  'cleanupPolicy',
  'preserveOnFailure',
  'createdAt',
  'owner',
] as const;
const KEPT_REASONS: readonly TaskWorktreeKeptReason[] = [
  'policy',
  'uncommitted',
  'unpushed',
  'session-running',
  'unsafe-config',
  'failed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** The entry for `taskId`, or undefined when it is absent or not valid. */
export function parseTaskWorktreeEntry(
  taskId: string,
  value: unknown,
): TaskWorktreeEntry | undefined {
  if (!isRecord(value) || !onlyKeys(value, ENTRY_KEYS)) return undefined;
  if (!nonBlank(value.taskCreatedAt)) return undefined;
  const worktree = value.worktree;
  if (!isRecord(worktree) || !onlyKeys(worktree, WORKTREE_KEYS))
    return undefined;
  if (
    worktree.mode !== 'worktree' ||
    !nonBlank(worktree.repoPath) ||
    !nonBlank(worktree.path) ||
    !nonBlank(worktree.branch) ||
    !nonBlank(worktree.baseRef) ||
    (worktree.baseCommit !== undefined && !nonBlank(worktree.baseCommit)) ||
    (worktree.cleanupPolicy !== 'cleanup' &&
      worktree.cleanupPolicy !== 'preserve') ||
    typeof worktree.preserveOnFailure !== 'boolean' ||
    !nonBlank(worktree.createdAt)
  )
    return undefined;
  // The record belongs to exactly this Task; one naming another Task is a
  // transplant, never a checkout this Task may reuse or finalize.
  const owner = worktree.owner;
  if (
    !isRecord(owner) ||
    !onlyKeys(owner, ['kind', 'taskId']) ||
    owner.kind !== 'task' ||
    owner.taskId !== taskId
  )
    return undefined;
  const kept = value.kept;
  if (
    kept !== undefined &&
    (!isRecord(kept) ||
      !onlyKeys(kept, ['reason', 'at', 'detail']) ||
      !KEPT_REASONS.includes(kept.reason as TaskWorktreeKeptReason) ||
      !nonBlank(kept.at) ||
      (kept.detail !== undefined && typeof kept.detail !== 'string'))
  )
    return undefined;
  return structuredClone(value) as unknown as TaskWorktreeEntry;
}

export class TaskWorktreeStore {
  private readonly path: string;
  private readonly store: JsonFileStore<TaskWorktreeStoreData>;

  constructor(
    homeDir: string,
    private readonly acquireLock: FileMutationLock = acquireFileMutationLockAsync,
  ) {
    this.path = join(homeDir, TASK_WORKTREE_STORE_FILE);
    this.store = new JsonFileStore<TaskWorktreeStoreData>(
      this.path,
      { version: 1, entries: {} },
      { onCorruption: 'throw', durableAtomicWrite: true },
    );
  }

  private load(): TaskWorktreeStoreData {
    const data = this.store.read();
    if (!isRecord(data) || data.version !== 1 || !isRecord(data.entries))
      throw new Error(`Task worktree store is not readable: ${this.path}`);
    return data;
  }

  private unreadableLogged = false;

  /** For reads: an unreadable file has no entries (see the module note). */
  private loadForRead(): TaskWorktreeStoreData {
    try {
      const data = this.load();
      this.unreadableLogged = false;
      return data;
    } catch (error) {
      if (!this.unreadableLogged) {
        this.unreadableLogged = true;
        logger.warn('Task worktree store is unreadable; reading no entries', {
          path: this.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { version: 1, entries: {} };
    }
  }

  /** The Task's entry for this incarnation, if any. */
  read(taskId: string, taskCreatedAt: string): TaskWorktreeEntry | undefined {
    const entry = parseTaskWorktreeEntry(
      taskId,
      this.loadForRead().entries[taskId],
    );
    return entry?.taskCreatedAt === taskCreatedAt ? entry : undefined;
  }

  /** Every valid entry, for the deferred-finalization sweep. */
  list(): Array<{ taskId: string; entry: TaskWorktreeEntry }> {
    return Object.entries(this.loadForRead().entries).flatMap(
      ([taskId, value]) => {
        const entry = parseTaskWorktreeEntry(taskId, value);
        return entry ? [{ taskId, entry }] : [];
      },
    );
  }

  /**
   * Replaces (or, with `undefined`, removes) the Task's entry under the
   * store's cross-process lock. `transition` sees the current valid entry.
   */
  async update(
    taskId: string,
    transition: (
      current: TaskWorktreeEntry | undefined,
    ) => TaskWorktreeEntry | undefined,
  ): Promise<void> {
    const release = await this.acquireLock(`${this.path}.mutation`);
    try {
      const data = this.load();
      const next = transition(
        parseTaskWorktreeEntry(taskId, data.entries[taskId]),
      );
      const entries = { ...data.entries };
      if (next) entries[taskId] = next;
      else delete entries[taskId];
      this.store.write({ version: 1, entries });
    } finally {
      await release();
    }
  }
}
