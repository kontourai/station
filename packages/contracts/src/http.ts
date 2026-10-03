/** HTTP header carrying the calling plugin's name on Station API requests. */
export const STATION_PLUGIN_HEADER = 'x-station-plugin';

/**
 * Shared browser health-probe timeout (ms). Applied by `probeServerConnection`
 * (src-ui, via `@kontourai/station-connect`) and as the AbortController
 * deadline on the SDK's `requestSystemStatus` fetch, so the two paths cannot
 * diverge.
 *
 * It lives here rather than in `@kontourai/station-connect` because the SDK is
 * published and connect is not: an `@kontourai/station-sdk` tarball that
 * imports `@kontourai/station-connect/health-probe` is unresolvable for every
 * external plugin author. `contracts` is already a declared dependency of both
 * packages.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * Canonical origin for a Station base URL.
 *
 * Lives in contracts because both the connect client and the published SDK
 * need it: the SDK imported it from `@kontourai/station-connect`, which is
 * not published, so an SDK tarball was unresolvable for external plugin
 * authors (the same hazard the note in `query-domains/systemRuntimeRequests.ts`
 * already warns about).
 */
export function normalizeBaseUrl(value: string): string {
  return new URL(value).origin;
}

/**
 * Transient-vs-terminal HTTP retry classification, shared by
 * `@kontourai/station-connect`'s `ConnectionSupervisor`/
 * `classifyConnectionFailure` and the SDK's `fetchSSE` retry loop
 * (closing the "keeps retrying against a 401ing endpoint
 * forever" gap for the SSE streams). A 401/403 means the
 * saved credential is bad or expired: retrying it automatically can only
 * hot-loop, never succeed, so these two auto-retrying mechanisms must treat
 * it the same way.
 *
 * Scope, precisely: this reconciles the repo's two
 * *automatic, unattended* retry loops — the ones that can hot-loop silently
 * with nobody watching. It does not (yet) cover every place that inspects a
 * 401/403 — the former `src-ui/src/lib/apiClient.ts`'s `apiRequest`
 * (removed in station#2236; UI fetches now ride the SDK authenticated
 * transport) was a one-shot REST helper that never looped unattended, so
 * its removal retired that follow-up rather than leaving it open.
 *
 * Lives in `contracts`, not `connect`, for the same publish-boundary reason
 * as `HEALTH_PROBE_TIMEOUT_MS` above: the SDK is published and `connect` is
 * not, so an `@kontourai/station-sdk` tarball that imported
 * `@kontourai/station-connect` would be unresolvable for external plugin
 * authors. `connect`'s own `ConnectionFailureReason` enum (`types.ts`) stays
 * local to `connect` — it carries richer, health-probe-specific reasons
 * (offline, mixed-content, identity-mismatch, ...) that only make sense in
 * that package's own probing context. This export covers only the one fact
 * every caller needs to agree on: which HTTP statuses must stop automatic
 * retry.
 */
export type ConnectionRetryClassification = 'transient' | 'terminal';

/** True for the HTTP statuses that must stop automatic retry (401/403). */
export function isTerminalConnectionStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * The code a Station answers with while it throttles one peer's repeated
 * authentication failures, distinct from the mutation budget's
 * `rate_limited` (archive#3903). It is reached only after a peer's
 * credentials were refused repeatedly, so a client reads it as the same
 * authentication outcome as the 401s that fed it, not as "something else is
 * answering". The runtime's HTTP and WebSocket boundaries emit it and
 * `@kontourai/station-connect` classifies it, so both import it from here.
 */
export const AUTH_RATE_LIMITED_ERROR_CODE = 'authentication_rate_limited';

/**
 * The response header a Station runtime puts on every JSON body it writes
 * itself, success or refusal (#2842): its HTTP app's answers, and the
 * refusals it writes outside that app (the virtual application ingress and the
 * self-hosted broker's gated application). Its presence says the Station at the
 * other end of this connection wrote the body; a reverse proxy, gateway or
 * tunnel answering in between does not send it, whatever its JSON looks like.
 *
 * It is scoped to one hop. A Station that relays another Station's response
 * does not pass the header on, so a client never reads a peer's answer as the
 * answer of the Station it called.
 *
 * A Station older than this header never sends it. A client therefore treats
 * its absence as "not Station's answer" only for an origin that has already
 * sent it once, and otherwise falls back to the body's shape.
 */
export const STATION_ENVELOPE_HEADER = 'x-station-envelope';

/** The only value {@link STATION_ENVELOPE_HEADER} carries. */
export const STATION_ENVELOPE_HEADER_VALUE = '1';
