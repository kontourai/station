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
): Promise<LiveActivityProjection | undefined> {
  const response = await authenticatedFetch(`${apiBase}/api/live-activity`);
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
