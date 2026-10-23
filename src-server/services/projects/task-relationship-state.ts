import type {
  TaskIdentity,
  TaskParentMutationResult,
  TaskRecord,
  TaskWorkChatMutationResult,
} from '@kontourai/station-contracts/task-graph';

/** Runtime supplies live checks, called under the TaskGraph mutation lock. */
export interface TaskRelationshipAuthority {
  expectedProject: { id: string; createdAt: string };
  canonicalProject(
    projectId: string,
  ): { id: string; createdAt: string } | undefined;
  canMutateTask(task: TaskRecord): boolean;
  canReadTask(task: TaskRecord): boolean;
  /** Must bind canonical Conversation identity and current reader capability. */
  canReadConversation(
    conversationId: string,
    project: { id: string; createdAt: string },
  ): boolean;
}

export class TaskRelationshipError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'conflict') {
    super(`Task relationship ${code}`);
  }
}

export interface TaskWorkChatRecord {
  task: TaskIdentity;
  conversationId: string;
  revision: number;
  linked: boolean;
}

export interface TaskRelationshipReceipt {
  operationId: string;
  fingerprint: string;
  result: TaskParentMutationResult | TaskWorkChatMutationResult;
}

export function taskIdentity(task: TaskRecord): TaskIdentity {
  return { taskId: task.id, taskCreatedAt: task.createdAt };
}

export function sameTask(a: TaskIdentity, b: TaskIdentity): boolean {
  return a.taskId === b.taskId && a.taskCreatedAt === b.taskCreatedAt;
}

export function requireRelationshipTask(
  tasks: TaskRecord[],
  identity: TaskIdentity,
): TaskRecord {
  const task = tasks.find((candidate) => candidate.id === identity.taskId);
  if (!task || task.createdAt !== identity.taskCreatedAt)
    throw new TaskRelationshipError('unavailable');
  return task;
}

export function relationshipProject(
  authority: TaskRelationshipAuthority,
  tasks: TaskRecord[],
) {
  const projects = tasks.map((task) =>
    authority.canonicalProject(task.projectId),
  );
  const first = projects[0];
  if (
    !first ||
    first.id !== authority.expectedProject.id ||
    first.createdAt !== authority.expectedProject.createdAt ||
    projects.some(
      (project) =>
        !project ||
        project.id !== first.id ||
        project.createdAt !== first.createdAt,
    )
  )
    throw new TaskRelationshipError('unavailable');
  return first;
}

export function authorizeRelationship(
  authority: TaskRelationshipAuthority,
  tasks: TaskRecord[],
) {
  const project = relationshipProject(authority, tasks);
  if (tasks.some((task) => !authority.canMutateTask(task)))
    throw new TaskRelationshipError('unavailable');
  return project;
}

/** Reject dangling, replaced, cyclic and cross-Project ancestor chains. */
export function validateParentChain(
  tasks: TaskRecord[],
  child: TaskRecord,
  parent: TaskRecord,
  authority: TaskRelationshipAuthority,
) {
  const seen = new Set([child.id]);
  let cursor: TaskRecord | undefined = parent;
  while (cursor) {
    if (seen.has(cursor.id)) throw new TaskRelationshipError('invalid');
    seen.add(cursor.id);
    relationshipProject(authority, [child, cursor]);
    cursor = cursor.parent
      ? requireRelationshipTask(tasks, cursor.parent)
      : undefined;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  value.trim() === value;
export function validTaskIdentity(value: unknown): value is TaskIdentity {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    id(value.taskId) &&
    id(value.taskCreatedAt) &&
    Number.isFinite(Date.parse(value.taskCreatedAt))
  );
}
const revision = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** New fields are optional for old stores, but malformed data is never repaired. */
export function validateRelationshipState(
  tasks: unknown[],
  chats: unknown,
  receipts: unknown,
): string[] {
  const problems: string[] = [];
  for (const task of tasks) {
    if (!record(task)) continue;
    if (task.parent !== undefined && !validTaskIdentity(task.parent))
      problems.push('invalid Task parent');
    if (
      task.relationshipRevision !== undefined &&
      !revision(task.relationshipRevision)
    )
      problems.push('invalid Task relationship revision');
  }
  if (chats !== undefined && !Array.isArray(chats))
    problems.push('invalid work chats');
  const keys = new Set<string>();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (
      !record(chat) ||
      Object.keys(chat).sort().join() !==
        'conversationId,linked,revision,task' ||
      !validTaskIdentity(chat.task) ||
      !id(chat.conversationId) ||
      !revision(chat.revision) ||
      typeof chat.linked !== 'boolean'
    ) {
      problems.push('invalid work chat');
      continue;
    }
    const key = JSON.stringify([chat.task, chat.conversationId]);
    if (keys.has(key)) problems.push('duplicate work chat');
    keys.add(key);
  }
  if (receipts !== undefined && !Array.isArray(receipts))
    problems.push('invalid relationship receipts');
  const operations = new Set<string>();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (
      !record(receipt) ||
      Object.keys(receipt).sort().join() !== 'fingerprint,operationId,result' ||
      !id(receipt.operationId) ||
      !id(receipt.fingerprint) ||
      !record(receipt.result)
    ) {
      problems.push('invalid relationship receipt');
      continue;
    }
    const result = receipt.result;
    const valid =
      'child' in result
        ? Object.keys(result).sort().join() ===
            'child,parent,previousParent,revision' &&
          validTaskIdentity(result.child) &&
          (result.parent === null || validTaskIdentity(result.parent)) &&
          (result.previousParent === null ||
            validTaskIdentity(result.previousParent))
        : Object.keys(result).sort().join() ===
            'conversationId,linked,revision,task' &&
          validTaskIdentity(result.task) &&
          id(result.conversationId) &&
          typeof result.linked === 'boolean';
    if (
      !valid ||
      !revision(result.revision) ||
      operations.has(receipt.operationId)
    )
      problems.push('invalid relationship receipt result');
    operations.add(receipt.operationId);
  }
  return problems;
}
