// Sourced from contracts (a declared, published dependency) rather than from
// `@kontourai/station-connect`, which is not published — an SDK tarball that
// imports connect is unresolvable for every external plugin author.
import type {
  FleetRoutingReceiptPage,
  FleetServeReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { HEALTH_PROBE_TIMEOUT_MS } from '@kontourai/station-contracts/http';
import type {
  ServiceUpdateProgress,
  SystemIdentityResponse,
} from '@kontourai/station-contracts/system-status';
import { _getApiBase } from '../api';
import { parseRestartExpectation } from '../core-update-restart-expectation';
import {
  parseServiceUpdateProgress,
  parseSystemIdentityResponse,
  parseSystemUpdateStatus,
} from '../system-update-status-parser';
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

/**
 * station#2327 — the optional init for a read that forwards react-query's
 * signal. Spread rather than passed as `undefined`: `authenticatedFetch`
 * carries the caller's arity through to `fetch`, and a read with no signal
 * must keep calling `fetch(url)` exactly as before.
 */
function signalInit(signal?: AbortSignal): [] | [RequestInit] {
  return signal ? [{ signal }] : [];
}

export async function fetchAuthStatus(
  signal?: AbortSignal,
): Promise<AuthStatusData> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/auth/status`,
    ...signalInit(signal),
  );
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

export async function fetchMonitoringStats(
  signal?: AbortSignal,
): Promise<MonitoringStatsData | null> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/stats`,
    ...signalInit(signal),
  );
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
  signal?: AbortSignal,
): Promise<MonitoringMetric[]> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/metrics?range=${range}`,
    ...signalInit(signal),
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: { metrics?: MonitoringMetric[] };
  };
  return result.success ? (result.data?.metrics ?? []) : [];
}

/**
 * A Station's fleet receipts (#98). Unlike the monitoring reads above, a
 * failed read THROWS rather than degrading to an empty page: an empty receipt
 * list is a real answer ("this Station has never fleet-routed or served a
 * turn"), so returning it for a failed read would state that as fact. The
 * caller renders the error.
 */
async function fetchFleetReceipts<Page>(
  route: 'fleet-routing-receipts' | 'fleet-serve-receipts',
  messages: { rejected: string; unreadable: string },
  limit?: number,
  signal?: AbortSignal,
): Promise<Page> {
  const apiBase = await resolveApiBase();
  const query = typeof limit === 'number' ? `?limit=${limit}` : '';
  const response = await authenticatedFetch(
    `${apiBase}/monitoring/${route}${query}`,
    ...signalInit(signal),
  );
  // Read the body BEFORE branching on status: a rejected response still
  // carries a sentence the route wrote on purpose (`monitoring.ts`'s 503
  // "This Station cannot locate its receipt log, ..."), and a synthesized
  // "rejected with HTTP 503" would discard it. `.catch` covers a body that
  // does not parse at all, the only case where a synthesized message is honest.
  const result = (await response
    .json()
    .catch(unlessDeadline(() => undefined))) as
    | { success: boolean; data?: Page; error?: string }
    | undefined;
  if (!response.ok) {
    // Preserve the status so `resolveFleetReceiptsRefetchInterval`
    // (archive#3444) can stop polling a credential failure that cannot
    // clear. The synthesized message is deliberately NOT prefixed "Failed to
    // fetch": `isStationTransportFailure` (`utils/stationTransportFailure.ts`)
    // reads that prefix as "the network is unreachable", the opposite of a
    // reachable server that rejected the request. The server's own `error`
    // text never collides.
    throw new StationHttpError(
      response.status,
      apiErrorMessage(
        result ?? {},
        `${messages.rejected} request rejected with HTTP ${response.status}`,
      ),
    );
  }
  if (!result?.success || !result.data) {
    throw new Error(apiErrorMessage(result ?? {}, messages.unreadable));
  }
  return result.data;
}

/** This Station's fleet routing receipts; see `fetchFleetReceipts`. */
export function fetchFleetRoutingReceiptsForStation(
  limit?: number,
  signal?: AbortSignal,
): Promise<FleetRoutingReceiptPage> {
  return fetchFleetReceipts<FleetRoutingReceiptPage>(
    'fleet-routing-receipts',
    {
      rejected: 'Fleet routing receipts',
      unreadable:
        'This Station could not read its fleet routing receipts. That is unknown, not empty.',
    },
    limit,
    signal,
  );
}

/** The serving side's own receipts; see `fetchFleetReceipts`. */
export function fetchFleetServeReceiptsForStation(
  limit?: number,
  signal?: AbortSignal,
): Promise<FleetServeReceiptPage> {
  return fetchFleetReceipts<FleetServeReceiptPage>(
    'fleet-serve-receipts',
    {
      rejected: 'Fleet serve receipts',
      unreadable:
        'This Station could not read what it has served. That is unknown, not empty.',
    },
    limit,
    signal,
  );
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
  return (await fetchMonitoringEventWindow(start, end, signal, filters)).events;
}

export async function fetchMonitoringEventWindow(
  start?: Date,
  end?: Date,
  signal?: AbortSignal,
  filters: MonitoringEventFilters = {},
): Promise<{ events: unknown[]; truncated: boolean }> {
  const apiBase = await resolveApiBase();
  const params = new URLSearchParams();
  if (start) {
    params.set('start', start.toISOString());
  }
  if (end) {
    params.set('end', end.toISOString());
  }
  // No bounds means all history, not the route's unbounded live SSE branch.
  if (!start && !end) params.set('end', new Date().toISOString());
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
    | {
        success: boolean;
        data?: unknown[];
        truncated?: boolean;
        error?: string;
      }
    | undefined;
  let parseFailure: unknown;
  try {
    result = (await response.json()) as {
      success: boolean;
      data?: unknown[];
      truncated?: boolean;
      error?: string;
    };
  } catch (error) {
    rethrowDeadline(error);
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
  if (!Array.isArray(result.data)) {
    throw new Error('The monitoring events response has no event array.');
  }
  // Older peers may omit the flag. At a requested cap, disclose possible
  // truncation rather than claiming the result is complete.
  return {
    events: result.data,
    truncated:
      result.truncated === true ||
      (result.truncated === undefined &&
        filters.limit !== undefined &&
        result.data.length >= filters.limit),
  };
}

export async function fetchBranding(
  signal?: AbortSignal,
): Promise<BrandingData> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/branding`,
    ...signalInit(signal),
  );
  const result = (await response
    .json()
    .catch(unlessDeadline(() => undefined))) as
    | {
        success: boolean;
        data?: {
          name?: string;
          logo?: { src: string; alt?: string } | null;
          theme?: unknown;
          welcomeMessage?: string | null;
        };
        error?: string;
      }
    | undefined;
  // An error answer must not read as "this Station has no branding": callers
  // such as Station's white-label theme would clear a cached theme on it.
  // Rejecting keeps the query's previous data (or none) instead.
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      apiErrorMessage(
        result ?? {},
        `Branding request rejected with HTTP ${response.status}`,
      ),
    );
  }
  if (!result?.success) {
    throw new Error(
      apiErrorMessage(result ?? {}, 'Branding request was not successful'),
    );
  }
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
  signal?: AbortSignal,
): Promise<CoreUpdateStatus> {
  const apiBase = await resolveApiBase(apiBaseOverride);
  const response = await authenticatedFetch(
    `${apiBase}/api/system/core-update`,
    { signal },
  );
  // HTTP status is checked BEFORE the body can read as success: a 503/401
  // whose body happens to parse must not be normalized into a status object
  // (the status is preserved for the same terminal/transient classification
  // the other system fetchers feed).
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      `Failed to fetch core update status: ${response.status}`,
    );
  }
  const parsed = parseSystemUpdateStatus(await response.json());
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return parsed;
}

/**
 * Read the answering server's identity triple. The 503 `identity_unavailable`
 * branch is a non-ok response, so it throws a `StationHttpError` with the
 * status preserved rather than parsing the body as an identity.
 */
export async function requestSystemIdentity(
  apiBase: string,
  signal?: AbortSignal,
): Promise<SystemIdentityResponse> {
  const response = await authenticatedFetch(`${apiBase}/api/system/identity`, {
    signal,
  });
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      `Failed to fetch system identity: ${response.status}`,
    );
  }
  return parseSystemIdentityResponse(await response.json());
}

/**
 * Read a launcher-run archive's update progress (`GET
 * /api/system/core-update/service-update`). A non-ok status throws; a body
 * this SDK cannot read as a progress state reads as `unavailable`.
 */
export async function requestServiceUpdateProgress(
  apiBase: string,
  signal?: AbortSignal,
): Promise<ServiceUpdateProgress> {
  const response = await authenticatedFetch(
    `${apiBase}/api/system/core-update/service-update`,
    { signal },
  );
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      `Failed to fetch service update progress: ${response.status}`,
    );
  }
  return parseServiceUpdateProgress(await response.json());
}

export async function applyCoreUpdate(apiBase: string): Promise<{
  success: boolean;
  error?: string;
  /** Git-based self-update accepted; the app rebuilds and restarts (#1624). */
  updating?: boolean;
  restarting?: boolean;
  restart?: CoreUpdateRestartExpectation;
  /**
   * A launcher-run archive queued the update (#2675): follow it with
   * `requestServiceUpdateProgress`, correlating by `requestId`.
   */
  serviceUpdate?: { requestId: string };
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
    serviceUpdate?: unknown;
    logPath?: string;
    message?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to apply core update'));
  }
  const {
    restart: rawRestart,
    serviceUpdate: rawServiceUpdate,
    ...responsePayload
  } = result;
  if (rawServiceUpdate !== undefined) {
    const requestId = (rawServiceUpdate as { requestId?: unknown } | null)
      ?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('Service update request could not be followed');
    }
    return { ...responsePayload, serviceUpdate: { requestId } };
  }
  if (result.restarting) {
    const restart = parseRestartExpectation(rawRestart);
    if (!restart) {
      throw new Error('Core update restart could not be verified');
    }
    return { ...responsePayload, restart };
  }
  return responsePayload;
}

/**
 * `signal` is react-query's per-attempt signal (station#2327): without it a
 * cancelled query stopped listening while its request kept its place in the
 * desktop broker's queue, so a stalled Station accumulated orphans.
 */
export async function fetchServerCapabilities(
  signal?: AbortSignal,
): Promise<ServerCapabilities> {
  const apiBase = await resolveApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/system/capabilities`,
    ...signalInit(signal),
  );
  if (!response.ok) {
    throw new Error('Failed to fetch server capabilities');
  }
  return (await response.json()) as ServerCapabilities;
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch, StationHttpError } from '../client/http';
import { rethrowDeadline, unlessDeadline } from '../client/request-deadline';
