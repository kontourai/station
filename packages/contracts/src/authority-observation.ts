/**
 * AuthorityObservation — the closed, public, credential-bound answer to
 * "what authority is this request actually acting as?".
 *
 * One authenticated read (`GET /api/auth/authority`) resolves, through the
 * SAME runtime auth boundary and the SAME principal owner every orchestration
 * route uses, the three facts a client needs to partition future multi-home
 * work (#481) without guessing:
 *
 *  - `environmentId` — the CURRENT public handshake identity of the serving
 *    Station (the same value `PublicStationHandshake` carries; never a
 *    client-remembered endpoint).
 *  - `principal` — the server-resolved effective principal for THIS request's
 *    credential, through the canonical `resolvePrincipal` composition. Closed
 *    to `kind`+`id`: no emails, no display names, no raw tenant headers.
 *  - `grant` — the verified authority tier: the operator credential, or a
 *    paired device with its PUBLIC device id and granted scope tokens. Never
 *    credential material, token hashes, or native binding secrets.
 *
 * The observation is authorization-NEUTRAL: it describes authority, it grants
 * nothing. An absent/unresolvable/conflicting/revoked identity fails closed
 * at the auth boundary or the route — there is no null-principal success and
 * no client-guessed fallback, because a caller that could guess the answer
 * would not need the endpoint.
 *
 * Deliberately NOT here: an `observationGeneration` counter. There is no
 * lifecycle owner for one yet; clients derive change detection from the
 * public identity tuple itself. A live generation belongs to the later
 * client-observation slice, owned separately.
 */
import { isPrincipalRef } from './principal.js';

export const AUTHORITY_OBSERVATION_SCHEMA_VERSION =
  'station.authority-observation/v1';

/** Closed principal echo: only the two identity fields, never contacts. */
export interface AuthorityObservationPrincipal {
  readonly kind: 'human' | 'tenant';
  readonly id: string;
}

/** Verified authority tier behind the request's credential. */
export type AuthorityObservationGrant =
  | {
      /** The Station operator credential (verified, not merely present). */
      readonly kind: 'operator';
    }
  | {
      /** A paired device credential with its public registry identity. */
      readonly kind: 'device';
      readonly deviceId: string;
      /** Space-delimited pairing scope tokens, split for direct reading. */
      readonly grantedScopes: readonly string[];
    };

export interface AuthorityObservation {
  readonly schemaVersion: typeof AUTHORITY_OBSERVATION_SCHEMA_VERSION;
  readonly environmentId: string;
  readonly principal: AuthorityObservationPrincipal;
  readonly grant: AuthorityObservationGrant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isObservationPrincipal(
  value: unknown,
): value is AuthorityObservationPrincipal {
  if (!isRecord(value)) return false;
  if (!hasOnlyKnownKeys(value, ['kind', 'id'])) return false;
  if (value.kind !== 'human' && value.kind !== 'tenant') return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  // Reuse the canonical permissive wire-shape check for the id grammar
  // (`isPrincipalRef`) instead of a hand-rolled pattern — the closed `kind`
  // pair and the missing `display` are this contract's own restrictions.
  return isPrincipalRef({ id: value.id, kind: value.kind, display: 'x' });
}

function isObservationGrant(
  value: unknown,
): value is AuthorityObservationGrant {
  if (!isRecord(value)) return false;
  if (value.kind === 'operator') return hasOnlyKnownKeys(value, ['kind']);
  if (value.kind === 'device') {
    if (!hasOnlyKnownKeys(value, ['kind', 'deviceId', 'grantedScopes']))
      return false;
    return (
      typeof value.deviceId === 'string' &&
      value.deviceId.length > 0 &&
      Array.isArray(value.grantedScopes) &&
      value.grantedScopes.every(
        (scope) => typeof scope === 'string' && scope.length > 0,
      )
    );
  }
  return false;
}

/**
 * Closed-shape validator: unknown fields reject, so a future server that
 * adds fields cannot silently flow past an older client's contract, and a
 * token-shaped extra can never ride along as an unvalidated property.
 */
export function isAuthorityObservation(
  value: unknown,
): value is AuthorityObservation {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKnownKeys(value, [
      'schemaVersion',
      'environmentId',
      'principal',
      'grant',
    ])
  )
    return false;
  if (value.schemaVersion !== AUTHORITY_OBSERVATION_SCHEMA_VERSION)
    return false;
  if (typeof value.environmentId !== 'string' || !value.environmentId)
    return false;
  if (!isObservationPrincipal(value.principal)) return false;
  return isObservationGrant(value.grant);
}
