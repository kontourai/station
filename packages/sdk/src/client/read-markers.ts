/**
 * Server-kept read markers (#3075): the caller's own read state for agent
 * conversations, Project rooms and Task rooms. See
 * `@kontourai/station-contracts/read-markers` for the rules the server
 * enforces (principal-owned, monotonic, never past the current version).
 */

import {
  READ_MARKER_MARK_PATH,
  READ_MARKER_SUMMARY_PATH,
  type ReadMarkerState,
  type ReadMarkerSummary,
  type ReadMarkerTarget,
} from '@kontourai/station-contracts/read-markers';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, mutateJson } from './http';
import { rethrowDeadline } from './request-deadline';

interface ReadMarkerEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/**
 * A failure whose body is not JSON (a proxy's HTML 502) keeps the status it
 * arrived under; an unreadable 2xx is a protocol failure and rethrows.
 */
async function readEnvelope<T>(
  response: Response,
): Promise<ReadMarkerEnvelope<T>> {
  try {
    return (await response.json()) as ReadMarkerEnvelope<T>;
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok)
      throw envelopeError(
        response,
        undefined,
        `Read marker API error: ${response.status}`,
      );
    throw error;
  }
}

/**
 * Read state for up to `READ_MARKER_SUMMARY_MAX_TARGETS` conversations in one
 * request; the server refuses more rather than truncating. Items come back in
 * request order; one the caller cannot read is `{ target, unavailable: true }`.
 */
export async function fetchReadMarkerSummary(
  apiBase: string,
  targets: readonly ReadMarkerTarget[],
  opts?: ClientRequestOptions,
): Promise<ReadMarkerSummary> {
  const response = await mutateJson(
    `${apiBase}${READ_MARKER_SUMMARY_PATH}`,
    'POST',
    opts,
    { targets },
  );
  const result = await readEnvelope<ReadMarkerSummary>(response);
  if (!response.ok || !result.success || !result.data)
    throw envelopeError(response, result, 'Failed to read unread state');
  return result.data;
}

/**
 * Mark `target` read through `version`, the version the person was shown.
 * Idempotent and monotonic: an older version answers the stored state. A
 * version above the conversation's current one is refused (409).
 */
export async function markRead(
  apiBase: string,
  target: ReadMarkerTarget,
  version: number,
  opts?: ClientRequestOptions,
): Promise<ReadMarkerState> {
  const response = await mutateJson(
    `${apiBase}${READ_MARKER_MARK_PATH}`,
    'POST',
    opts,
    { target, version },
  );
  const result = await readEnvelope<ReadMarkerState>(response);
  if (!response.ok || !result.success || !result.data)
    throw envelopeError(response, result, 'Failed to mark as read');
  return result.data;
}
