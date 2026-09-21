/**
 * #481 client authority — stable durable namespace for persisted query caches.
 *
 * The persisted React Query snapshot (`lib/queryPersistence.ts`, archive#1223)
 * used one global IndexedDB key (`station-query-cache-v1`) under one global
 * `QueryClient`. Two Station homes can legitimately share project ids, and
 * one endpoint can serve different principals/grants, so a singleton cache
 * cannot tell whose data it holds. This module derives the namespace from
 * the CLOSED server observation (`GET /api/auth/authority`,
 * `packages/sdk/src/client/authority-observation.ts`) — never from endpoint
 * strings, cookie contents, or profile display labels, none of which is an
 * identity.
 *
 * Namespace tuple (all server-resolved public facts):
 *   environmentId + principal(kind/id) + public grant(kind/deviceId/sorted scopes)
 *
 * Deliberately NOT in the tuple:
 *  - Per-tab `activationEpoch` / `authorityGeneration` — live cancellation
 *    facts only. They churn on every switch/re-pair, so keying durable
 *    storage on them would orphan a fresh blob per tab and defeat restore.
 *  - Credential material, token hashes, native binding secrets — the key
 *    names a shelf, it must never carry the ability to open anything.
 *
 * Encoding is canonical (`encodeURIComponent` per field, `|`-joined with a
 * `v1` prefix, scopes sorted + deduped) so the same authority always maps to
 * the same storage key regardless of field order on the wire.
 *
 * Offline restore policy: blobs are RETAINED physically and NEVER hydrated
 * or shown without a live observation for the current authority. A stored
 * tuple proves what the cache was saved under, not what the Station
 * currently authorizes — a context flag cannot quarantine a blob once
 * mounted children can read it, so a boot with no observation runs on a
 * fresh ephemeral client (status unverified/unavailable, see
 * `contexts/AuthorityQueryContext.tsx`), never guessed identity.
 */

import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';

/** Storage-key prefix shared with the legacy singleton (see below). */
export const AUTHORITY_CACHE_KEY_PREFIX = 'station-query-cache-v1';

/**
 * The legacy singleton key (`queryPersistence.ts`'s
 * `QUERY_PERSISTENCE_STORAGE_KEY`). It is QUARANTINED, not adopted: no
 * active namespace ever reads it, and this slice never deletes it either —
 * deleting an unverified blob would be silent loss of data the operator may
 * still be entitled to. First boot after this slice leaves it untouched on
 * disk; a future migration with explicit operator consent may reclaim it.
 */
export const LEGACY_AUTHORITY_CACHE_KEY = AUTHORITY_CACHE_KEY_PREFIX;

function encodeField(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Canonical durable namespace for one observed authority. Pure: the same
 * observation always yields the same namespace, and live-only facts
 * (activation epoch, credential generation) cannot change it — pass only
 * the observation, which carries none of them.
 */
export function buildAuthorityNamespace(
  observation: AuthorityObservation,
): string {
  const grant =
    observation.grant.kind === 'operator'
      ? 'grant=operator'
      : `grant=device:${encodeField(observation.grant.deviceId)}:scopes=${[
          ...new Set(observation.grant.grantedScopes),
        ]
          .map((scope) => encodeField(scope))
          .sort()
          .join(',')}`;
  return [
    'v1',
    `env=${encodeField(observation.environmentId)}`,
    `principal=${encodeField(observation.principal.kind)}:${encodeField(observation.principal.id)}`,
    grant,
  ].join('|');
}

/**
 * IndexedDB storage key for one authority namespace. Namespaces are
 * disjoint by construction: preserving (or restoring) the blob under B
 * never touches the blob under A, and the legacy singleton is never
 * produced here — only `LEGACY_AUTHORITY_CACHE_KEY` names it.
 */
export function authorityPersistenceKey(namespace: string): string {
  return `${AUTHORITY_CACHE_KEY_PREFIX}::${namespace}`;
}

/**
 * Whether a mounted tree may treat its persisted snapshot as authorized
 * current data, retained-but-unverified history, or nothing at all.
 *  - 'verified' — the live observation resolved and owns this namespace.
 *  - 'unverified' — offline (or observation failed benignly): the stored
 *    blob is retained and restorable for reading, but nothing may treat it
 *    as the Station's current authorization.
 *  - 'unavailable' — no observation (old server without the endpoint, no
 *    active connection): persistence is quarantined, the tree runs
 *    ephemeral so first-pairing repair stays usable.
 */
export type AuthorityPersistenceStatus =
  | 'verified'
  | 'unverified'
  | 'unavailable';
