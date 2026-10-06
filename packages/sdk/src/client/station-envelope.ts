/**
 * Whether a response is the answer of the Station that was called (#2842).
 *
 * Only Station's own refusal is definitive: the queue drain drops a queued
 * message on one, and the handoff dialog clears a retained request. A reverse
 * proxy, gateway or tunnel can answer with JSON in exactly Station's shape, so
 * the shape alone cannot say who wrote the body. A Station that knows the
 * marker puts `STATION_ENVELOPE_HEADER` on every JSON body it writes, and an
 * intermediary does not.
 *
 * A Station older than the marker never sends it, and must not regress: its
 * refusals are still recognized by shape. So absence only counts against a
 * response once its origin has sent the marker at least once in this process.
 * Every response the request seams in `http.ts` return is observed here, a
 * success as much as a refusal, so an origin is normally known well before it
 * refuses anything.
 */
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';

/** What this module reads of a `Response`; test doubles may omit either. */
export interface StationEnvelopeResponse {
  url?: string;
  headers?: { get(name: string): string | null } | null;
}

/**
 * Origins that have sent the marker. Bounded: past the limit the origin seen
 * longest ago is forgotten, and a forgotten origin is read by shape until its
 * next marked response, which is the behavior before the marker existed.
 *
 * What this memory cannot tell apart: an origin that once sent the marker and
 * now serves an older Station (a downgrade, or a mixed-version rolling deploy
 * behind one origin). Until the origin is forgotten, that older Station's
 * unmarked refusals read as an intermediary's, so a definitive refusal is
 * retried instead of dropped; a queued message can then be resent and refused
 * again until the client switches Station, its credential changes, or the
 * page reloads. The failure is a retry, never a dropped message.
 */
const MAX_MARKING_ORIGINS = 64;
const markingOrigins = new Set<string>();

/**
 * The origin each observed response was requested from. A native transport's
 * `Response` has no `url`, so the request's own URL is kept for it.
 */
const requestOrigins = new WeakMap<object, string>();

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    // A browser's relative URL resolves against the page; elsewhere there is
    // no base and a relative URL has no origin.
    const base = (globalThis as { location?: { href?: string } }).location
      ?.href;
    const origin = new URL(url, base).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Does the response carry the marker, with exactly its one value? */
export function hasStationEnvelopeMarker(
  response: StationEnvelopeResponse,
): boolean {
  const headers = response.headers;
  if (!headers || typeof headers.get !== 'function') return false;
  return (
    headers.get(STATION_ENVELOPE_HEADER)?.trim() ===
    STATION_ENVELOPE_HEADER_VALUE
  );
}

/**
 * Records what one response says about its origin, and returns it unchanged.
 * Called by `getJson`, `mutateJson` and `authenticatedFetch` on the response
 * they hand back.
 */
export function observeStationResponse<T extends StationEnvelopeResponse>(
  requestUrl: string,
  response: T,
): T {
  const origin = originOf(requestUrl);
  if (origin === undefined) return response;
  if (typeof response === 'object' && response !== null) {
    requestOrigins.set(response, origin);
  }
  if (hasStationEnvelopeMarker(response)) {
    // Re-inserted so the most recently marked origin is the last forgotten.
    markingOrigins.delete(origin);
    markingOrigins.add(origin);
    if (markingOrigins.size > MAX_MARKING_ORIGINS) {
      const oldest = markingOrigins.values().next().value;
      if (oldest !== undefined) markingOrigins.delete(oldest);
    }
  }
  return response;
}

/**
 * Whether a parsed body has the shape of Station's own answer: a route
 * envelope (a boolean `success`) or the runtime's auth refusal
 * (`{ error: { code } }`). The shape is necessary, not sufficient: anything
 * between the client and Station can produce it. Use {@link isStationAnswer}
 * to decide who answered.
 */
export function isStationEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const value = body as { success?: unknown; error?: unknown };
  if (typeof value.success === 'boolean') return true;
  return (
    typeof value.error === 'object' &&
    value.error !== null &&
    typeof (value.error as { code?: unknown }).code === 'string'
  );
}

/**
 * Whether Station itself wrote this body.
 *
 * - The body must have Station's shape; a page or foreign JSON never does.
 * - With the marker, it is Station's answer.
 * - Without the marker, it is not Station's answer if this origin has sent
 *   the marker before: something in between wrote it.
 * - Without the marker, from an origin that has never sent it (a Station
 *   older than the marker, or one whose marker a cross-origin browser cannot
 *   read), the shape decides, as it did before the marker existed.
 */
export function isStationAnswer(
  response: StationEnvelopeResponse,
  body: unknown,
): boolean {
  if (!isStationEnvelope(body)) return false;
  if (hasStationEnvelopeMarker(response)) return true;
  const origin =
    (typeof response === 'object' && response !== null
      ? requestOrigins.get(response)
      : undefined) ?? originOf(response.url);
  return origin === undefined || !markingOrigins.has(origin);
}

/**
 * Forget what one origin has said, so its next answer is read afresh. Called
 * when the credential for that origin changes (`notifyCredentialChanged`).
 */
export function forgetStationOrigin(url: string): void {
  const origin = originOf(url);
  if (origin !== undefined) markingOrigins.delete(origin);
}

/**
 * Forget every observed origin. Called when the client switches to another
 * Station (`_setApiBase` with a new base), and by tests, which share one module.
 */
export function resetStationEnvelopeObservations(): void {
  markingOrigins.clear();
}
