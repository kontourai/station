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
import { type ClientRequestOptions, getJson } from './http';

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
  const parsed: unknown = await response.json();
  if (response.status === 401) {
    throw new Error('This Station did not accept the presented credential.');
  }
  if (!response.ok) {
    throw new Error(
      `This Station refused the authority observation (HTTP ${response.status}).`,
    );
  }
  if (!isAuthorityObservation(parsed)) {
    throw new Error(
      `This Station returned an incompatible authority observation.`,
    );
  }
  return parsed;
}
