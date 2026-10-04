import type {
  TaskDeclaredOutputKeepResult,
  TaskOutputCreateInput,
  TaskOutputRecord,
} from '@kontourai/station-contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createTaskOutputClient,
  deleteTaskOutputClient,
  keepDeclaredTaskOutput,
  listTaskOutputs,
} from './client/task-outputs';
import { type QueryConfig, resolveApiBase, useApiQuery } from './query-core';
import type { TaskRoomWorkRequestScope } from './query-domains/taskRoomWork';
import { sessionInventoryQueries } from './session-inventory';

export {
  downloadTaskOutputContent,
  getTaskOutput,
  listTaskOutputs,
} from './client/task-outputs';
export const taskOutputQueries = {
  outputs: (taskId: string) => ({
    queryKey: ['task-outputs', taskId],
    staleTime: 10_000,
  }),
};
export async function fetchTaskOutputs(
  taskId: string,
  apiBase?: string,
): Promise<TaskOutputRecord[]> {
  return listTaskOutputs(await resolveApiBase(apiBase), taskId);
}
export async function createTaskOutput(
  input: TaskOutputCreateInput & { taskId: string; apiBase?: string },
): Promise<TaskOutputRecord> {
  const { taskId, apiBase, ...body } = input;
  return createTaskOutputClient(await resolveApiBase(apiBase), taskId, body);
}
export async function deleteTaskOutput(input: {
  taskId: string;
  outputId: string;
  apiBase?: string;
}): Promise<void> {
  await deleteTaskOutputClient(
    await resolveApiBase(input.apiBase),
    input.taskId,
    input.outputId,
  );
}
export async function keepDeclaredOutput(input: {
  taskId: string;
  sessionId: string;
  eventId: string;
  operationId: string;
  apiBase?: string;
}): Promise<TaskDeclaredOutputKeepResult> {
  return keepDeclaredTaskOutput(
    await resolveApiBase(input.apiBase),
    input.taskId,
    input.sessionId,
    input.eventId,
    { operationId: input.operationId },
  );
}
export function useTaskOutputsQuery(
  taskId: string,
  config?: QueryConfig<TaskOutputRecord[]> & {
    requestScope?: TaskRoomWorkRequestScope;
    taskCreatedAt?: string;
  },
) {
  const query = taskOutputQueries.outputs(taskId);
  const scope = config?.requestScope;
  const scoped = config?.taskCreatedAt !== undefined;
  const key = scoped
    ? [
        ...query.queryKey,
        scope?.apiBase ?? null,
        scope?.authorityKey ?? null,
        config?.taskCreatedAt ?? null,
      ]
    : query.queryKey;
  return useApiQuery(
    key,
    async (signal) => {
      if (!scoped) return fetchTaskOutputs(taskId);
      if (!scope?.isCurrent())
        throw new Error('Task output connection changed.');
      const value = await listTaskOutputs(scope.apiBase, taskId, {
        requestScope: scope,
        signal,
      });
      if (!scope.isCurrent())
        throw new Error('Task output connection changed.');
      return value;
    },
    {
      staleTime: config?.staleTime ?? query.staleTime,
      gcTime: config?.gcTime,
      enabled:
        (config?.enabled ?? taskId.length > 0) &&
        (!scoped || !!scope?.isCurrent()),
      refetchOnMount: config?.refetchOnMount ?? 'always',
    },
  );
}
export function useCreateTaskOutputMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createTaskOutput,
    onSuccess: (_data, input) =>
      client.invalidateQueries({
        queryKey: taskOutputQueries.outputs(input.taskId).queryKey,
      }),
  });
}
export function useDeleteTaskOutputMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteTaskOutput,
    onSuccess: (_data, input) =>
      client.invalidateQueries({
        queryKey: taskOutputQueries.outputs(input.taskId).queryKey,
      }),
  });
}
export function useKeepDeclaredOutputMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: keepDeclaredOutput,
    onSuccess: (_data, input) =>
      Promise.all([
        client.invalidateQueries({
          queryKey: taskOutputQueries.outputs(input.taskId).queryKey,
        }),
        client.invalidateQueries({ queryKey: ['task-basis', input.taskId] }),
        client.invalidateQueries({
          queryKey: ['task-references', input.taskId],
        }),
        client.invalidateQueries({
          predicate: (query) =>
            Array.isArray(query.queryKey) &&
            (query.queryKey[0] ===
              sessionInventoryQueries.projection({
                kind: 'whole-session',
                sessionId: input.sessionId,
              }).queryKey[0] ||
              query.queryKey[0] === 'session-inventory-page') &&
            JSON.stringify(query.queryKey).includes(input.sessionId),
        }),
      ]),
  });
}
