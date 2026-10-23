import type {
  TaskChildCreateInput,
  TaskChildrenResult,
  TaskIdentity,
  TaskParentMutationInput,
  TaskParentMutationResult,
  TaskRecord,
  TaskWorkChatMutationInput,
  TaskWorkChatMutationResult,
  TaskWorkChatsResult,
} from '@kontourai/station-contracts/task-graph';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { success?: boolean; data?: T };
  if (!response.ok || body.success !== true || body.data === undefined)
    throw new Error('Task relationship unavailable');
  return body.data;
}
const path = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}`;
export function fetchTaskChildren(
  apiBase: string,
  task: TaskIdentity,
  options: ClientRequestOptions,
): Promise<TaskChildrenResult> {
  return getJson(
    `${apiBase}${path(task.taskId)}/children?taskCreatedAt=${encodeURIComponent(task.taskCreatedAt)}`,
    options,
  ).then(unwrap<TaskChildrenResult>);
}
export function createTaskChild(
  apiBase: string,
  input: TaskChildCreateInput,
  options: ClientRequestOptions,
): Promise<{ task: TaskRecord; relationship: TaskParentMutationResult }> {
  return mutateJson(
    `${apiBase}${path(input.parent.taskId)}/children`,
    'POST',
    options,
    input,
  ).then(unwrap<{ task: TaskRecord; relationship: TaskParentMutationResult }>);
}
export function setTaskParent(
  apiBase: string,
  input: TaskParentMutationInput,
  options: ClientRequestOptions,
): Promise<TaskParentMutationResult> {
  return mutateJson(
    `${apiBase}${path(input.child.taskId)}/parent`,
    'PUT',
    options,
    input,
  ).then(unwrap<TaskParentMutationResult>);
}
export function fetchTaskWorkChats(
  apiBase: string,
  task: TaskIdentity,
  options: ClientRequestOptions,
): Promise<TaskWorkChatsResult> {
  return getJson(
    `${apiBase}${path(task.taskId)}/work-chats?taskCreatedAt=${encodeURIComponent(task.taskCreatedAt)}`,
    options,
  ).then(unwrap<TaskWorkChatsResult>);
}
export function setTaskWorkChat(
  apiBase: string,
  input: TaskWorkChatMutationInput,
  options: ClientRequestOptions,
): Promise<TaskWorkChatMutationResult> {
  const { linked, ...body } = input;
  return mutateJson(
    `${apiBase}${path(input.task.taskId)}/work-chats`,
    linked ? 'POST' : 'DELETE',
    options,
    body,
  ).then(unwrap<TaskWorkChatMutationResult>);
}
