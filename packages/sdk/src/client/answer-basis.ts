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
    // #1536 B3 review M3: the STATUS decides first. Parsing before this check
    // meant a refusal whose body was not JSON — an HTML error page, an empty
    // 404 — threw out of `response.json()` and arrived as status 0, so the
    // affordance called the route's deliberate 404 a failure. The status is
    // known before any body is read.
    if (!response.ok) throw new AnswerBasisRequestError(response.status);
    const body = (await response.json()) as {
      success?: boolean;
      data?: unknown;
    };
    const projection = body.success
      ? parseTaskBasisProjection(body.data)
      : null;
    if (!projection) throw new AnswerBasisRequestError(response.status);
    return projection;
  } catch (error) {
    if (error instanceof AnswerBasisRequestError) throw error;
    throw new AnswerBasisRequestError(0);
  }
}
