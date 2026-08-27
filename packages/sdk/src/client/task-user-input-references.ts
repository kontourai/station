import type {
  RelationGraphLink,
  TaskUserInputReferenceInput,
  TaskUserInputReferenceProjection,
} from '@kontourai/station-contracts';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

type Envelope<T> = { success: boolean; data?: T };

/**
 * The status is retained for callers that need to distinguish an authorization
 * revocation from a retryable resolver outage. The message is deliberately
 * generic: a protected input tuple or its content must never cross this seam
 * through an error payload.
 */
export class TaskUserInputReferenceRequestError extends Error {
  constructor(readonly status: number) {
    super('User input reference unavailable');
    this.name = 'TaskUserInputReferenceRequestError';
  }
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
    throw new TaskUserInputReferenceRequestError(response.status);
  }
  if (!response.ok || !body.success || body.data === undefined)
    throw new TaskUserInputReferenceRequestError(response.status);
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
