import {
  TASK_ROOM_CONTEXT_VERSION,
  TASK_ROOM_WORK_VERSION,
  type TaskRoomContextSnapshot,
  type TaskRoomWorkInput,
  type TaskRoomWorkList,
  type TaskRoomWorkOutcome,
  type TaskRoomWorkRecord,
} from '@kontourai/station-contracts/task-room-work';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

export class TaskRoomWorkProtocolError extends Error {}
export class TaskRoomWorkNotSentError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contextSnapshot(value: unknown): value is TaskRoomContextSnapshot {
  return (
    object(value) &&
    value.version === TASK_ROOM_CONTEXT_VERSION &&
    typeof value.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.digest) &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    value.title.length <= 512 &&
    typeof value.description === 'string' &&
    value.description.length <= 12000 &&
    typeof value.documentRevision === 'string' &&
    value.documentRevision.length > 0 &&
    value.documentRevision.length <= 256 &&
    typeof value.text === 'string' &&
    value.text.length <= 16000
  );
}

function workRecord(
  value: unknown,
  taskId: string,
): value is TaskRoomWorkRecord {
  if (!object(value)) return false;
  return (
    value.version === TASK_ROOM_WORK_VERSION &&
    value.taskId === taskId &&
    (value.context === undefined || contextSnapshot(value.context)) &&
    [
      'projectId',
      'taskCreatedAt',
      'operationId',
      'requesterId',
      'agentId',
      'prompt',
      'sessionId',
      'createdAt',
    ].every((key) => typeof value[key] === 'string' && value[key].length > 0) &&
    typeof value.state === 'string' &&
    ['starting', 'dispatched', 'indeterminate', 'refused'].includes(value.state)
  );
}

async function data(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok || !object(body) || body.success !== true)
    throw envelopeError(response, body, 'Task agent request is unavailable.');
  return body.data;
}

/** A successful, versioned read is required before sending the additive create field. */
export async function fetchTaskRoomAgentRequests(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<Extract<TaskRoomWorkList, { kind: 'available' }>> {
  const value = await data(
    await getJson(
      `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/room/agent-requests`,
      options,
    ),
  );
  if (
    !object(value) ||
    value.version !== TASK_ROOM_WORK_VERSION ||
    value.kind !== 'available' ||
    !Array.isArray(value.records) ||
    !value.records.every((record) => workRecord(record, taskId))
  )
    throw new TaskRoomWorkProtocolError(
      'This Station does not support Task agent requests.',
    );
  if (
    value.contextVersion !== undefined &&
    (value.contextVersion !== TASK_ROOM_CONTEXT_VERSION ||
      (value.context !== null && !contextSnapshot(value.context)))
  )
    throw new TaskRoomWorkProtocolError('Task brief context is unavailable.');
  return {
    kind: 'available',
    records: value.records,
    ...(value.contextVersion === TASK_ROOM_CONTEXT_VERSION
      ? {
          contextVersion: TASK_ROOM_CONTEXT_VERSION,
          context: contextSnapshot(value.context) ? value.context : null,
        }
      : {}),
  };
}

export async function submitTaskRoomAgentRequest(
  apiBase: string,
  taskId: string,
  projectSlug: string,
  taskCreatedAt: string,
  input: TaskRoomWorkInput,
  options?: ClientRequestOptions,
): Promise<TaskRoomWorkOutcome> {
  try {
    const supported = await fetchTaskRoomAgentRequests(
      apiBase,
      taskId,
      options,
    );
    if (input.context && supported.contextVersion !== TASK_ROOM_CONTEXT_VERSION)
      throw new TaskRoomWorkProtocolError(
        'This Station does not support saved Task briefs.',
      );
  } catch (cause) {
    throw new TaskRoomWorkNotSentError(
      'Task agent requests are unavailable. Nothing was sent.',
      cause,
    );
  }
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations`,
    'POST',
    options,
    {
      prompt: input.prompt,
      target: {
        environment: { kind: 'current' },
        agent: input.agentId,
        workspace: { kind: 'project', projectSlug },
      },
      taskRoomRequest: {
        taskId,
        taskCreatedAt,
        operationId: input.operationId,
        ...(input.context ? { context: input.context } : {}),
      },
    },
  );
  const acknowledgement: unknown = await response.json();
  if (
    input.context &&
    response.status === 409 &&
    object(acknowledgement) &&
    acknowledgement.success === false &&
    object(acknowledgement.data) &&
    acknowledgement.data.kind === 'refused' &&
    acknowledgement.data.reason === 'context'
  )
    throw new TaskRoomWorkNotSentError(
      'The Task brief changed or is unavailable. Refresh the brief before sending. Nothing was sent.',
    );
  if (
    !response.ok ||
    !object(acknowledgement) ||
    acknowledgement.success !== true
  )
    throw envelopeError(
      response,
      acknowledgement,
      'Task agent request is unavailable.',
    );
  const value = acknowledgement.data;
  if (
    object(value) &&
    value.kind === 'recorded' &&
    typeof value.replayed === 'boolean' &&
    workRecord(value.record, taskId) &&
    value.record.operationId === input.operationId &&
    value.record.agentId === input.agentId &&
    value.record.prompt === input.prompt.trim() &&
    value.record.taskCreatedAt === taskCreatedAt &&
    value.record.context?.digest === input.context?.digest
  )
    return { kind: 'recorded', record: value.record, replayed: value.replayed };
  if (
    object(value) &&
    value.kind === 'refused' &&
    (value.reason === 'access' ||
      value.reason === 'conflict' ||
      value.reason === 'capacity' ||
      value.reason === 'input')
  )
    return { kind: 'refused', reason: value.reason };
  throw new TaskRoomWorkProtocolError(
    'Agent request acknowledgement is unavailable. Check requests before retrying.',
  );
}
