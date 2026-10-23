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
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
} from '@kontourai/station-contracts/task-graph';
import { z } from 'zod';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  getJson,
  mutateJson,
} from './http';

type ScopedOptions = ClientRequestOptions & { requestScope: ApiRequestScope };

const text = z.string().min(1).max(4096);
const identity = z.strictObject({
  taskId: text,
  taskCreatedAt: z.iso.datetime(),
});
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const record = z
  .object({
    id: text,
    projectId: text,
    title: z.string().min(1).max(512),
    description: z.string().max(12000),
    priority: z.enum(TASK_PRIORITIES),
    status: z.enum(TASK_STATUSES),
    createdBy: text,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    parent: identity.optional(),
    relationshipRevision: revision.optional(),
    agentId: text.optional(),
    skillName: text.optional(),
  })
  .passthrough();
const parentResult = z.strictObject({
  child: identity,
  parent: identity.nullable(),
  previousParent: identity.nullable(),
  revision,
});
const chatResult = z.strictObject({
  task: identity,
  conversationId: text,
  linked: z.boolean(),
  revision,
});
const childrenResult = z.strictObject({
  task: identity,
  children: z.array(record).max(10000),
});
const chatsResult = z.strictObject({
  task: identity,
  chats: z.array(z.strictObject({ conversationId: text, revision })).max(10000),
});
async function unwrap<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const wire: unknown = await response.json();
  const body = z
    .object({ success: z.literal(true), data: schema })
    .safeParse(wire);
  if (
    !response.ok ||
    !body.success ||
    JSON.stringify(wire).length > 2 * 1024 * 1024
  )
    throw new Error('Task relationship unavailable');
  return body.data.data;
}
const path = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}`;
export function fetchTaskChildren(
  apiBase: string,
  task: TaskIdentity,
  options: ScopedOptions,
): Promise<TaskChildrenResult> {
  return getJson(
    `${apiBase}${path(task.taskId)}/children?taskCreatedAt=${encodeURIComponent(task.taskCreatedAt)}`,
    options,
  ).then((response) => unwrap(response, childrenResult));
}
export function createTaskChild(
  apiBase: string,
  input: TaskChildCreateInput,
  options: ScopedOptions,
): Promise<{ task: TaskRecord; relationship: TaskParentMutationResult }> {
  return mutateJson(
    `${apiBase}${path(input.parent.taskId)}/children`,
    'POST',
    options,
    input,
  ).then((response) =>
    unwrap(
      response,
      z.strictObject({ task: record, relationship: parentResult }),
    ),
  );
}
export function setTaskParent(
  apiBase: string,
  input: TaskParentMutationInput,
  options: ScopedOptions,
): Promise<TaskParentMutationResult> {
  return mutateJson(
    `${apiBase}${path(input.child.taskId)}/parent`,
    'PUT',
    options,
    input,
  ).then((response) => unwrap(response, parentResult));
}
export function fetchTaskWorkChats(
  apiBase: string,
  task: TaskIdentity,
  options: ScopedOptions,
): Promise<TaskWorkChatsResult> {
  return getJson(
    `${apiBase}${path(task.taskId)}/work-chats?taskCreatedAt=${encodeURIComponent(task.taskCreatedAt)}`,
    options,
  ).then((response) => unwrap(response, chatsResult));
}
export function setTaskWorkChat(
  apiBase: string,
  input: TaskWorkChatMutationInput,
  options: ScopedOptions,
): Promise<TaskWorkChatMutationResult> {
  const { linked, ...body } = input;
  return mutateJson(
    `${apiBase}${path(input.task.taskId)}/work-chats`,
    linked ? 'POST' : 'DELETE',
    options,
    body,
  ).then((response) => unwrap(response, chatResult));
}

/** A known candidate's current revision, including a prior unlink tombstone. */
export function fetchTaskWorkChat(
  apiBase: string,
  task: TaskIdentity,
  conversationId: string,
  options: ScopedOptions,
): Promise<TaskWorkChatMutationResult> {
  return getJson(
    `${apiBase}${path(task.taskId)}/work-chats/${encodeURIComponent(conversationId)}?taskCreatedAt=${encodeURIComponent(task.taskCreatedAt)}`,
    options,
  ).then((response) => unwrap(response, chatResult));
}
