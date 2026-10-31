import {
  boundaryText,
  closedRecord,
  enumValue,
} from './contract-validation.js';

/** Each attempt is retained; reaching the bound refuses a new external write. */
export const TASK_WRITE_BACK_LIMITS = Object.freeze({
  attemptsPerTask: 256,
  idChars: 256,
  targetChars: 1024,
  reasonChars: 500,
});

export const isTaskWriteBackText = (
  value: unknown,
  max: number,
): value is string => boundaryText(value, max);

export type TaskWriteBackTarget = {
  readonly kind: 'chat' | 'pull-request' | 'tracker';
  readonly system: string;
  readonly destination: string;
  readonly action: string;
};
export type TaskWriteBackInitiator = {
  readonly kind: 'person' | 'session' | 'system';
  readonly id: string;
};
export interface TaskWriteBackEntry {
  readonly id: string;
  readonly taskId: string;
  readonly taskCreatedAt: string;
  readonly ordinal: number;
  readonly target: TaskWriteBackTarget;
  readonly initiatedBy: TaskWriteBackInitiator;
  readonly attemptedAt: string;
  /** Identifies the first attempt, not the previous retry. */
  readonly retryOf: string | null;
  readonly state: 'pending' | 'succeeded' | 'failed';
  readonly failureReason: string | null;
  readonly settledAt: string | null;
}
export interface TaskWriteBackLog {
  readonly entries: readonly TaskWriteBackEntry[];
}

export function parseTaskWriteBackTarget(
  value: unknown,
): TaskWriteBackTarget | null {
  if (
    !closedRecord(value, ['kind', 'system', 'destination', 'action']) ||
    !enumValue(value.kind, ['chat', 'pull-request', 'tracker'] as const) ||
    !boundaryText(value.system, TASK_WRITE_BACK_LIMITS.idChars) ||
    !boundaryText(value.destination, TASK_WRITE_BACK_LIMITS.targetChars) ||
    !boundaryText(value.action, TASK_WRITE_BACK_LIMITS.idChars)
  )
    return null;
  return {
    kind: value.kind,
    system: value.system,
    destination: value.destination,
    action: value.action,
  };
}

export function parseTaskWriteBackInitiator(
  value: unknown,
): TaskWriteBackInitiator | null {
  if (
    !closedRecord(value, ['kind', 'id']) ||
    !enumValue(value.kind, ['person', 'session', 'system'] as const) ||
    !boundaryText(value.id, TASK_WRITE_BACK_LIMITS.idChars)
  )
    return null;
  return { kind: value.kind, id: value.id };
}

export function parseTaskWriteBackLog(value: unknown): TaskWriteBackLog | null {
  if (
    !closedRecord(value, ['entries']) ||
    !Array.isArray(value.entries) ||
    value.entries.length > TASK_WRITE_BACK_LIMITS.attemptsPerTask
  )
    return null;
  const entries: TaskWriteBackEntry[] = [];
  const seen = new Set<string>();
  for (const row of value.entries) {
    if (
      !closedRecord(row, [
        'id',
        'taskId',
        'taskCreatedAt',
        'ordinal',
        'target',
        'initiatedBy',
        'attemptedAt',
        'retryOf',
        'state',
        'failureReason',
        'settledAt',
      ])
    )
      return null;
    const target = parseTaskWriteBackTarget(row.target);
    const initiatedBy = parseTaskWriteBackInitiator(row.initiatedBy);
    if (
      !boundaryText(row.id, TASK_WRITE_BACK_LIMITS.idChars) ||
      seen.has(row.id) ||
      !boundaryText(row.taskId, TASK_WRITE_BACK_LIMITS.idChars) ||
      !boundaryText(row.taskCreatedAt, TASK_WRITE_BACK_LIMITS.idChars) ||
      !Number.isSafeInteger(row.ordinal) ||
      row.ordinal !== entries.length + 1 ||
      !target ||
      !initiatedBy ||
      !boundaryText(row.attemptedAt, TASK_WRITE_BACK_LIMITS.idChars) ||
      !(
        row.retryOf === null ||
        (boundaryText(row.retryOf, TASK_WRITE_BACK_LIMITS.idChars) &&
          seen.has(row.retryOf))
      ) ||
      !enumValue(row.state, ['pending', 'succeeded', 'failed'] as const) ||
      !(row.state === 'failed'
        ? boundaryText(row.failureReason, TASK_WRITE_BACK_LIMITS.reasonChars)
        : row.failureReason === null) ||
      !(row.state === 'pending'
        ? row.settledAt === null
        : boundaryText(row.settledAt, TASK_WRITE_BACK_LIMITS.idChars))
    )
      return null;
    const first = entries[0];
    if (
      first &&
      (first.taskId !== row.taskId || first.taskCreatedAt !== row.taskCreatedAt)
    )
      return null;
    if (row.retryOf !== null) {
      const original = entries.find((entry) => entry.id === row.retryOf);
      const previous = entries
        .slice()
        .reverse()
        .find(
          (entry) => entry.id === row.retryOf || entry.retryOf === row.retryOf,
        );
      if (
        !original ||
        original.retryOf !== null ||
        previous?.state !== 'failed' ||
        original.target.kind !== target.kind ||
        original.target.system !== target.system ||
        original.target.destination !== target.destination ||
        original.target.action !== target.action
      )
        return null;
    }
    seen.add(row.id);
    entries.push({
      id: row.id,
      taskId: row.taskId,
      taskCreatedAt: row.taskCreatedAt,
      ordinal: row.ordinal as number,
      target,
      initiatedBy,
      attemptedAt: row.attemptedAt,
      retryOf: row.retryOf,
      state: row.state,
      failureReason: row.failureReason as string | null,
      settledAt: row.settledAt as string | null,
    });
  }
  return { entries };
}
