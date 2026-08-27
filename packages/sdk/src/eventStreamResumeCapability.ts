/**
 * station#1092 (sequence-cursor event-stream resume) — resolves the
 * `eventStreamResume` flag off the public `/.well-known/station/v1`
 * descriptor via the shared `hasCapability` accessor (station#1095's
 * registry). Lives outside `client/**` because `hasCapability` (`./capability.js`)
 * is a sibling of `client/`, and `client/**` files may only import their own
 * siblings or `./http` (enforced by `client-entry-portability.test.ts`).
 */
import type { PublicStationHandshake } from '@kontourai/station-contracts';
import { PUBLIC_STATION_HANDSHAKE_PATH } from '@kontourai/station-contracts/environment-security';
import { hasCapability } from './capability.js';
import { getJson } from './client/http.js';

const capabilityCache = new Map<string, Promise<boolean>>();

/**
 * Resolves whether `apiBase`'s Station host advertises
 * `capabilities.eventStreamResume === true`. Any failure — network error,
 * non-2xx, malformed body, a host that predates the field entirely — resolves
 * to `false` via `hasCapability`'s own fail-closed semantics; a host is
 * never assumed resume-capable. Cached per `apiBase` for the process
 * lifetime (the flag cannot change without a server restart a client would
 * reconnect through anyway).
 */
export function fetchEventStreamResumeCapability(
  apiBase: string,
): Promise<boolean> {
  const cached = capabilityCache.get(apiBase);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const response = await getJson(
        `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
        { authentication: 'omit', timeoutMs: 5000 },
      );
      if (!response.ok) return false;
      const handshake = (await response.json()) as Pick<
        PublicStationHandshake,
        'capabilities'
      >;
      return hasCapability(handshake, 'eventStreamResume');
    } catch {
      return false;
    }
  })();
  capabilityCache.set(apiBase, promise);
  return promise;
}

/** Test-only: clears the per-`apiBase` capability cache between test cases. */
export function resetEventStreamResumeCapabilityCache(): void {
  capabilityCache.clear();
}
