import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  parsePublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import { hasCapability } from './capability.js';
import { getJson } from './client/http.js';

/** `true` is capable, `false` is answered-not-capable, and `undefined` is undetermined. */
export type SessionEventWindowCapability = boolean | undefined;

const capabilityCache = new Map<
  string,
  Promise<SessionEventWindowCapability>
>();
// One pending eviction timer per apiBase, keyed the same as `capabilityCache`
// — station#3437 review round 2 (LOW-1). A `false`/`undefined` settlement
// arms a timer to evict itself later; without tracking the handle, a manual
// invalidate (or the blunt reset) could only delete the MAP ENTRY, leaving
// that timer alive to fire later and delete whatever entry occupies the same
// key by then — including a freshly re-probed `true` (meant to be cached for
// the process lifetime, and scheduled with no eviction of its own).
const capabilityEvictionTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const recoveryAttempts = new Map<string, number>();
const MAX_AUTOMATIC_CAPABILITY_RECOVERIES = 3;
export const SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS = 30_000;
export const SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS = 60_000;

function recoveryKey(apiBase: string, sessionId: string): string {
  return `${apiBase}\u0000${sessionId}`;
}

/**
 * Reserves one bounded automatic re-probe for a host/session pair. The budget
 * outlives a component mount, while a confirmed capable response resets it.
 */
export function claimSessionEventWindowCapabilityRecovery(
  apiBase: string,
  sessionId: string,
): boolean {
  const key = recoveryKey(apiBase, sessionId);
  const attempts = recoveryAttempts.get(key) ?? 0;
  if (attempts >= MAX_AUTOMATIC_CAPABILITY_RECOVERIES) return false;
  recoveryAttempts.set(key, attempts + 1);
  return true;
}

export function resetSessionEventWindowCapabilityRecovery(
  apiBase: string,
  sessionId: string,
): void {
  recoveryAttempts.delete(recoveryKey(apiBase, sessionId));
}
/** Negotiates support before a client requests a bounded event-window page. */
export function fetchSessionEventWindowCapability(
  apiBase: string,
): Promise<SessionEventWindowCapability> {
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
      return handshake
        ? hasCapability(handshake, 'sessionEventWindow')
        : undefined;
    } catch {
      return undefined;
    }
  })();
  capabilityCache.set(apiBase, promise);
  void promise.then((result) => {
    if (result) return;
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
      result === false
        ? SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS
        : SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS,
    );
    capabilityEvictionTimers.set(apiBase, timer);
  });
  return promise;
}

export function resetSessionEventWindowCapabilityCache(): void {
  for (const timer of capabilityEvictionTimers.values()) clearTimeout(timer);
  capabilityEvictionTimers.clear();
  capabilityCache.clear();
  recoveryAttempts.clear();
}

/**
 * Invalidates ONE host's cached capability probe (or in-flight promise) so
 * the next `fetchSessionEventWindowCapability(apiBase)` call issues a real
 * request instead of returning the cached settlement — station#3437 review
 * (HIGH-1). Without this, `retryCapabilityRecovery` reset only the recovery
 * *budget*; the cache entry the 4th automatic negotiate round had JUST
 * written (evicted only after `SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS`)
 * survived, so the manual retry issued zero new requests for up to 30s while
 * the exhausted flag it clears made the copy claim otherwise.
 *
 * Deliberately scoped to `apiBase` rather than the blunt
 * `resetSessionEventWindowCapabilityCache()`: that clears every host's cache
 * *and* `recoveryAttempts` in one call, which would silently hand an
 * unrelated session/host a free recovery-budget reset as a side effect of
 * this session's manual retry click. The caller already resets its own
 * `recoveryAttempts` entry via `resetSessionEventWindowCapabilityRecovery`.
 *
 * Also cancels this host's pending EVICTION timer, if any (station#3437
 * review round 2, LOW-1). A `false`/`undefined` settlement schedules a
 * timer that deletes the map entry once the TTL elapses; deleting the entry
 * here without cancelling that timer left it armed against whatever occupies
 * this key by the time it fires — including a re-probe that resolved
 * `true` moments later and is meant to be cached for the process lifetime.
 *
 * That covers only the case where the stale settlement had ALREADY armed
 * its timer by the time invalidate ran. Landing while the probe is still
 * IN FLIGHT (station#3437 review round 3, LOW-1 follow-up) leaves nothing
 * here to cancel — the settlement arms its timer only after this function
 * has already returned. The other half of the fix lives at the settlement
 * site in `fetchSessionEventWindowCapability`, which now only arms a timer
 * when its own promise is still the entry the cache holds.
 */
export function invalidateSessionEventWindowCapabilityCache(
  apiBase: string,
): void {
  const timer = capabilityEvictionTimers.get(apiBase);
  if (timer) {
    clearTimeout(timer);
    capabilityEvictionTimers.delete(apiBase);
  }
  capabilityCache.delete(apiBase);
}
