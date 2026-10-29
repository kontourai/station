/**
 * station#3413 part B / #3427: the work claims a person may see —
 * `GET /api/orchestration/work-claims`, the read the Station UI's Session-row
 * chips and `station claims list` share. It answers a person, never an
 * agent (an agent reads claims through `list_project_activity`): the active
 * claims of the Sessions the requester may read.
 */
import {
  parseWorkClaimView,
  type WorkClaimView,
} from '@kontourai/station-contracts/work-claims';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson } from './http';
import { rethrowDeadline } from './request-deadline';

/** The UI's own ceiling for this read; the route bounds the claim count. */
const WORK_CLAIMS_MAX_RESPONSE_BYTES = 512 * 1024;

export async function listWorkClaims(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<WorkClaimView[]> {
  const response = await getJson(`${apiBase}/api/orchestration/work-claims`, {
    maxResponseBytes: WORK_CLAIMS_MAX_RESPONSE_BYTES,
    ...opts,
  });
  let body: { success?: boolean; data?: { claims?: unknown } } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    rethrowDeadline(error);
    if (response.ok) throw error;
  }
  if (!response.ok || body?.success !== true)
    throw envelopeError(response, body, 'Failed to read work claims');
  const raw = body.data?.claims;
  if (!Array.isArray(raw))
    throw new Error('Work claims response carried no claims list.');
  // A claim the contract cannot read is refused, not dropped: a list that
  // silently omits one would say the work is unclaimed.
  return raw.map((entry, index) => {
    const claim = parseWorkClaimView(entry);
    if (!claim)
      throw new Error(`Work claims response entry ${index} is not a claim.`);
    return claim;
  });
}
