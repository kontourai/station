import type { StationBasisProjection } from '@kontourai/station-contracts/task-basis';
import { type ClientRequestOptions, getJson } from './http';
import { parseTaskBasisProjection } from './task-basis';
export class AnswerBasisRequestError extends Error {
  constructor(readonly status: number) {
    super('Answer basis unavailable');
  }
}
export async function getAnswerBasis(
  apiBase: string,
  sessionId: string,
  turnId: string,
  options?: ClientRequestOptions,
): Promise<StationBasisProjection> {
  try {
    const response = await getJson(
      `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/basis`,
      options,
    );
    const body = (await response.json()) as {
      success?: boolean;
      data?: unknown;
    };
    const projection = body.success
      ? parseTaskBasisProjection(body.data)
      : null;
    if (!response.ok || !projection)
      throw new AnswerBasisRequestError(response.status);
    return projection;
  } catch (error) {
    if (error instanceof AnswerBasisRequestError) throw error;
    throw new AnswerBasisRequestError(0);
  }
}
