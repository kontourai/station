/** Transport for the closed Activity live-collaborator projection. */
import {
  type LiveActivityProjection,
  parseLiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
import { envelopeError, type StationHttpError } from './api-error-message';
import { authenticatedFetch } from './http';
import { rethrowDeadline } from './request-deadline';

export class LiveActivityProtocolError extends Error {
  /**
   * Set only when Station refused the request (#2708): the answer's status,
   * machine `code`, `details` and `Retry-After`. A malformed or unreadable
   * response leaves them absent.
   */
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  constructor(failure: string | StationHttpError) {
    super(typeof failure === 'string' ? failure : failure.message);
    this.name = 'LiveActivityProtocolError';
    if (typeof failure === 'string') return;
    this.status = failure.status;
    if (failure.code !== undefined) this.code = failure.code;
    if (failure.details !== undefined) this.details = failure.details;
    if (failure.retryAfterMs !== undefined)
      this.retryAfterMs = failure.retryAfterMs;
  }
}

export async function fetchLiveActivity(
  apiBase: string,
  signal?: AbortSignal,
): Promise<LiveActivityProjection | undefined> {
  // Spread, not `undefined`: `authenticatedFetch` preserves the caller's
  // arity through to `fetch`, so a signal-less read still calls `fetch(url)`.
  const init: [] | [RequestInit] = signal ? [{ signal }] : [];
  const response = await authenticatedFetch(
    `${apiBase}/api/live-activity`,
    ...init,
  );
  if (response.status === 404) return undefined;
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    throw new LiveActivityProtocolError('Live activity response is not JSON');
  }
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    (body as { success?: unknown }).success !== true
  ) {
    // The sentence stays this client's own; the refusal's status and `code`
    // ride on the error (#2708).
    const message = `Live activity request failed (${response.status})`;
    throw new LiveActivityProtocolError(
      envelopeError(response, body, message, { message }),
    );
  }
  const projection = parseLiveActivityProjection(
    (body as { data?: unknown }).data,
  );
  if (!projection)
    throw new LiveActivityProtocolError('Live activity response is invalid');
  return projection;
}
