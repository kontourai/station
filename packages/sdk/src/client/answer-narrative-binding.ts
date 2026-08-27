import type {
  StationAnswerNarrativePublishInput,
  StationAnswerNarrativeReadTarget,
  StationAnswerNarrativeReceipt,
} from '@kontourai/station-contracts/answer-narrative-binding';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

export class AnswerNarrativeBindingRequestError extends Error {
  constructor(readonly status: number) {
    super('Answer narrative binding unavailable');
  }
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
    const body = (await response.json()) as {
      success?: boolean;
      data?: unknown;
    };
    if (!response.ok || !body.success)
      throw new AnswerNarrativeBindingRequestError(response.status);
    return body.data;
  } catch (error) {
    if (error instanceof AnswerNarrativeBindingRequestError) throw error;
    throw new AnswerNarrativeBindingRequestError(0);
  }
}
