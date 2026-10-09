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

/** Stable option identity shared by the request sender and durable reservation owner. */
export async function taskRoomModelOptionsDigest(
  options: Readonly<Record<string, unknown>>,
): Promise<string> {
  const canonical = JSON.stringify(options, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

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
    (value.expectedDefinitionFingerprint === undefined ||
      (typeof value.expectedDefinitionFingerprint === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.expectedDefinitionFingerprint))) &&
    (value.modelId === undefined ||
      (typeof value.modelId === 'string' &&
        value.modelId.length > 0 &&
        value.modelId.length <= 512)) &&
    (value.modelOptionsDigest === undefined ||
      (typeof value.modelOptionsDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(value.modelOptionsDigest))) &&
    (value.executionAgentId === undefined ||
      (typeof value.executionAgentId === 'string' &&
        value.executionAgentId.length > 0 &&
        value.executionAgentId.length <= 64)) &&
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
  if (input.expectedDefinitionFingerprint && !input.executionAgentId)
    throw new TaskRoomWorkNotSentError(
      'A verified Agent definition requires an explicit execution binding. Nothing was sent.',
    );
  const modelId = input.model?.override?.trim() || undefined;
  const modelOptionsDigest =
    input.model?.options === undefined
      ? undefined
      : await taskRoomModelOptionsDigest(input.model.options);
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
        agent: input.executionAgentId
          ? {
              kind: 'agent-execution-override',
              agent: input.agentId,
              executionAgent: input.executionAgentId,
              ...(input.expectedDefinitionFingerprint
                ? {
                    expectedDefinitionFingerprint:
                      input.expectedDefinitionFingerprint,
                  }
                : {}),
            }
          : input.agentId,
        ...(input.model ? { model: input.model } : {}),
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
    value.record.executionAgentId === input.executionAgentId &&
    value.record.expectedDefinitionFingerprint ===
      input.expectedDefinitionFingerprint &&
    value.record.modelId === modelId &&
    value.record.modelOptionsDigest === modelOptionsDigest &&
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
