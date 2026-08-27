// Sourced from contracts (a declared, published dependency) rather than from
// `@kontourai/station-connect`, which is not published — an SDK tarball that
// imports connect is unresolvable for every external plugin author.
import type {
  FleetRoutingReceiptPage,
  FleetServeReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { HEALTH_PROBE_TIMEOUT_MS } from '@kontourai/station-contracts/http';
import { _getApiBase } from '../api';
import type {
  AuthStatusData,
  BrandingData,
  CoreUpdateRestartExpectation,
  CoreUpdateStatus,
  MonitoringMetric,
  MonitoringStatsData,
  ServerCapabilities,
  SystemStatus,
} from './systemRuntime';

async function resolveApiBase(apiBaseOverride?: string): Promise<string> {
  return apiBaseOverride ?? (await _getApiBase());
}

export async function fetchAuthStatus(): Promise<AuthStatusData> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/auth/status`);
  if (!response.ok) {
    throw new Error('Failed to fetch auth status');
  }
  return (await response.json()) as AuthStatusData;
}

export async function renewAuth(): Promise<{
  success: boolean;
  error?: string;
}> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/auth/renew`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error('Failed to renew auth');
  }
  return (await response.json()) as { success: boolean; error?: string };
}

export async function verifyManagedRuntimeConnection(
  region?: string,
): Promise<{ verified: boolean; error?: string }> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/system/verify-managed-runtime`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(region ? { region } : {}),
    },
  );
  return (await response.json()) as { verified: boolean; error?: string };
}

export async function verifyBedrockConnection(
  region?: string,
): Promise<{ verified: boolean; error?: string }> {
  return verifyManagedRuntimeConnection(region);
}

export async function requestSystemStatus(
  apiBaseOverride?: string,
  callerSignal?: AbortSignal,
): Promise<SystemStatus> {
  const apiBase = await resolveApiBase(apiBaseOverride);
  // Bound the readiness/setup probe so a wedged host cannot hang the gate; the
  // deadline is the same constant the browser reachability probe uses.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  // Honour the caller's signal too — react-query passes one per attempt. Without
  // this, cancelling a query only makes query-core stop listening: the fetch it
  // walked away from keeps running against the host until the timeout above
  // fires, so every "Try again" left an orphaned request in flight.
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  if (callerSignal?.aborted) controller.abort();
  try {
    const response = await authenticatedFetch(`${apiBase}/api/system/status`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      // A non-2xx status is what `resolveSystemStatusRefetchInterval` and
      // `shouldRetrySystemStatus` (station#3444) read to stop polling/retrying
      // a credential failure (401/403) that cannot clear by asking again,
      // instead of hammering the origin forever — preserved regardless of
      // body shape, same as `fetchMonitoringStats` below.
      throw new StationHttpError(
        response.status,
        `Failed to fetch system status: ${response.status}`,
      );
    }
    return (await response.json()) as SystemStatus;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function fetchMonitoringStats(): Promise<MonitoringStatsData | null> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(`${apiBase}/monitoring/stats`);
  if (!response.ok) {
    // A non-2xx status is what `resolveMonitoringStatsRefetchInterval` reads
    // to stop this poll on a credential failure that cannot clear (401/403)
    // instead of hammering the origin every 5s alongside a correctly-stopped
    // SSE transport (station#3436) — preserved regardless of body shape.
    throw new StationHttpError(
      response.status,
      `Failed to fetch monitoring stats: ${response.status}`,
    );
  }
  const result = (await response.json()) as {
    success: boolean;
    data?: MonitoringStatsData;
  };
  return result.success ? (result.data ?? null) : null;
}

export async function fetchMonitoringMetrics(
  range: 'today' | 'week' | 'month' | 'all',
): Promise<MonitoringMetric[]> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/metrics?range=${range}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: { metrics?: MonitoringMetric[] };
  };
  return result.success ? (result.data?.metrics ?? []) : [];
}

/**
 * station#1398 slice 4 — this Station's fleet routing receipts.
 *
 * Unlike its siblings above, a failed read THROWS rather than degrading to
 * an empty array. An empty receipt list is a real, meaningful answer ("this
 * Station has never fleet-routed a turn"), so returning it for a failed read
 * would make the surface state that as fact — the silent-degradation shape
 * §4.5 bans, applied to the receipts themselves. The caller renders the
 * error.
 */
export async function fetchFleetRoutingReceiptsForStation(
  limit?: number,
): Promise<FleetRoutingReceiptPage> {
  const apiBase = await resolveApiBase();
  const query = typeof limit === 'number' ? `?limit=${limit}` : '';
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/fleet-routing-receipts${query}`,
  );
  // Read the body BEFORE branching on status (fix-round HIGH-1): a rejected
  // response still carries a body the route author wrote on purpose — e.g.
  // `monitoring.ts`'s 503 "This Station cannot locate its receipt log, so
  // whether it has fleet-routed anything is unknown rather than empty."
  // Discarding it in favor of a synthesized "rejected with HTTP 503" throws
  // away the one sentence that told the reader what actually happened.
  // `.catch` covers a body that fails to parse at all (or is genuinely
  // empty), which is the only case a synthesized fallback is honest.
  const result = (await response.json().catch(() => undefined)) as
    | { success: boolean; data?: FleetRoutingReceiptPage; error?: string }
    | undefined;
  if (!response.ok) {
    // Preserve the status so `resolveFleetReceiptsRefetchInterval`
    // (station#3444) can stop polling a credential failure that cannot
    // clear. Deliberately NOT prefixed "Failed to fetch" when synthesized:
    // `isStationTransportFailure` (`utils/stationTransportFailure.ts`)
    // pattern-matches that exact prefix to mean "the network is
    // unreachable" — an HTTP status response is the opposite of that (a
    // reachable server that rejected the request) — so a fallback message
    // must not collide with it. The server's own `error` text never does.
    throw new StationHttpError(
      response.status,
      apiErrorMessage(
        result ?? {},
        `Fleet routing receipts request rejected with HTTP ${response.status}`,
      ),
    );
  }
  if (!result?.success || !result.data) {
    throw new Error(
      apiErrorMessage(
        result ?? {},
        'This Station could not read its fleet routing receipts. That is unknown, not empty.',
      ),
    );
  }
  return result.data;
}

/**
 * station#1398 slice 3/4 (security review, M-2) — the SERVING side's own
 * receipts. Throws on failure for the same reason its sibling does: an empty
 * serve log is a real answer ("this Station has served nothing"), so
 * returning it for a failed read would state that as fact.
 */
export async function fetchFleetServeReceiptsForStation(
  limit?: number,
): Promise<FleetServeReceiptPage> {
  const apiBase = await resolveApiBase();
  const query = typeof limit === 'number' ? `?limit=${limit}` : '';
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/fleet-serve-receipts${query}`,
  );
  // See the routing-receipt sibling above (fix-round HIGH-1): read the body
  // before branching on status so a route-authored error sentence — e.g.
  // `monitoring.ts`'s 503 "This Station cannot locate its receipt log, so
  // what it has served is unknown rather than empty." — survives.
  const result = (await response.json().catch(() => undefined)) as
    | { success: boolean; data?: FleetServeReceiptPage; error?: string }
    | undefined;
  if (!response.ok) {
    // Preserve the status so `resolveFleetReceiptsRefetchInterval`
    // (station#3444) can stop polling a credential failure that cannot
    // clear. Not "Failed to fetch" when synthesized — see the routing-receipt
    // sibling above; the server's own `error` text never collides.
    throw new StationHttpError(
      response.status,
      apiErrorMessage(
        result ?? {},
        `Fleet serve receipts request rejected with HTTP ${response.status}`,
      ),
    );
  }
  if (!result?.success || !result.data) {
    throw new Error(
      apiErrorMessage(
        result ?? {},
        'This Station could not read what it has served. That is unknown, not empty.',
      ),
    );
  }
  return result.data;
}

/**
 * Slicing for the historical branch (station#3076). These live here rather
 * than on a parallel insights fetch because this endpoint owns the per-user
 * and tenant authorization the rows require.
 */
export interface MonitoringEventFilters {
  agent?: string;
  tool?: string;
  engine?: string;
  conversation?: string;
  /** Only tool call/result events. */
  tools?: boolean;
  /**
   * Most recent N by timestamp. Opt-in: omit it and every matching row in
   * the window comes back — the route deliberately has no default, because
   * one applied there silently truncated this caller and the Monitoring
   * view (station#3075 review).
   */
  limit?: number;
}

export async function fetchMonitoringEvents(
  start?: Date,
  end?: Date,
  signal?: AbortSignal,
  filters: MonitoringEventFilters = {},
): Promise<unknown[]> {
  const apiBase = await resolveApiBase();
  const params = new URLSearchParams();
  if (start) {
    params.set('start', start.toISOString());
  }
  if (end) {
    params.set('end', end.toISOString());
  }
  if (filters.agent) params.set('agent', filters.agent);
  if (filters.tool) params.set('tool', filters.tool);
  if (filters.engine) params.set('engine', filters.engine);
  if (filters.conversation) params.set('conversation', filters.conversation);
  if (filters.tools) params.set('tools', 'true');
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/events?${params}`,
    { signal },
  );
  // Read the body before branching on status so a route-authored error
  // sentence survives — same order as the fleet fetchers above.
  let result:
    | { success: boolean; data?: unknown[]; error?: string }
    | undefined;
  let parseFailure: unknown;
  try {
    result = (await response.json()) as {
      success: boolean;
      data?: unknown[];
      error?: string;
    };
  } catch (error) {
    parseFailure = error;
  }
  // station#3658: a read that did not SUCCEED is not an empty one. Every
  // outcome here used to flatten to `[]`, which is what let the Monitoring
  // view draw "No events yet" over a 500 and made `downloadInsightEvents`
  // hand back an export it could not distinguish from a real absence.
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      apiErrorMessage(
        result ?? {},
        `Monitoring events request rejected with HTTP ${response.status}`,
      ),
    );
  }
  // Review MEDIUM-2: an unreadable 200 (a truncated proxy response, an HTML
  // login page) and `{success:false}` were both still read as "no events".
  // #2591 asked for this fetch to handle an invalid body "without throwing"
  // because an unhandled SyntaxError surfaced as misleading first-causal
  // noise in a raced test — but the ask was about a failure escaping
  // unhandled, and the store now CATCHES this and renders it as an error
  // state (that is the whole of #3658). Claiming zero events instead is the
  // error≠empty defect the issue exists to remove, so the tolerance ends
  // here; the harness half of #2591 (a test seam serving a well-formed
  // response) is unaffected.
  if (parseFailure !== undefined) {
    throw new Error(
      'Station could not read the monitoring events response, so what it has recorded is unknown rather than empty.',
    );
  }
  if (!result?.success) {
    throw new Error(
      apiErrorMessage(
        result ?? {},
        'The monitoring events request did not succeed, so what this Station has recorded is unknown rather than empty.',
      ),
    );
  }
  return result.data ?? [];
}

export async function fetchBranding(): Promise<BrandingData> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/branding`);
  const result = (await response.json()) as {
    success: boolean;
    data?: {
      name?: string;
      logo?: { src: string; alt?: string } | null;
      theme?: Record<string, string> | null;
      welcomeMessage?: string | null;
    };
  };
  const data = result.data ?? {};
  return {
    appName: data.name || 'Station',
    logo: data.logo ?? null,
    theme: data.theme ?? null,
    welcomeMessage: data.welcomeMessage ?? null,
  };
}

export async function requestCoreUpdateStatus(
  apiBaseOverride?: string,
): Promise<CoreUpdateStatus> {
  const apiBase = await resolveApiBase(apiBaseOverride);
  const response = await authenticatedFetch(
    `${apiBase}/api/system/core-update`,
  );
  const result = (await response.json()) as CoreUpdateStatus;
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseRestartExpectation(
  value: unknown,
): CoreUpdateRestartExpectation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.expectedHash !== 'string' ||
    !/^[a-f0-9]{7}$/.test(record.expectedHash) ||
    !isNonEmptyString(record.expectedInstanceId) ||
    !isCanonicalTimestamp(record.deadlineAt)
  ) {
    return null;
  }
  return {
    expectedHash: record.expectedHash,
    expectedInstanceId: record.expectedInstanceId,
    deadlineAt: record.deadlineAt,
  };
}

export async function applyCoreUpdate(apiBase: string): Promise<{
  success: boolean;
  error?: string;
  /** Git-based self-update accepted; the app rebuilds and restarts (#1624). */
  updating?: boolean;
  restarting?: boolean;
  restart?: CoreUpdateRestartExpectation;
  logPath?: string;
  message?: string;
}> {
  const response = await authenticatedFetch(
    `${apiBase}/api/system/core-update`,
    {
      method: 'POST',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
    updating?: boolean;
    restarting?: boolean;
    restart?: unknown;
    logPath?: string;
    message?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to apply core update'));
  }
  const { restart: rawRestart, ...responsePayload } = result;
  if (result.restarting) {
    const restart = parseRestartExpectation(rawRestart);
    if (!restart) {
      throw new Error('Core update restart could not be verified');
    }
    return { ...responsePayload, restart };
  }
  return responsePayload;
}

export async function fetchServerCapabilities(): Promise<ServerCapabilities> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/system/capabilities`,
  );
  if (!response.ok) {
    throw new Error('Failed to fetch server capabilities');
  }
  return (await response.json()) as ServerCapabilities;
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch, StationHttpError } from '../client/http';
