import type {
  TaskAnswerSupportAssociation,
  TaskAnswerSupportMutationInput,
  TaskAnswerSupportRemoveInput,
  TaskAnswerSupportReplaceInput,
  TaskAnswerSupportStanding,
} from '@kontourai/station-contracts';
import type { FoundAnswerCardProjection } from '@kontourai/surface';
import { envelopeError, type StationHttpError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

/** An opaque, authorized selection handle. It is never a report location. */
export type AnswerSupportBundle = { id: string };
/** An opaque, authorized selection handle scoped to one selected bundle. */
export type AnswerSupportClaim = { id: string };

type Envelope<T> = { success: boolean; data?: T; error?: string };

/** A protected route failure with the status needed to revoke cached authority. */
export class AnswerSupportRequestError extends Error {
  readonly status: number;
  /** The refusal's machine `code`, `details` and `Retry-After` (#2708). */
  readonly code?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(failure: StationHttpError);
  constructor(message: string, status: number);
  constructor(failure: string | StationHttpError, status?: number) {
    super(typeof failure === 'string' ? failure : failure.message);
    this.name = 'AnswerSupportRequestError';
    if (typeof failure === 'string') {
      this.status = status as number;
      return;
    }
    this.status = failure.status;
    if (failure.code !== undefined) this.code = failure.code;
    if (failure.details !== undefined) this.details = failure.details;
    if (failure.retryAfterMs !== undefined)
      this.retryAfterMs = failure.retryAfterMs;
  }
}

/** The refusal, read out; one whose body is not JSON keeps its status. */
async function refusal(
  response: Response,
): Promise<{ body: Envelope<unknown> | undefined; failure: StationHttpError }> {
  const body = (await readJsonBody(response)) as Envelope<unknown> | undefined;
  return {
    body,
    failure: envelopeError(response, body, `HTTP ${response.status}`),
  };
}

/**
 * Surface owns the card's interpretation. Station forwards its published,
 * bounded projection without reconstructing report or source semantics.
 */
export type TaskAnswerSupportStandingWithCard =
  | Exclude<TaskAnswerSupportStanding, { state: 'available' }>
  | {
      state: 'available';
      associationId: string;
      revision: number;
      card: FoundAnswerCardProjection;
    };

export type TaskAnswerSupportTurnReferenceCard<TAnswer = unknown> =
  | {
      id: string;
      state: 'available';
      sessionId: string;
      turnId: string;
      answer: TAnswer;
      support: TaskAnswerSupportStandingWithCard;
    }
  | { state: 'unavailable' };

async function unwrap<T>(response: Response): Promise<T> {
  const { body, failure } = await refusal(response);
  if (!response.ok || !body?.success || body.data === undefined)
    throw new AnswerSupportRequestError(failure);
  return body.data as T;
}

async function unwrapSuccess(response: Response): Promise<void> {
  const { body, failure } = await refusal(response);
  if (!response.ok || !body?.success)
    throw new AnswerSupportRequestError(failure);
}

const supportPath = (taskId: string, referenceId: string, suffix = '') =>
  `/api/tasks/${encodeURIComponent(taskId)}/turn-references/${encodeURIComponent(referenceId)}/support${suffix}`;

const turnReferencesPath = (taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/turn-references`;

/**
 * Read the server-reauthorized answer cards and their bounded support state.
 * This client seam deliberately exposes no raw report, path, or source data.
 */
export async function getTaskAnswerSupportCards<TAnswer = unknown>(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<TaskAnswerSupportTurnReferenceCard<TAnswer>[]> {
  return unwrap(
    await getJson(`${apiBase}${turnReferencesPath(taskId)}`, options),
  );
}

export async function listAnswerSupportBundles(
  apiBase: string,
  taskId: string,
  referenceId: string,
  options?: ClientRequestOptions,
): Promise<AnswerSupportBundle[]> {
  return unwrap(
    await getJson(
      `${apiBase}${supportPath(taskId, referenceId, '/bundles')}`,
      options,
    ),
  );
}

export async function listAnswerSupportClaims(
  apiBase: string,
  taskId: string,
  referenceId: string,
  bundleId: string,
  options?: ClientRequestOptions,
): Promise<AnswerSupportClaim[]> {
  return unwrap(
    await getJson(
      `${apiBase}${supportPath(taskId, referenceId, `/bundles/${encodeURIComponent(bundleId)}/claims`)}`,
      options,
    ),
  );
}

export async function attachAnswerSupport(
  apiBase: string,
  taskId: string,
  referenceId: string,
  input: TaskAnswerSupportMutationInput,
  options?: ClientRequestOptions,
): Promise<TaskAnswerSupportAssociation> {
  return unwrap(
    await mutateJson(
      `${apiBase}${supportPath(taskId, referenceId)}`,
      'POST',
      options,
      input,
    ),
  );
}

/**
 * Replacing support is deliberately a compare-and-swap operation. Callers
 * must send the revision they observed; there is no blind replacement form.
 */
export async function replaceAnswerSupport(
  apiBase: string,
  taskId: string,
  referenceId: string,
  input: TaskAnswerSupportReplaceInput,
  options?: ClientRequestOptions,
): Promise<TaskAnswerSupportAssociation> {
  return unwrap(
    await mutateJson(
      `${apiBase}${supportPath(taskId, referenceId)}`,
      'PUT',
      options,
      input,
    ),
  );
}

export async function removeAnswerSupport(
  apiBase: string,
  taskId: string,
  referenceId: string,
  input: TaskAnswerSupportRemoveInput,
  options?: ClientRequestOptions,
): Promise<void> {
  await unwrapSuccess(
    await mutateJson(
      `${apiBase}${supportPath(taskId, referenceId)}`,
      'DELETE',
      options,
      input,
    ),
  );
}
