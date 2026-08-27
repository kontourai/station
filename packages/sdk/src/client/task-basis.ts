import {
  parseStationBasisProjection,
  parseStationTaskBasisCollection as parseStationCollectionEnvelope,
  STATION_TASK_BASIS_COLLECTION_VERSION,
  type StationBasisProjection,
  type StationTaskBasisCollection,
} from '@kontourai/station-contracts/task-basis';
import { type ClientRequestOptions, getJson } from './http';

export type { StationTaskBasisCollection };
export { STATION_TASK_BASIS_COLLECTION_VERSION };
export type StationBasisResult =
  | StationBasisProjection
  | StationTaskBasisCollection;

export class TaskBasisRequestError extends Error {
  constructor(readonly status: number) {
    super('Task basis unavailable');
  }
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
    const body = (await response.json()) as {
      success?: boolean;
      data?: unknown;
    };
    const result = body.success ? parseTaskBasisResult(body.data) : null;
    // A valid envelope for another Task is never a response to this request.
    // Selected-answer projections intentionally lack a Task id.
    if (
      !response.ok ||
      !result ||
      (!options.answerReferenceId &&
        (!('taskId' in result) || result.taskId !== taskId))
    )
      throw new TaskBasisRequestError(response.status);
    return result;
  } catch (error) {
    if (error instanceof TaskBasisRequestError) throw error;
    throw new TaskBasisRequestError(0);
  }
}
