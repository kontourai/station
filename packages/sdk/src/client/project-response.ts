import { envelopeError } from './api-error-message';
import { readJsonBody } from './http';

export interface ProjectEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** A route refusal's stable code, when it sent one. */
  code?: string;
}

/**
 * The single unwrap behind every `client/projects.ts` call.
 *
 * Status FIRST (4-HOME-006): a non-2xx is a failure whatever the body looks
 * like — including the runtime's auth refusal, which carries no `success` key
 * and whose `error` is an object, and including a body that is not JSON at
 * all. Only then does an `ok` response with `success:false` count as a
 * route-level refusal. Both throw the envelope helper's `StationHttpError`
 * (#2708): the observed status, `code`, `details` and a message that names
 * each field of a validation refusal (`Validation failed: name Required`).
 * An unreadable 2xx stays a plain `Error`: there is no failure status.
 *
 * A failure throws `StationHttpError`, so a consumer can branch on the STATUS
 * (`LayoutView`'s 404 not-found state, `RouteViewBoundary`'s authority
 * classification) instead of sniffing the message text for 'not found'. The
 * envelope's machine `code` rides along on the error for the cases where one
 * status names several outcomes (a verified not-prepared Project identity vs.
 * a removed Project) — again by status+code, never by message text.
 */
export async function unwrapProjectResponse<T = any>(
  response: Response,
  defaultError?: string,
): Promise<T> {
  const result = (await readJsonBody(response)) as
    | ProjectEnvelope<T>
    | undefined;
  if (!response.ok) {
    throw envelopeError(
      response,
      result,
      defaultError ?? `Request failed with HTTP ${response.status}`,
    );
  }
  // An unreadable 2xx is a protocol failure, with no failure status to carry.
  if (result === undefined) throw new Error(defaultError ?? 'Request failed');
  if (!result.success) {
    // #2708 A-2: a 2xx `success:false` is a refusal too, and keeps its
    // observed status (200), `code` and `details` — as every other client.
    throw envelopeError(response, result, defaultError ?? 'Request failed');
  }
  return result.data as T;
}
