import type {
  StationAnswerNarrativePublishInput,
  StationAnswerNarrativeReadTarget,
  StationAnswerNarrativeReceipt,
} from '@kontourai/station-contracts/answer-narrative-binding';
import { envelopeError, type StationHttpError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

export class AnswerNarrativeBindingRequestError extends Error {
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
    super('Answer narrative binding unavailable');
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
  return envelopeError(response, body, 'Answer narrative binding unavailable', {
    message: 'Answer narrative binding unavailable',
  });
}

export async function getAnswerNarrativeTarget(
  apiBase: string,
  sessionId: string,
  turnId: string,
  options?: ClientRequestOptions,
): Promise<StationAnswerNarrativeReadTarget> {
  return request(
    apiBase,
    sessionId,
    turnId,
    undefined,
    options,
  ) as Promise<StationAnswerNarrativeReadTarget>;
}
export async function publishAnswerNarrative(
  apiBase: string,
  sessionId: string,
  turnId: string,
  input: StationAnswerNarrativePublishInput,
  options?: ClientRequestOptions,
): Promise<StationAnswerNarrativeReceipt> {
  return request(
    apiBase,
    sessionId,
    turnId,
    { method: 'PUT', body: input },
    options,
  ) as Promise<StationAnswerNarrativeReceipt>;
}
export async function removeAnswerNarrative(
  apiBase: string,
  sessionId: string,
  turnId: string,
  expectedRevision: number,
  options?: ClientRequestOptions,
): Promise<StationAnswerNarrativeReceipt> {
  return request(
    apiBase,
    sessionId,
    turnId,
    { method: 'DELETE', body: { expectedRevision } },
    options,
  ) as Promise<StationAnswerNarrativeReceipt>;
}
async function request(
  apiBase: string,
  sessionId: string,
  turnId: string,
  mutation: { method: 'PUT' | 'DELETE'; body: unknown } | undefined,
  options?: ClientRequestOptions,
): Promise<unknown> {
  try {
    const path = `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/narrative${mutation ? '' : '/target'}`;
    const response = mutation
      ? await mutateJson(path, mutation.method, options, mutation.body)
      : await getJson(path, options);
    // A refusal whose body is not JSON keeps its status (#2708).
    const body = (await readJsonBody(response)) as
      | { success?: boolean; data?: unknown }
      | undefined;
    if (!response.ok || !body?.success)
      throw new AnswerNarrativeBindingRequestError(answered(response, body));
    return body.data;
  } catch (error) {
    if (error instanceof AnswerNarrativeBindingRequestError) throw error;
    throw new AnswerNarrativeBindingRequestError(0);
  }
}
