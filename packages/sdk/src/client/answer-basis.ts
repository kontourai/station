import type { StationBasisProjection } from '@kontourai/station-contracts/task-basis';
import { envelopeError, type StationHttpError } from './api-error-message';
import { type ClientRequestOptions, getJson, readJsonBody } from './http';
import { parseTaskBasisProjection } from './task-basis';
export class AnswerBasisRequestError extends Error {
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
    super('Answer basis unavailable');
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
  return envelopeError(response, body, 'Answer basis unavailable', {
    message: 'Answer basis unavailable',
  });
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
    // The body is read only for the refusal's `code`; one that cannot be
    // read (not JSON, or a stalled read) leaves the status as it is.
    if (!response.ok)
      throw new AnswerBasisRequestError(
        answered(response, await readJsonBody(response).catch(() => undefined)),
      );
    const body = (await response.json()) as {
      success?: boolean;
      data?: unknown;
    };
    const projection = body.success
      ? parseTaskBasisProjection(body.data)
      : null;
    if (!projection)
      throw new AnswerBasisRequestError(answered(response, body));
    return projection;
  } catch (error) {
    if (error instanceof AnswerBasisRequestError) throw error;
    throw new AnswerBasisRequestError(0);
  }
}
