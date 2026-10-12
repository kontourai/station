/**
 * `GET /api/auth/authority` — the closed, credential-bound authority
 * observation (#481 groundwork).
 *
 * One authenticated read that returns what the serving Station resolves for
 * THIS request's credential: the current public `environmentId`, the
 * effective principal, and the verified grant tier. The response is parsed
 * CLOSED (`isAuthorityObservation`): unknown fields reject, so a future
 * server cannot flow unvalidated extras past this reader.
 *
 * The observation is authorization-neutral — it describes authority, grants
 * nothing, and contains no credential material. Requests fail closed: a
 * dead/absent credential is the boundary's `authentication_required`, never
 * a guessed identity. Pass `requestScope` (and any other
 * `ClientRequestOptions`) through so the read is partition- and
 * guard-consistent with the caller's other protected requests.
 */
import {
  AUTHORITY_OBSERVATION_SCHEMA_VERSION,
  type AuthorityObservation,
  isAuthorityObservation,
} from '@kontourai/station-contracts/authority-observation';
import { envelopeError } from './api-error-message';
import { type ClientRequestOptions, getJson, readJsonBody } from './http';

export type {
  AuthorityObservation,
  AuthorityObservationGrant,
  AuthorityObservationPrincipal,
} from '@kontourai/station-contracts/authority-observation';
export { AUTHORITY_OBSERVATION_SCHEMA_VERSION };

export async function getAuthorityObservation(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<AuthorityObservation> {
  const response = await getJson(`${apiBase}/api/auth/authority`, opts);
  if (!response.ok) {
    // The sentences are this client's own; the refusal's status, `code` and
    // Retry-After ride on the error (#2708), and a refusal whose body is not
    // JSON keeps its status.
    const message =
      response.status === 401
        ? 'This Station did not accept the presented credential.'
        : `This Station refused the authority observation (HTTP ${response.status}).`;
    throw envelopeError(response, await readJsonBody(response), message, {
      message,
    });
  }
  const parsed: unknown = await response.json();
  if (!isAuthorityObservation(parsed)) {
    throw new Error(
      `This Station returned an incompatible authority observation.`,
    );
  }
  return parsed;
}
