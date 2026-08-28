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
 * 401/403 — e.g. `src-ui/src/lib/apiClient.ts`'s `apiRequest` is a one-shot
 * REST helper with its own hardcoded 401/403 check and a single
 * auth-callback-then-retry-once policy; it never loops unattended, so it
 * carries a materially lower version of the risk this type exists to close,
 * and adopting `isTerminalConnectionStatus` there is a disclosed follow-up,
 * not something this change claims to have already done.
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
