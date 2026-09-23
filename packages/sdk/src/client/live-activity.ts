/** Transport for the closed Activity live-collaborator projection. */
import {
  type LiveActivityProjection,
  parseLiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
import { authenticatedFetch } from './http';

export class LiveActivityProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveActivityProtocolError';
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
  } catch {
    throw new LiveActivityProtocolError('Live activity response is not JSON');
  }
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    (body as { success?: unknown }).success !== true
  )
    throw new LiveActivityProtocolError(
      `Live activity request failed (${response.status})`,
    );
  const projection = parseLiveActivityProjection(
    (body as { data?: unknown }).data,
  );
  if (!projection)
    throw new LiveActivityProtocolError('Live activity response is invalid');
  return projection;
}
