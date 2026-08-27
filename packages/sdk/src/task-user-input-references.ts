/**
 * Dedicated Task user-input React surface. The SDK root retains imperative
 * functions and types; hooks stay here so eager consumers do not hoist them.
 */

import type {
  RelationGraphLink,
  TaskUserInputReferenceProjection,
} from '@kontourai/station-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TaskUserInputReferenceRequestError } from './client/task-user-input-references';
import {
  type MutationOptions,
  type QueryConfig,
  useApiQuery,
} from './query-core';
import {
  type CreateTaskUserInputReferenceInput,
  createTaskUserInputReference,
  fetchTaskUserInputReferences,
} from './query-domains/taskGraph';
import { taskQueries } from './queryFactories';

export type {
  TaskUserInputReference,
  TaskUserInputReferenceInput,
  TaskUserInputReferenceProjection,
} from './query-domains/taskGraph';

function lostAuthority(
  error: unknown,
): error is TaskUserInputReferenceRequestError {
  return (
    error instanceof TaskUserInputReferenceRequestError &&
    [401, 403, 404, 503].includes(error.status)
  );
}

function revokeTaskScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
  keepInput = false,
) {
  const inputKey = taskQueries.userInputReferences(taskId).queryKey;
  for (const queryKey of [
    inputKey,
    taskQueries.turnReferences(taskId).queryKey,
    taskQueries.graph(taskId).queryKey,
  ]) {
    if (keepInput && queryKey === inputKey) continue;
    void client.cancelQueries({ queryKey, exact: true });
    client.removeQueries({ queryKey, exact: true });
  }
  void client.cancelQueries({ queryKey: ['answer-support', taskId] });
  client.removeQueries({ queryKey: ['answer-support', taskId] });
}

function invalidateTaskScope(
  client: ReturnType<typeof useQueryClient>,
  taskId: string,
) {
  for (const queryKey of [
    taskQueries.list().queryKey,
    taskQueries.task(taskId).queryKey,
    taskQueries.graph(taskId).queryKey,
    taskQueries.turnReferences(taskId).queryKey,
    taskQueries.userInputReferences(taskId).queryKey,
  ])
    client.invalidateQueries({ queryKey, exact: true });
}

export function useTaskUserInputReferencesQuery(
  taskId: string,
  config?: QueryConfig<TaskUserInputReferenceProjection[]>,
) {
  const client = useQueryClient();
  const query = useApiQuery(
    taskQueries.userInputReferences(taskId).queryKey,
    async () => {
      try {
        return await fetchTaskUserInputReferences(taskId);
      } catch (error) {
        if (lostAuthority(error)) {
          client.setQueryData<
            | TaskUserInputReferenceProjection[]
            | TaskUserInputReferenceRequestError
          >(taskQueries.userInputReferences(taskId).queryKey, error);
          revokeTaskScope(client, taskId, true);
        }
        throw error;
      }
    },
    {
      staleTime:
        config?.staleTime ?? taskQueries.userInputReferences(taskId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? taskId.length > 0,
      refetchOnMount: config?.refetchOnMount ?? 'always',
      retry: false,
    },
  );
  const protectedError =
    query.data instanceof TaskUserInputReferenceRequestError
      ? query.data
      : undefined;
  return {
    ...query,
    error: protectedError ?? query.error,
    status: protectedError ? 'error' : query.status,
    data:
      !protectedError &&
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
    isLoading:
      !protectedError &&
      (!query.isFetchedAfterMount || query.isLoading || query.isFetching),
  };
}

export function useAttachTaskUserInputReferenceMutation(
  options?: MutationOptions<
    RelationGraphLink,
    CreateTaskUserInputReferenceInput
  >,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createTaskUserInputReference,
    onSuccess: (data, variables) => {
      invalidateTaskScope(client, variables.taskId);
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      if (lostAuthority(error)) revokeTaskScope(client, variables.taskId);
      options?.onError?.(error as Error, variables);
    },
  });
}
