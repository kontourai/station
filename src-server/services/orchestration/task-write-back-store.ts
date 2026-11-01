import { randomUUID } from 'node:crypto';
import {
  isTaskWriteBackText,
  parseTaskWriteBackInitiator,
  parseTaskWriteBackLog,
  parseTaskWriteBackTarget,
  TASK_WRITE_BACK_LIMITS,
  type TaskWriteBackEntry,
  type TaskWriteBackInitiator,
  type TaskWriteBackTarget,
} from '@kontourai/station-contracts/task-write-back';
import type { SqliteDatabase } from './sqlite-database.js';

export interface TaskWriteBackScope {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskCreatedAt: string;
}
export interface TaskWriteBackAdmission extends TaskWriteBackScope {
  readonly initiatedBy: TaskWriteBackInitiator;
  /** The caller's live Task and principal authority, checked inside the transaction. */
  readonly beforeCommit: () => boolean;
}
export type TaskWriteBackRefusal =
  | 'invalid'
  | 'stale'
  | 'limit'
  | 'retry-not-failed'
  | 'not-pending';
export type TaskWriteBackResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: TaskWriteBackRefusal };
export type TaskWriteBackOutcome =
  | { readonly state: 'succeeded' }
  | { readonly state: 'failed'; readonly reason: string };
export interface TaskWriteBackStore {
  list(scope: TaskWriteBackScope): readonly TaskWriteBackEntry[];
  start(
    input: TaskWriteBackAdmission & { readonly target: TaskWriteBackTarget },
  ): TaskWriteBackResult<TaskWriteBackEntry>;
  retry(
    input: TaskWriteBackAdmission & { readonly originalId: string },
  ): TaskWriteBackResult<TaskWriteBackEntry>;
  settle(
    scope: TaskWriteBackScope,
    id: string,
    outcome: TaskWriteBackOutcome,
  ): TaskWriteBackResult<TaskWriteBackEntry>;
}

const text = (
  value: unknown,
  max: number = TASK_WRITE_BACK_LIMITS.idChars,
): value is string => isTaskWriteBackText(value, max);
const validScope = (scope: TaskWriteBackScope) =>
  text(scope.projectId) && text(scope.taskId) && text(scope.taskCreatedAt);
const refusal = (code: TaskWriteBackRefusal): TaskWriteBackResult<never> => ({
  ok: false,
  code,
});

interface Row {
  id: string;
  task_id: string;
  task_created_at: string;
  ordinal: number;
  target_json: string;
  initiator_json: string;
  attempted_at: string;
  retry_of: string | null;
  state: 'succeeded' | 'failed' | null;
  failure_reason: string | null;
  settled_at: string | null;
}

export function createSqliteTaskWriteBackStore(
  db: SqliteDatabase,
): TaskWriteBackStore {
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = run();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const list = (scope: TaskWriteBackScope): readonly TaskWriteBackEntry[] => {
    if (!validScope(scope)) throw new Error('Invalid Task write-back scope.');
    const rows = db
      .prepare(`SELECT a.*, o.state, o.failure_reason, o.settled_at
      FROM task_write_back_attempts a LEFT JOIN task_write_back_outcomes o ON o.attempt_id = a.id
      WHERE a.project_id = ? AND a.task_id = ? AND a.task_created_at = ? ORDER BY a.ordinal`)
      .all(scope.projectId, scope.taskId, scope.taskCreatedAt) as Row[];
    const parsed = parseTaskWriteBackLog({
      entries: rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        taskCreatedAt: row.task_created_at,
        ordinal: row.ordinal,
        target: JSON.parse(row.target_json),
        initiatedBy: JSON.parse(row.initiator_json),
        attemptedAt: row.attempted_at,
        retryOf: row.retry_of,
        state: row.state ?? 'pending',
        failureReason: row.failure_reason,
        settledAt: row.settled_at,
      })),
    });
    if (!parsed) throw new Error('Task write-back log is invalid.');
    return parsed.entries;
  };
  const admit = (
    input: TaskWriteBackAdmission,
    target: TaskWriteBackTarget | undefined,
    originalId: string | null,
  ): TaskWriteBackResult<TaskWriteBackEntry> => {
    const initiator = parseTaskWriteBackInitiator(input.initiatedBy);
    if (
      !validScope(input) ||
      !initiator ||
      (target && !parseTaskWriteBackTarget(target)) ||
      (originalId !== null && !text(originalId))
    )
      return refusal('invalid');
    return transaction(() => {
      const entries = list(input);
      if (entries.length >= TASK_WRITE_BACK_LIMITS.attemptsPerTask)
        return refusal('limit');
      let selectedTarget = target;
      if (originalId !== null) {
        const original = entries.find(
          (entry) => entry.id === originalId && entry.retryOf === null,
        );
        const chain = entries.filter(
          (entry) => entry.id === originalId || entry.retryOf === originalId,
        );
        if (!original || chain.at(-1)?.state !== 'failed')
          return refusal('retry-not-failed');
        selectedTarget = original.target;
      }
      if (!selectedTarget) return refusal('invalid');
      if (!input.beforeCommit()) return refusal('stale');
      const id = randomUUID();
      db.prepare(`INSERT INTO task_write_back_attempts
        (id, project_id, task_id, task_created_at, ordinal, target_json, initiator_json, attempted_at, retry_of)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.projectId,
        input.taskId,
        input.taskCreatedAt,
        entries.length + 1,
        JSON.stringify(selectedTarget),
        JSON.stringify(initiator),
        new Date().toISOString(),
        originalId,
      );
      const entry = list(input).at(-1);
      if (!entry || entry.id !== id)
        throw new Error('Task write-back attempt was not recorded.');
      return { ok: true, value: entry };
    });
  };
  return {
    list,
    start: (input) => admit(input, input.target, null),
    retry: (input) => admit(input, undefined, input.originalId),
    settle: (scope, id, outcome) => {
      if (
        !validScope(scope) ||
        !text(id) ||
        (outcome.state !== 'succeeded' && outcome.state !== 'failed') ||
        (outcome.state === 'failed' &&
          !text(outcome.reason, TASK_WRITE_BACK_LIMITS.reasonChars))
      )
        return refusal('invalid');
      return transaction(() => {
        const entry = list(scope).find((candidate) => candidate.id === id);
        if (!entry || entry.state !== 'pending') return refusal('not-pending');
        db.prepare(
          'INSERT INTO task_write_back_outcomes (attempt_id, state, failure_reason, settled_at) VALUES (?, ?, ?, ?)',
        ).run(
          id,
          outcome.state,
          outcome.state === 'failed' ? outcome.reason : null,
          new Date().toISOString(),
        );
        const settled = list(scope).find((candidate) => candidate.id === id);
        if (!settled)
          throw new Error('Task write-back outcome was not recorded.');
        return { ok: true, value: settled };
      });
    },
  };
}

/** Task-bound outbound adapters use this seam; a refusal never invokes the write. */
export async function performTaskWriteBack<T>(
  store: TaskWriteBackStore,
  input: TaskWriteBackAdmission &
    (
      | { readonly target: TaskWriteBackTarget; readonly originalId?: never }
      | { readonly originalId: string; readonly target?: never }
    ),
  write: () => Promise<
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly reason: string }
  >,
): Promise<
  TaskWriteBackResult<{
    readonly entry: TaskWriteBackEntry;
    readonly value?: T;
  }>
> {
  const attempt =
    input.originalId === undefined
      ? store.start({ ...input, target: input.target })
      : store.retry({ ...input, originalId: input.originalId });
  if (!attempt.ok) return attempt;
  let result: Awaited<ReturnType<typeof write>>;
  try {
    result = await write();
  } catch {
    result = {
      ok: false,
      reason: 'The write failed or could not be confirmed.',
    };
  }
  const reason =
    !result.ok && text(result.reason, TASK_WRITE_BACK_LIMITS.reasonChars)
      ? result.reason
      : 'The write failed or could not be confirmed.';
  const settled = store.settle(
    input,
    attempt.value.id,
    result.ok ? { state: 'succeeded' } : { state: 'failed', reason },
  );
  if (!settled.ok)
    throw new Error('Task write-back outcome could not be recorded.');
  return {
    ok: true,
    value: {
      entry: settled.value,
      ...(result.ok ? { value: result.value } : {}),
    },
  };
}
