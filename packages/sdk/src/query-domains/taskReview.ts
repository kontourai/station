import type {
  TaskReviewArtifactKind,
  TaskReviewCreateThreadRequest,
  TaskReviewItem,
  TaskReviewReopenRequest,
  TaskReviewReplyRequest,
  TaskReviewResolveRequest,
  TaskReviewResponse,
  TaskReviewRevision,
  TaskReviewThreadView,
  TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import { useQuery } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  authenticatedFetch,
  readJsonBody,
  StationHttpError,
} from '../client/http';
import { type QueryConfig, useApiMutation } from '../query-core';

export type {
  TaskReviewArtifactKind,
  TaskReviewCreateThreadRequest,
  TaskReviewItem,
  TaskReviewReopenRequest,
  TaskReviewReplyRequest,
  TaskReviewResolveRequest,
  TaskReviewThreadSummary,
  TaskReviewThreadView,
  TaskReviewView,
} from '@kontourai/station-contracts/task-review';
export { TASK_REVIEW_OPENING_PREVIEW_CHARS } from '@kontourai/station-contracts/task-review';

export const taskReviewQueryKey = (taskId: string) =>
  ['task-review', taskId] as const;
const path = async (taskId: string, suffix = '') =>
  `${await _getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/review${suffix}`;
async function result<T>(response: Response): Promise<T> {
  const body = (await readJsonBody(response)) as
    | TaskReviewResponse<T>
    | undefined;
  if (
    !body ||
    typeof body.success !== 'boolean' ||
    (body.success ? !('data' in body) : typeof body.error !== 'string')
  )
    throw new StationHttpError(
      response.status,
      'Invalid Task review response.',
    );
  if (response.ok && body.success) return body.data;
  throw new StationHttpError(
    response.status,
    body.success ? 'Task review request failed.' : body.error,
    body.success ? undefined : { code: body.code },
  );
}
export const taskReviewItemQueryKey = (
  taskId: string,
  kind: TaskReviewArtifactKind,
  id: string,
  revision?: TaskReviewRevision,
) => ['task-review-item', taskId, kind, id, revision] as const;
export async function fetchTaskReviewItem(
  taskId: string,
  kind: TaskReviewArtifactKind,
  id: string,
  signal?: AbortSignal,
): Promise<TaskReviewItem> {
  return result<TaskReviewItem>(
    await authenticatedFetch(
      await path(
        taskId,
        `/items/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      ),
      { signal },
    ),
  );
}
export function useTaskReviewItemQuery(
  taskId: string,
  kind: TaskReviewArtifactKind,
  id: string,
  config?: Omit<
    QueryConfig<TaskReviewItem>,
    'refetchInterval' | 'refetchIntervalForError'
  > & { revision?: TaskReviewRevision },
) {
  const { revision, ...queryConfig } = config ?? {};
  return useQuery({
    ...queryConfig,
    queryKey: taskReviewItemQueryKey(taskId, kind, id, revision),
    queryFn: ({ signal }) => fetchTaskReviewItem(taskId, kind, id, signal),
    enabled: taskId.length > 0 && id.length > 0 && (config?.enabled ?? true),
    refetchInterval: false,
  });
}

/** Supply the summary's event count and current revision to refresh an expanded card. */
export const taskReviewThreadQueryKey = (
  taskId: string,
  threadId: string,
  eventCount?: number,
  revision?: TaskReviewRevision,
) => ['task-review-thread', taskId, threadId, eventCount, revision] as const;
export async function fetchTaskReviewThread(
  taskId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<{ thread: TaskReviewThreadView }> {
  return result(
    await authenticatedFetch(
      await path(taskId, `/threads/${encodeURIComponent(threadId)}`),
      { signal },
    ),
  );
}
export function useTaskReviewThreadQuery(
  taskId: string,
  threadId: string,
  config?: Omit<
    QueryConfig<{ thread: TaskReviewThreadView }>,
    'refetchInterval' | 'refetchIntervalForError'
  > & { eventCount?: number; revision?: TaskReviewRevision },
) {
  const { eventCount, revision, ...queryConfig } = config ?? {};
  return useQuery({
    ...queryConfig,
    queryKey: taskReviewThreadQueryKey(taskId, threadId, eventCount, revision),
    queryFn: ({ signal }) => fetchTaskReviewThread(taskId, threadId, signal),
    enabled:
      taskId.length > 0 && threadId.length > 0 && (config?.enabled ?? true),
    refetchInterval: false,
  });
}

export async function fetchTaskReview(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskReviewView> {
  return result<TaskReviewView>(
    await authenticatedFetch(await path(taskId), { signal }),
  );
}
async function mutate(
  taskId: string,
  suffix: string,
  input: unknown,
): Promise<{ thread: TaskReviewThreadView }> {
  return result<{ thread: TaskReviewThreadView }>(
    await authenticatedFetch(await path(taskId, suffix), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}
export function useTaskReviewQuery(
  taskId: string,
  options?: Omit<
    QueryConfig<TaskReviewView>,
    'refetchInterval' | 'refetchIntervalForError'
  > & { poll?: boolean },
) {
  const { poll = false, ...config } = options ?? {};
  return useQuery({
    ...config,
    queryKey: taskReviewQueryKey(taskId),
    queryFn: ({ signal }) => fetchTaskReview(taskId, signal),
    enabled: taskId.length > 0 && (config.enabled ?? true),
    staleTime: config.staleTime ?? 5 * 60 * 1000,
    // The caller enables poll only while its Review tab is visible (R5).
    refetchInterval: (query) =>
      poll &&
      query.state.status !== 'error' &&
      query.state.data?.threads.some(
        (thread) =>
          thread.status === 'available' && thread.baseState === 'sent',
      )
        ? 3000
        : false,
  });
}
export function useCreateReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewCreateThreadRequest) => mutate(taskId, '/threads', input),
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
export function useReplyReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewReplyRequest & { threadId: string }) => {
      const { threadId, ...body } = input;
      return mutate(
        taskId,
        `/threads/${encodeURIComponent(threadId)}/replies`,
        body,
      );
    },
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
export function useResolveReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewResolveRequest & { threadId: string }) => {
      const { threadId, ...body } = input;
      return mutate(
        taskId,
        `/threads/${encodeURIComponent(threadId)}/resolve`,
        body,
      );
    },
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
export function useReopenReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewReopenRequest & { threadId: string }) => {
      const { threadId, ...body } = input;
      return mutate(
        taskId,
        `/threads/${encodeURIComponent(threadId)}/reopen`,
        body,
      );
    },
    {
      invalidateKeys: [
        [...taskReviewQueryKey(taskId)],
        ['task-review-thread', taskId],
      ],
    },
  );
}
