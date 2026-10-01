import type { TaskRoomWorkInput } from '@kontourai/station-contracts/task-room-work';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { discoverDelegationOptions } from '../client/delegations';
import type { ApiRequestScope } from '../client/http';
import {
  fetchTaskRoomAgentRequests,
  submitTaskRoomAgentRequest,
  TaskRoomWorkNotSentError,
} from '../client/task-room-work';

export type TaskRoomWorkRequestScope = ApiRequestScope & {
  isCurrent: () => boolean;
};

function current(
  scope: TaskRoomWorkRequestScope | undefined,
): TaskRoomWorkRequestScope {
  if (!scope?.isCurrent())
    throw new Error('Task request connection changed. Reopen this Task.');
  return scope;
}

const requestKey = (
  taskId: string,
  incarnation: string,
  scope?: TaskRoomWorkRequestScope,
) =>
  [
    'task-room-agent-requests',
    scope?.apiBase,
    scope?.authorityKey,
    taskId,
    incarnation,
  ] as const;

export function useTaskRoomAgentRequestsQuery(
  taskId: string,
  incarnation: string,
  scope: TaskRoomWorkRequestScope | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: requestKey(taskId, incarnation, scope),
    enabled: enabled && !!scope && !!incarnation,
    retry: false,
    refetchInterval: enabled ? 5_000 : false,
    queryFn: async ({ signal }) => {
      const captured = current(scope);
      const result = await fetchTaskRoomAgentRequests(
        captured.apiBase,
        taskId,
        { requestScope: captured, signal },
      );
      current(captured);
      return {
        ...result,
        records: result.records.filter(
          (record) => record.taskCreatedAt === incarnation,
        ),
      };
    },
  });
}

export function useTaskRoomAgentOptionsQuery(
  projectSlug: string,
  scope: TaskRoomWorkRequestScope | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: [
      'task-room-agent-options',
      scope?.apiBase,
      scope?.authorityKey,
      projectSlug,
    ],
    enabled: enabled && !!scope && !!projectSlug,
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const captured = current(scope);
      const result = await discoverDelegationOptions(
        captured.apiBase,
        { projectSlug },
        { requestScope: captured, signal, readOnly: true },
      );
      current(captured);
      return result;
    },
  });
}

export function useSubmitTaskRoomAgentRequestMutation(
  taskId: string,
  incarnation: string,
  projectSlug: string,
  scope: TaskRoomWorkRequestScope | undefined,
) {
  const cache = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (input: TaskRoomWorkInput) => {
      const captured = current(scope);
      const readiness = await discoverDelegationOptions(
        captured.apiBase,
        { projectSlug },
        { requestScope: captured, readOnly: true },
      ).catch((cause: unknown) => {
        throw new TaskRoomWorkNotSentError(
          'Agent readiness could not be checked. Nothing was sent.',
          cause,
        );
      });
      current(captured);
      if (
        !readiness.targets.some(
          (target) => target.id === input.agentId && target.ready === true,
        )
      )
        throw new TaskRoomWorkNotSentError(
          'This agent is unavailable. Draft retained.',
        );
      const result = await submitTaskRoomAgentRequest(
        captured.apiBase,
        taskId,
        projectSlug,
        incarnation,
        input,
        { requestScope: captured },
      );
      current(captured);
      return result;
    },
    onSettled: () =>
      cache.invalidateQueries({
        queryKey: requestKey(taskId, incarnation, scope),
      }),
  });
}
