import type {
  TaskReviewCreateThreadRequest,
  TaskReviewReopenRequest,
  TaskReviewReplyRequest,
  TaskReviewResolveRequest,
  TaskReviewResponse,
  TaskReviewThreadView,
  TaskReviewView,
} from '@kontourai/station-contracts/task-review';
import { useQuery } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { authenticatedFetch, StationHttpError } from '../client/http';
import { type QueryConfig, useApiMutation } from '../query-core';

export type {
  TaskReviewCreateThreadRequest,
  TaskReviewReopenRequest,
  TaskReviewReplyRequest,
  TaskReviewResolveRequest,
  TaskReviewThreadView,
  TaskReviewView,
} from '@kontourai/station-contracts/task-review';

export const taskReviewQueryKey = (taskId: string) =>
  ['task-review', taskId] as const;
const path = async (taskId: string, suffix = '') =>
  `${await _getApiBase()}/api/tasks/${encodeURIComponent(taskId)}/review${suffix}`;
async function result<T>(response: Response): Promise<T> {
  const body = (await response.json()) as TaskReviewResponse<T>;
  if (response.ok && body.success) return body.data;
  throw new StationHttpError(
    response.status,
    body.success ? 'Task review request failed.' : body.error,
    body.success ? undefined : { code: body.code },
  );
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
      query.state.data?.threads.some((thread) => thread.baseState === 'sent')
        ? 3000
        : false,
  });
}
export function useCreateReviewThreadMutation(taskId: string) {
  return useApiMutation(
    (input: TaskReviewCreateThreadRequest) => mutate(taskId, '/threads', input),
    { invalidateKeys: [[...taskReviewQueryKey(taskId)]] },
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
    { invalidateKeys: [[...taskReviewQueryKey(taskId)]] },
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
    { invalidateKeys: [[...taskReviewQueryKey(taskId)]] },
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
    { invalidateKeys: [[...taskReviewQueryKey(taskId)]] },
  );
}
