import type {
  RelationGraphLink,
  TaskUserInputReferenceInput,
  TaskUserInputReferenceProjection,
} from '@kontourai/station-contracts';
import { envelopeError, type StationHttpError } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

type Envelope<T> = { success: boolean; data?: T };

/**
 * The status is retained for callers that need to distinguish an authorization
 * revocation from a retryable resolver outage. The message is deliberately
 * generic: a protected input tuple or its content must never cross this seam
 * through an error payload.
 */
export class TaskUserInputReferenceRequestError extends Error {
  readonly status: number;
  /**
   * The refusal's machine `code` and `Retry-After`, when Station answered
   * (#2708). The message stays generic on purpose: nothing the route sent
   * about protected content crosses this seam.
   */
  readonly code?: string;
  readonly retryAfterMs?: number;

  /** `0` when no response was observed; else the envelope helper's error. */
  constructor(answer: number | StationHttpError) {
    super('User input reference unavailable');
    this.name = 'TaskUserInputReferenceRequestError';
    this.status = typeof answer === 'number' ? answer : answer.status;
    if (typeof answer !== 'number') {
      if (answer.code !== undefined) this.code = answer.code;
      if (answer.retryAfterMs !== undefined)
        this.retryAfterMs = answer.retryAfterMs;
    }
  }
}

/** The observed answer, withholding everything the route said but its code. */
function answered(response: Response, body?: unknown): StationHttpError {
  return envelopeError(response, body, 'User input reference unavailable', {
    message: 'User input reference unavailable',
  });
}

export type {
  TaskUserInputProjection,
  TaskUserInputReferenceProjection,
} from '@kontourai/station-contracts';

async function unwrap<T>(response: Response): Promise<T> {
  let body: Envelope<T> | undefined;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new TaskUserInputReferenceRequestError(answered(response));
  }
  if (!response.ok || !body.success || body.data === undefined)
    throw new TaskUserInputReferenceRequestError(answered(response, body));
  return body.data;
}

const referencesPath = (taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/references`;

const userInputReferencesPath = (taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/user-input-references`;

export type AttachTaskUserInputReferenceInput = Omit<
  TaskUserInputReferenceInput,
  'kind'
>;

/** Attach an exact authored-input identity through the typed route contract. */
export async function attachTaskUserInputReference(
  apiBase: string,
  taskId: string,
  input: AttachTaskUserInputReferenceInput,
  options?: ClientRequestOptions,
): Promise<RelationGraphLink> {
  return unwrap(
    await mutateJson(`${apiBase}${referencesPath(taskId)}`, 'POST', options, {
      kind: 'user-input',
      ...input,
    }),
  );
}

/** Reopen only the server-authorized, content-bounded input projections. */
export async function getTaskUserInputReferences(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<TaskUserInputReferenceProjection[]> {
  return unwrap(
    await getJson(`${apiBase}${userInputReferencesPath(taskId)}`, options),
  );
}
