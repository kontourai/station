import type {
  TaskLearningDismissal,
  TaskLearningPromotion,
  TaskLearningView,
  TaskMemoryRecord,
  TaskMemoryView,
  TaskRecordWrite,
  TaskSummaryHistoryView,
  TaskSummaryRevision,
} from '@kontourai/station-contracts/task-memory';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch, StationHttpError } from '../client/http';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

// ── Task memory (#4003) ──────────────────────────────────────────────────
//
// The judgment layer of a Task: one summary that agents and people rewrite,
// and keyed decisions, questions and dead ends. A person reads and edits it
// from the Task workspace under the same bounds and refusals agents get.

export type {
  TaskLearningCandidate,
  TaskLearningDismissal,
  TaskLearningPromotion,
  TaskLearningReview,
  TaskLearningStore,
  TaskLearningView,
  TaskMemoryRecord,
  TaskMemoryView,
  TaskRecordWrite,
  TaskSummaryHistoryView,
  TaskSummaryRevision,
} from '@kontourai/station-contracts/task-memory';

/**
 * The summary changed since the revision the edit was based on. Nothing was
 * written; `current` is the summary to merge with.
 */
export class TaskSummaryConflictError extends StationHttpError {
  constructor(
    message: string,
    readonly current: TaskSummaryRevision | null,
  ) {
    super(409, message, { code: 'task_summary_stale_base' });
    this.name = 'TaskSummaryConflictError';
  }
}

interface MemoryResult<T> {
  success?: boolean;
  data?: T;
  error?: string;
  code?: string;
  current?: TaskSummaryRevision | null;
}

async function readResult<T>(response: Response, fallback: string): Promise<T> {
  const result = (await response.json()) as MemoryResult<T>;
  if (response.ok && result.success && result.data !== undefined)
    return result.data;
  const message = apiErrorMessage(result, fallback);
  if (result.code === 'task_summary_stale_base')
    throw new TaskSummaryConflictError(message, result.current ?? null);
  throw new StationHttpError(
    response.status,
    message,
    result.code ? { code: result.code } : undefined,
  );
}

const memoryPath = async (taskId: string, rest = '') =>
  `${await _getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/room/memory${rest}`;

export const taskMemoryQueryKey = (taskId: string) =>
  ['task-memory', taskId] as const;

export async function fetchTaskMemory(taskId: string): Promise<TaskMemoryView> {
  const response = await authenticatedFetch(await memoryPath(taskId));
  return readResult(response, 'Failed to read the Task memory');
}

export async function fetchTaskSummaryHistory(
  taskId: string,
  limit = 20,
): Promise<TaskSummaryHistoryView> {
  const response = await authenticatedFetch(
    await memoryPath(taskId, `/summary/revisions?limit=${limit}`),
  );
  return readResult(response, 'Failed to read the summary history');
}

/** Throws `TaskSummaryConflictError` when `baseRevision` is no longer current. */
export async function updateTaskSummary(input: {
  taskId: string;
  text: string;
  baseRevision: number;
}): Promise<TaskSummaryRevision> {
  const response = await authenticatedFetch(
    await memoryPath(input.taskId, '/summary'),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        baseRevision: input.baseRevision,
      }),
    },
  );
  return readResult(response, 'Failed to save the summary');
}

export async function writeTaskRecord(
  input: { taskId: string } & TaskRecordWrite,
): Promise<TaskMemoryRecord> {
  const { taskId, ...write } = input;
  const response = await authenticatedFetch(
    await memoryPath(taskId, '/records'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(write),
    },
  );
  return readResult(response, 'Failed to save the record');
}

export function useTaskMemoryQuery(
  taskId: string,
  config?: QueryConfig<TaskMemoryView>,
) {
  return useApiQuery<TaskMemoryView>(
    [...taskMemoryQueryKey(taskId)],
    () => fetchTaskMemory(taskId),
    { ...config, enabled: taskId.length > 0 && (config?.enabled ?? true) },
  );
}

export function useTaskSummaryHistoryQuery(
  taskId: string,
  config?: QueryConfig<TaskSummaryHistoryView>,
) {
  return useApiQuery<TaskSummaryHistoryView>(
    [...taskMemoryQueryKey(taskId), 'summary-history'],
    () => fetchTaskSummaryHistory(taskId),
    { ...config, enabled: taskId.length > 0 && (config?.enabled ?? true) },
  );
}

/** A person's summary edit; the memory refreshes when it is saved. */
export function useUpdateTaskSummaryMutation(taskId: string) {
  return useApiMutation(
    (input: { text: string; baseRevision: number }) =>
      updateTaskSummary({ taskId, ...input }),
    { invalidateKeys: [[...taskMemoryQueryKey(taskId)]] },
  );
}

/**
 * A person's record write (an answer, say). The Tasks list refreshes too: an
 * answered question can take the Task out of "Needs you".
 */
export function useWriteTaskRecordMutation(taskId: string) {
  return useApiMutation(
    (write: TaskRecordWrite) => writeTaskRecord({ taskId, ...write }),
    { invalidateKeys: [[...taskMemoryQueryKey(taskId)], ['tasks']] },
  );
}

// ── Learning (#4003, layer 4) ──────────────────────────────────────────────
//
// A done Task's standing decisions and dead ends, offered for the Project's
// knowledge store. A person promotes one (edited) or dismisses it; nothing
// is promoted on its own.

export const taskLearningQueryKey = (taskId: string) =>
  [...taskMemoryQueryKey(taskId), 'learning'] as const;

export async function fetchTaskLearning(
  taskId: string,
): Promise<TaskLearningView> {
  const response = await authenticatedFetch(
    await memoryPath(taskId, '/learning'),
  );
  return readResult(response, 'Failed to read the Task lessons');
}

export interface TaskLearningPromoteResult {
  /** `already-promoted`: this version was promoted before; nothing new was written. */
  readonly status: 'promoted' | 'already-promoted';
  readonly rootId: string;
  readonly record: { readonly id: string; readonly title: string };
}

export async function promoteTaskLearning(
  input: { taskId: string } & TaskLearningPromotion,
): Promise<TaskLearningPromoteResult> {
  const { taskId, ...promotion } = input;
  const response = await authenticatedFetch(
    await memoryPath(taskId, '/learning/promote'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(promotion),
    },
  );
  return readResult(response, 'Failed to promote the record');
}

export async function dismissTaskLearning(
  input: { taskId: string } & TaskLearningDismissal,
): Promise<{ status: 'dismissed' | 'already-dismissed' }> {
  const { taskId, ...dismissal } = input;
  const response = await authenticatedFetch(
    await memoryPath(taskId, '/learning/dismiss'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dismissal),
    },
  );
  return readResult(response, 'Failed to dismiss the record');
}

export function useTaskLearningQuery(
  taskId: string,
  config?: QueryConfig<TaskLearningView>,
) {
  return useApiQuery<TaskLearningView>(
    [...taskLearningQueryKey(taskId)],
    () => fetchTaskLearning(taskId),
    { ...config, enabled: taskId.length > 0 && (config?.enabled ?? true) },
  );
}

/** A person's promotion; the candidates and the Knowledge views refresh. */
export function usePromoteTaskLearningMutation(taskId: string) {
  return useApiMutation(
    (promotion: TaskLearningPromotion) =>
      promoteTaskLearning({ taskId, ...promotion }),
    { invalidateKeys: [[...taskLearningQueryKey(taskId)], ['knowledge']] },
  );
}

export function useDismissTaskLearningMutation(taskId: string) {
  return useApiMutation(
    (dismissal: TaskLearningDismissal) =>
      dismissTaskLearning({ taskId, ...dismissal }),
    { invalidateKeys: [[...taskLearningQueryKey(taskId)]] },
  );
}
