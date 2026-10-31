import {
  parseTaskWriteBackLog,
  type TaskWriteBackLog,
} from '@kontourai/station-contracts/task-write-back';
import { envelopeError } from '../client/api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  StationHttpError,
} from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
import { type QueryConfig, useApiQuery } from '../query-core';

export type {
  TaskWriteBackEntry,
  TaskWriteBackLog,
} from '@kontourai/station-contracts/task-write-back';

export async function fetchTaskWriteBack(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<TaskWriteBackLog> {
  const base = options?.requestScope?.apiBase ?? apiBase;
  const response = await getJson(
    `${base}/api/tasks/${encodeURIComponent(taskId)}/write-back`,
    { ...options, maxResponseBytes: 4_194_304 },
  );
  if (response.status === 404)
    throw new StationHttpError(
      404,
      'Task write-back is unavailable for this Task or is not supported by this Station. Update the host if needed.',
    );
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (!response.ok)
    throw envelopeError(response, body, 'Task write-back unavailable');
  if (
    !body ||
    typeof body !== 'object' ||
    !('success' in body) ||
    body.success !== true ||
    !('data' in body)
  )
    throw new Error('Task write-back response is invalid.');
  const log = parseTaskWriteBackLog(body.data);
  if (!log || log.entries.some((entry) => entry.taskId !== taskId))
    throw new Error('Task write-back response is invalid.');
  return log;
}

export function useTaskWriteBackQuery(
  apiBase: string,
  taskId: string,
  config?: QueryConfig<TaskWriteBackLog> & {
    requestScope?: ClientRequestOptions['requestScope'];
  },
) {
  return useApiQuery<TaskWriteBackLog>(
    [
      'task-write-back',
      config?.requestScope?.apiBase ?? apiBase,
      config?.requestScope?.authorityKey ?? 'default',
      taskId,
    ],
    (signal) =>
      fetchTaskWriteBack(apiBase, taskId, {
        signal,
        requestScope: config?.requestScope,
      }),
    {
      ...config,
      enabled: !!taskId && (config?.enabled ?? true),
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      retry: false,
      keepPreviousData: false,
    },
  );
}
