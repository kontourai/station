import type { IndependentReviewRequestStatus } from '@kontourai/station-contracts/review-evidence';
import type {
  TaskCodeReviewRequest,
  TaskCodeReviewView,
} from '@kontourai/station-contracts/task-review';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ApiRequestScope,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from '../client/http';

export const taskCodeReviewQueryKey = (
  scope: ApiRequestScope,
  taskId: string,
  taskCreatedAt: string,
) =>
  [
    'task-code-review',
    scope.apiBase,
    scope.authorityKey,
    taskId,
    taskCreatedAt,
  ] as const;
const path = (scope: ApiRequestScope, taskId: string) =>
  `${scope.apiBase}/api/tasks/${encodeURIComponent(taskId)}/review/code`;

export function useTaskCodeReviewQuery(
  scope: ApiRequestScope,
  taskId: string,
  taskCreatedAt: string,
  enabled = true,
) {
  const query = useQuery({
    queryKey: taskCodeReviewQueryKey(scope, taskId, taskCreatedAt),
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await getJson(
        `${path(scope, taskId)}?taskCreatedAt=${encodeURIComponent(taskCreatedAt)}`,
        { requestScope: scope, signal },
      );
      const view = await readEnvelopeOrThrow<TaskCodeReviewView>(response);
      if (
        view?.version !== 'station.task-code-review/v1' ||
        view.taskCreatedAt !== taskCreatedAt
      )
        throw new Error('Task review identity changed. Reopen this Task.');
      return view;
    },
    refetchInterval: (current) =>
      !current.state.error &&
      current.state.data?.requests.some(
        (request) => request.state === 'running',
      )
        ? 4000
        : false,
  });
  // A failed authority read must never keep protected cached content on screen.
  return { ...query, data: query.error ? undefined : query.data };
}

export function useRequestTaskCodeReviewMutation(
  scope: ApiRequestScope,
  taskId: string,
  taskCreatedAt: string,
) {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (request: TaskCodeReviewRequest) => {
      if (request.taskCreatedAt !== taskCreatedAt)
        throw new Error('Task review identity changed. Reopen this Task.');
      return readEnvelopeOrThrow<IndependentReviewRequestStatus>(
        await mutateJson(
          path(scope, taskId),
          'POST',
          { requestScope: scope },
          request,
        ),
      );
    },
    onSettled: () =>
      client.invalidateQueries({
        queryKey: taskCodeReviewQueryKey(scope, taskId, taskCreatedAt),
        exact: true,
      }),
  });
}
