import {
  parseStationBasisProjection,
  parseStationTaskBasisCollection as parseStationCollectionEnvelope,
  STATION_TASK_BASIS_COLLECTION_VERSION,
  type StationBasisProjection,
  type StationTaskBasisCollection,
} from '@kontourai/station-contracts/task-basis';
import { envelopeError, type StationHttpError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { rethrowDeadline } from './request-deadline';

export type { StationTaskBasisCollection };
export { STATION_TASK_BASIS_COLLECTION_VERSION };
export type StationBasisResult =
  | StationBasisProjection
  | StationTaskBasisCollection;

export class TaskBasisRequestError extends Error {
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
    super('Task basis unavailable');
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
  return envelopeError(response, body, 'Task basis unavailable', {
    message: 'Task basis unavailable',
  });
}

/** Explicit Surface parser re-export; no Station semantic parser exists. */
export function parseTaskBasisProjection(
  value: unknown,
): StationBasisProjection | null {
  return parseStationBasisProjection(value);
}

/** Bounded Station-owned whole-Task collection transport parser. */
export function parseStationTaskBasisCollection(
  value: unknown,
): StationTaskBasisCollection | null {
  try {
    const collection = parseStationCollectionEnvelope(value);
    if (!collection) return null;
    const answers = collection.answers.map((answer) => ({
      ...answer,
      projection: parseTaskBasisProjection(answer.projection),
    }));
    return answers.some((answer) => !answer.projection)
      ? null
      : {
          ...collection,
          answers: answers as StationTaskBasisCollection['answers'],
        };
  } catch {
    return null;
  }
}

export function parseTaskBasisResult(
  value: unknown,
): StationBasisResult | null {
  return (
    parseTaskBasisProjection(value) ?? parseStationTaskBasisCollection(value)
  );
}

export async function getTaskBasis(
  apiBase: string,
  taskId: string,
  options: { answerReferenceId?: string; request?: ClientRequestOptions } = {},
): Promise<StationBasisResult> {
  try {
    const query = options.answerReferenceId
      ? `?answerReferenceId=${encodeURIComponent(options.answerReferenceId)}`
      : '';
    const response = await getJson(
      `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/basis${query}`,
      options.request,
    );
    let body: { success?: boolean; data?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch (error) {
      rethrowDeadline(error);
      // Station answered, just not in JSON: keep the status it answered with.
      throw new TaskBasisRequestError(answered(response));
    }
    const result = body.success ? parseTaskBasisResult(body.data) : null;
    // A valid envelope for another Task is never a response to this request.
    // Selected-answer projections intentionally lack a Task id.
    if (
      !response.ok ||
      !result ||
      (!options.answerReferenceId &&
        (!('taskId' in result) || result.taskId !== taskId))
    )
      throw new TaskBasisRequestError(answered(response, body));
    return result;
  } catch (error) {
    if (error instanceof TaskBasisRequestError) throw error;
    throw new TaskBasisRequestError(0);
  }
}
