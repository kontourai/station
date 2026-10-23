import type {
  TaskChildCreateInput,
  TaskIdentity,
  TaskParentMutationInput,
  TaskParentMutationResult,
  TaskWorkChatMutationInput,
} from '@kontourai/station-contracts/task-graph';
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createTaskChild,
  fetchTaskChildren,
  fetchTaskWorkChats,
  setTaskParent,
  setTaskWorkChat,
} from '../client/task-relationships';
import type { TaskRoomWorkRequestScope } from './taskRoomWork';

export type TaskRelationshipScope = TaskRoomWorkRequestScope;
function current(scope: TaskRelationshipScope) {
  if (!scope.isCurrent())
    throw new Error('Task relationship connection changed');
  return scope;
}
export const taskRelationshipKey = (
  scope: TaskRelationshipScope,
  task: TaskIdentity,
  kind?: 'children' | 'work-chats',
) =>
  [
    'task-relationships',
    scope.apiBase,
    scope.authorityKey,
    task.taskId,
    task.taskCreatedAt,
    ...(kind ? [kind] : []),
  ] as const;

export async function invalidateTaskRelationships(
  client: QueryClient,
  scope: TaskRelationshipScope,
  result: TaskParentMutationResult,
) {
  const identities = [
    result.child,
    result.parent,
    result.previousParent,
  ].filter((item): item is TaskIdentity => !!item);
  await Promise.all(
    identities.map((task) =>
      client.invalidateQueries({ queryKey: taskRelationshipKey(scope, task) }),
    ),
  );
}

export function useTaskChildrenQuery(
  task: TaskIdentity,
  scope: TaskRelationshipScope,
) {
  return useQuery({
    queryKey: taskRelationshipKey(scope, task, 'children'),
    retry: false,
    refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      current(scope);
      const result = await fetchTaskChildren(scope.apiBase, task, {
        requestScope: scope,
        signal,
      });
      current(scope);
      if (
        result.task.taskId !== task.taskId ||
        result.task.taskCreatedAt !== task.taskCreatedAt
      )
        throw new Error('Task incarnation changed');
      return result;
    },
  });
}
export function useTaskWorkChatsQuery(
  task: TaskIdentity,
  scope: TaskRelationshipScope,
) {
  return useQuery({
    queryKey: taskRelationshipKey(scope, task, 'work-chats'),
    retry: false,
    refetchOnMount: 'always',
    queryFn: async ({ signal }) => {
      current(scope);
      const result = await fetchTaskWorkChats(scope.apiBase, task, {
        requestScope: scope,
        signal,
      });
      current(scope);
      if (
        result.task.taskId !== task.taskId ||
        result.task.taskCreatedAt !== task.taskCreatedAt
      )
        throw new Error('Task incarnation changed');
      return result;
    },
  });
}
export function useSetTaskParentMutation(scope: TaskRelationshipScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskParentMutationInput) => {
      current(scope);
      const result = await setTaskParent(scope.apiBase, input, {
        requestScope: scope,
      });
      current(scope);
      await invalidateTaskRelationships(client, scope, result);
      return result;
    },
  });
}
export function useCreateTaskChildMutation(scope: TaskRelationshipScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskChildCreateInput) => {
      current(scope);
      const result = await createTaskChild(scope.apiBase, input, {
        requestScope: scope,
      });
      current(scope);
      await invalidateTaskRelationships(client, scope, result.relationship);
      return result;
    },
  });
}
export function useSetTaskWorkChatMutation(scope: TaskRelationshipScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskWorkChatMutationInput) => {
      current(scope);
      const result = await setTaskWorkChat(scope.apiBase, input, {
        requestScope: scope,
      });
      current(scope);
      await client.invalidateQueries({
        queryKey: taskRelationshipKey(scope, input.task, 'work-chats'),
      });
      return result;
    },
  });
}
