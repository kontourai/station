import type { PublicStationHandshake } from '@kontourai/station-contracts';
import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  parsePublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import { hasCapability } from './capability.js';
import { getJson } from './client/http.js';

const capabilityCache = new Map<
  string,
  Promise<PublicStationHandshake | undefined>
>();
const capabilityEvictionTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();

/** One anonymous descriptor read per host, shared by capability consumers. */
export function fetchPublicStationCapabilities(
  apiBase: string,
): Promise<PublicStationHandshake | undefined> {
  const cached = capabilityCache.get(apiBase);
  if (cached) return cached;
  const promise = (async () => {
    try {
      const response = await getJson(
        `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
        { authentication: 'omit', timeoutMs: 5000 },
      );
      if (!response.ok) return undefined;
      const handshake = parsePublicStationHandshake(await response.json());
      return handshake ?? undefined;
    } catch {
      return undefined;
    }
  })();
  capabilityCache.set(apiBase, promise);
  void promise.then((result) => {
    if (result && hasCapability(result, 'sessionEventWindow')) return;
    // Closes the LOW-1 fix's remaining in-flight window (station#3437 review
    // round 3): `invalidate` may run WHILE this probe is still pending, with
    // no eviction timer yet to cancel — it can only delete the map entry. If
    // a replacement probe then wrote a fresh entry under this same key before
    // THIS settlement ran, arming a timer here would schedule it against
    // whatever now occupies the key rather than against this stale result.
    // Only arm when this promise is still the entry the cache actually holds.
    if (capabilityCache.get(apiBase) !== promise) return;
    const timer = setTimeout(
      () => {
        capabilityEvictionTimers.delete(apiBase);
        capabilityCache.delete(apiBase);
      },
      result !== undefined ? 60_000 : 30_000,
    );
    capabilityEvictionTimers.set(apiBase, timer);
  });
  return promise;
}

export function resetPublicStationCapabilities(): void {
  for (const timer of capabilityEvictionTimers.values()) clearTimeout(timer);
  capabilityEvictionTimers.clear();
  capabilityCache.clear();
}

export function invalidatePublicStationCapabilities(apiBase: string): void {
  const timer = capabilityEvictionTimers.get(apiBase);
  if (timer) clearTimeout(timer);
  capabilityEvictionTimers.delete(apiBase);
  capabilityCache.delete(apiBase);
}
