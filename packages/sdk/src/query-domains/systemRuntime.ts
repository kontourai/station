import type {
  AuthStatus,
  UserIdentity,
} from '@kontourai/station-contracts/auth';
import type {
  FleetRoutingReceiptPage,
  FleetServeReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { isTerminalConnectionStatus } from '@kontourai/station-contracts/http';
import type {
  DevicePresentation,
  ExternalEngineReadinessProjection,
} from '@kontourai/station-contracts/system-status';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { StationHttpError } from '../client/http';
import {
  type MutationOptions,
  PERSISTED_QUERY_GC_TIME_MS,
  type QueryConfig,
  useApiQuery,
} from '../query-core';
import {
  applyCoreUpdate,
  fetchAuthStatus,
  fetchBranding,
  fetchFleetRoutingReceiptsForStation,
  fetchFleetServeReceiptsForStation,
  fetchMonitoringMetrics,
  fetchMonitoringStats,
  fetchServerCapabilities,
  renewAuth,
  requestCoreUpdateStatus,
  requestSystemStatus,
  verifyBedrockConnection,
  verifyManagedRuntimeConnection,
} from './systemRuntimeRequests';

export {
  applyCoreUpdate,
  fetchAuthStatus,
  fetchBranding,
  fetchFleetRoutingReceiptsForStation,
  fetchFleetServeReceiptsForStation,
  fetchMonitoringEvents,
  fetchMonitoringMetrics,
  fetchMonitoringStats,
  fetchServerCapabilities,
  renewAuth,
  requestCoreUpdateStatus,
  requestSystemStatus,
  verifyBedrockConnection,
  verifyManagedRuntimeConnection,
} from './systemRuntimeRequests';

export interface SystemPrerequisite {
  id: string;
  name: string;
  description: string;
  status: 'installed' | 'error' | 'missing';
  category: 'required' | 'optional';
  source?: string;
  reason?: 'timed_out';
  installGuide?: { steps: string[]; commands?: string[] };
}

/**
 * Build provenance for the answering instance, as far as it could establish
 * it. Every field is independently optional (station#1085) — the packaged
 * desktop shell and a CLI instance started without a build manifest supply
 * different subsets, and a partial answer is more useful than none.
 */
export interface SystemBuildProvenance {
  fullSha?: string;
  shortSha?: string;
  shaSource?: 'build-stamp' | 'checkout';
  branch?: string;
  builtAt?: string;
  ageSeconds?: number;
  instanceId?: string;
  bootId?: string;
  channel?: string;
  dirty?: boolean;
}

export interface SystemStatus {
  build?: SystemBuildProvenance;
  /**
   * The answering instance's own endpoint identity (#2551): bound listen
   * host/port and configured public origins, as far as the route host
   * supplies them. Absent entirely when the host supplies no endpoint facts.
   */
  server?: {
    host?: string;
    port?: number;
    publicOrigins?: string[];
  };
  prerequisites?: SystemPrerequisite[];
  /**
   * Discovery is intentionally off the status hot path. `pending` means no
   * verified snapshot exists yet; `stale` means the prior snapshot is being
   * served while a background refresh runs.
   */
  prerequisitesState?: 'pending' | 'ready' | 'stale';
  acp: {
    connected: boolean;
    connections: Array<{ id: string; status: string }>;
  };
  providers?: {
    configuredChatReady?: boolean;
    configured: Array<{
      id: string;
      type: string;
      enabled: boolean;
      capabilities?: string[];
    }>;
    detected: {
      ollama: boolean;
      bedrock: boolean;
    };
  };
  clis: Record<string, boolean>;
  /**
   * Which machine is reading this status (station#3843 §1). Optional only
   * because an older route host does not serve it; a consumer that gets
   * `undefined` makes NO device claim rather than assuming either class.
   */
  devicePresentation?: DevicePresentation;
  externalEngines?: ExternalEngineReadinessProjection[];
  developerServices?: Array<{
    id: 'git' | 'github' | 'gitlab';
    name: string;
    state: 'ready' | 'not_installed' | 'sign_in_required' | 'error';
    detail: string;
    command?: string;
  }>;
  capabilities?: Record<
    string,
    {
      ready: boolean;
      source: string | null;
      /**
       * Specific, actionable cause recorded by the producer when `ready` is
       * false — e.g. the `terminal` capability's node-pty load failure
       * (station#1244). Absent when nothing specific was observed.
       */
      reason?: string;
    }
  >;
  recommendation?: {
    code?:
      | 'configured-chat-ready'
      | 'configured-no-chat'
      | 'detected-provider'
      | 'runtime-only'
      | 'unconfigured';
    type: 'providers' | 'runtimes' | 'connections';
    actionLabel: string;
    title: string;
    detail: string;
    detectedProviderType?: string;
    detectedProviderLabel?: string;
  };
  ready: boolean;
}

export interface AuthStatusData extends AuthStatus {
  user: UserIdentity | null;
}

export interface MonitoringAgentStat {
  slug: string;
  name: string;
  status: 'idle' | 'active' | 'running';
  model: string;
  conversationCount: number;
  messageCount: number;
  cost: number;
  healthy?: boolean;
}

export interface MonitoringStatsData {
  agents: MonitoringAgentStat[];
  summary: {
    totalAgents: number;
    activeAgents: number;
    runningAgents: number;
    totalMessages: number;
    totalCost: number;
  };
}

export interface MonitoringMetric {
  agentSlug: string;
  messageCount: number;
  conversationCount: number;
  totalCost: number;
}

export interface BrandingData {
  appName: string;
  logo: { src: string; alt?: string } | null;
  theme: Record<string, string> | null;
  welcomeMessage: string | null;
}

export interface ServerCapabilities {
  runtime?: string;
  voice?: {
    stt?: import('../voice/types').ProviderCapability[];
    tts?: import('../voice/types').ProviderCapability[];
  };
  context?: {
    providers?: Array<{
      id: string;
      name: string;
      visibleOn?: string[];
    }>;
  };
  scheduler?: boolean;
  /**
   * Facts supplied by the answering deployment, rather than Station's static
   * build/handshake capability registry. This namespace is optional because
   * clients can connect to servers released before deployment capabilities.
   */
  deployment?: {
    features?: Partial<
      Record<DeploymentCapabilityId, { state: DeploymentCapabilityState }>
    >;
  };
}

export type DeploymentCapabilityId = 'web-push' | 'scheduler';
export type DeploymentCapabilityState = 'supported' | 'unsupported' | 'unknown';

/**
 * An absent, future, or malformed deployment fact must not authorize work.
 * This gives newer clients a safe answer from older servers while preserving
 * forward compatibility for capability IDs added later.
 */
export function getDeploymentCapabilityState(
  capabilities: ServerCapabilities | undefined,
  id: DeploymentCapabilityId,
): DeploymentCapabilityState {
  const state = capabilities?.deployment?.features?.[id]?.state;
  return state === 'supported' || state === 'unsupported' || state === 'unknown'
    ? state
    : 'unknown';
}

export interface CoreUpdateStatus {
  currentHash?: string;
  remoteHash?: string;
  branch?: string;
  behind?: number;
  ahead?: number;
  updateAvailable: boolean;
  noUpstream?: boolean;
  /** How this install was made — absent on servers older than station#1624. */
  installKind?: 'source-checkout' | 'desktop-bundle' | 'unknown';
  /** Release channel a stamped bundle tracks (e.g. "nightly"). */
  channel?: string;
  /** What applying an update means here; the apply button is git-pull only. */
  applyMethod?: 'git-pull' | 'reinstall' | 'self-update';
  /**
   * The channel remote could not be queried. A disclosed warning state, not
   * an `error`: `error` makes the request throw and would hide the install
   * provenance the server just reported.
   */
  remoteUnreachable?: boolean;
  message?: string;
  error?: string;
}

/** Correlates an accepted git-pull restart with its detached watchdog. */
export interface CoreUpdateRestartExpectation {
  expectedHash: string;
  expectedInstanceId: string;
  deadlineAt: string;
}

/**
 * Durable outcome written by the self-update watchdog. `unavailable` is an
 * explicit failure-to-verify state, never a substitute for `verified`.
 */
export type CoreUpdateRestartStatus =
  | { status: 'unavailable' }
  | ({ status: 'pending'; resolvedAt?: never } & CoreUpdateRestartExpectation)
  | ({
      status: 'verified' | 'failed';
      resolvedAt: string;
    } & CoreUpdateRestartExpectation);

/**
 * Poll cadence (ms) used while system prerequisite discovery is still
 * `pending`. The status route serves an all-false placeholder snapshot
 * while async probes (CLI availability, Ollama reachability, external-engine
 * readiness) are in flight; without polling, a query that resolves with that
 * placeholder never refetches until something else invalidates the cache.
 * Polling continues until the server publishes a settled (`ready`/`stale`)
 * snapshot, after which the caller's `pollInterval` (or `false`) applies.
 */
const SYSTEM_STATUS_PENDING_POLL_MS = 1_500;

/**
 * station#3444: same terminal/transient split as `resolveMonitoringStatsRefetchInterval`
 * below — a credential failure (401/403) rejects every retry identically, so
 * polling it every 5s is a request the server will refuse forever. Anything
 * else (network failure, a transient 5xx) keeps the flat 5s cadence.
 */
export function resolveSystemStatusRefetchInterval(
  query: { state: { status: string; data?: SystemStatus; error?: unknown } },
  pollInterval?: number,
): number | false {
  if (query.state.status === 'error') {
    if (
      query.state.error instanceof StationHttpError &&
      isTerminalConnectionStatus(query.state.error.status)
    ) {
      return false;
    }
    return 5_000;
  }
  if (query.state.data?.prerequisitesState === 'pending') {
    return SYSTEM_STATUS_PENDING_POLL_MS;
  }
  return pollInterval ?? false;
}

/**
 * station#3444: the per-attempt sibling of the refetch-interval split above —
 * without it, a 401/403 still burned `retry: 2`'s two extra attempts (three
 * requests) before the interval resolver even got a say, on a status that
 * rejects every one of them identically. Same pattern as
 * `shouldRetryLayoutCatalog` (`workspaceProjects.ts`).
 */
export function shouldRetrySystemStatus(
  failureCount: number,
  error: Error,
): boolean {
  if (
    error instanceof StationHttpError &&
    isTerminalConnectionStatus(error.status)
  ) {
    return false;
  }
  return failureCount < 2;
}

export function useSystemStatusQuery(
  pollInterval?: number,
  config?: QueryConfig<SystemStatus>,
) {
  return useQuery({
    queryKey: ['system-status'],
    queryFn: () => requestSystemStatus(),
    refetchInterval: (query) =>
      resolveSystemStatusRefetchInterval(query, pollInterval),
    staleTime: config?.staleTime ?? 10_000,
    // System status is persisted for an offline shell, but it is also the
    // source of truth for first-run readiness. Always revalidate it when the
    // app mounts so a connection completed outside the current page lifetime
    // cannot leave a restored "setup needed" snapshot covering a ready app.
    refetchOnMount: 'always',
    // station#1223: see PERSISTED_QUERY_GC_TIME_MS.
    gcTime: config?.gcTime ?? PERSISTED_QUERY_GC_TIME_MS,
    enabled: config?.enabled ?? true,
    retry: shouldRetrySystemStatus,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });
}

export function useAuthStatusQuery(config?: QueryConfig<AuthStatusData>) {
  return useApiQuery(['auth-status'], () => fetchAuthStatus(), {
    staleTime: config?.staleTime ?? 30_000,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

export function useRenewAuthMutation(
  options?: MutationOptions<{ success: boolean; error?: string }, void>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => renewAuth(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['auth-status'] });
      options?.onSuccess?.(data, undefined);
    },
    onError: (error) => {
      options?.onError?.(error as Error, undefined);
    },
  });
}

export function useVerifyBedrockMutation(
  options?: MutationOptions<
    { verified: boolean; error?: string },
    string | undefined
  >,
) {
  return useMutation({
    mutationFn: async (region?: string) => verifyBedrockConnection(region),
    onSuccess: (data, region) => {
      options?.onSuccess?.(data, region);
    },
    onError: (error, region) => {
      options?.onError?.(error as Error, region);
    },
  });
}

export function useVerifyManagedRuntimeMutation(
  options?: MutationOptions<
    { verified: boolean; error?: string },
    string | undefined
  >,
) {
  return useMutation({
    mutationFn: async (region?: string) =>
      verifyManagedRuntimeConnection(region),
    onSuccess: (data, region) => {
      options?.onSuccess?.(data, region);
    },
    onError: (error, region) => {
      options?.onError?.(error as Error, region);
    },
  });
}

export function useSystemStatusForApiBaseQuery(
  apiBase: string,
  pollInterval?: number,
  config?: QueryConfig<SystemStatus>,
) {
  return useQuery({
    queryKey: ['system-status', apiBase],
    queryFn: ({ signal }) => requestSystemStatus(apiBase, signal),
    refetchInterval: (query) =>
      resolveSystemStatusRefetchInterval(query, pollInterval),
    staleTime: config?.staleTime ?? 10_000,
    // The active-host query is persisted for offline shell rendering, but its
    // readiness fields must be revalidated whenever the app mounts. Otherwise
    // a fresh cached "setup needed" snapshot can cover a host that became
    // chat-ready between page lifetimes.
    refetchOnMount: 'always',
    // station#1223: see PERSISTED_QUERY_GC_TIME_MS.
    gcTime: config?.gcTime ?? PERSISTED_QUERY_GC_TIME_MS,
    enabled: !!apiBase && (config?.enabled ?? true),
    // fix-round M-3: this is the query behind the connect/pairing screen —
    // where a stale or rejected credential is the single most common error —
    // so it gets the same terminal-stop treatment as `useSystemStatusQuery`
    // above, not a plain fixed count that burns two more requests against a
    // 401/403 that will reject every one of them identically.
    retry: shouldRetrySystemStatus,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });
}

/**
 * The device-presentation projection, read from the status query that is
 * already in flight for `apiBase` — never a second request and never a
 * second derivation (station#3843 §1).
 *
 * `undefined` means "the server has not said yet" (still loading, an error,
 * or a route host too old to serve the projection). Every consumer must
 * treat that as NO CLAIM and render the affordance exactly as it renders it
 * for the host, rather than defaulting to a device class: telling someone
 * sitting at the host to "run this on <name>", or handing a phone a shell
 * command as if it were local, are both sentences nobody computed.
 */
export function useDevicePresentation(
  apiBase: string,
): DevicePresentation | undefined {
  return useSystemStatusForApiBaseQuery(apiBase).data?.devicePresentation;
}

/**
 * Forces a genuinely new `/api/system/status` attempt for `apiBase`, even while
 * one is already in flight.
 *
 * `refetch()` alone is not enough in the case that matters most. query-core
 * gates its cancel-and-restart path on `state.data !== undefined`
 * (`query.ts`'s `fetch()`); a query that has never successfully loaded — the
 * never-connected, still-pending case behind Station's connect screen — has no
 * data, so a mid-flight `refetch()` falls through to `continueRetry()` and
 * simply re-attaches to the attempt already running. No new request is made.
 * A "Try again" button wired straight to `refetch()` is therefore a no-op in
 * exactly the state a user is most likely to press it, while the label
 * cheerfully reads "Retrying...".
 *
 * Cancelling first tears down the in-flight retryer so the refetch has to
 * start over. Cancelling an idle query is a no-op, so this is equally safe to
 * call from an error state, where plain `refetch()` would already have worked.
 */
export function useForceRefetchSystemStatus(apiBase: string) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    const queryKey = ['system-status', apiBase];
    await queryClient.cancelQueries({ queryKey });
    await queryClient.refetchQueries({ queryKey });
  }, [queryClient, apiBase]);
}

const MONITORING_STATS_POLL_MS = 5_000;

/**
 * Same terminal/transient vocabulary as `fetchSSE`'s `classifySseFailure`
 * (`client/http.ts`): a credential failure (401/403) cannot clear by polling
 * again, so it stops the poll instead of retrying it every
 * `MONITORING_STATS_POLL_MS` forever beside a stream that already stopped
 * (station#3436). Anything else — network failure, a transient 5xx — keeps
 * the same cadence rather than going silent. `resolveSystemStatusRefetchInterval`
 * above and `resolveFleetReceiptsRefetchInterval` below (station#3444)
 * replicate the same split for their own queries.
 */
export function resolveMonitoringStatsRefetchInterval(query: {
  state: { status: string; error?: unknown };
}): number | false {
  if (
    query.state.status === 'error' &&
    query.state.error instanceof StationHttpError &&
    isTerminalConnectionStatus(query.state.error.status)
  ) {
    return false;
  }
  return MONITORING_STATS_POLL_MS;
}

export function useMonitoringStatsQuery(
  config?: QueryConfig<MonitoringStatsData | null>,
) {
  return useQuery({
    queryKey: ['monitoring-stats'],
    queryFn: () => fetchMonitoringStats(),
    refetchInterval: (query) => resolveMonitoringStatsRefetchInterval(query),
    // The interval above already re-polls transient failures on its own
    // cadence; per-attempt retry would pile extra requests on top of that
    // during exactly the window this fix bounds.
    retry: false,
    staleTime: config?.staleTime,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

export function useMonitoringMetricsQuery(
  range: 'today' | 'week' | 'month' | 'all',
  config?: QueryConfig<MonitoringMetric[]>,
) {
  return useQuery({
    queryKey: ['monitoring-metrics', range],
    queryFn: () => fetchMonitoringMetrics(range),
    refetchInterval: 30_000,
    staleTime: config?.staleTime,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

const FLEET_RECEIPTS_POLL_MS = 30_000;

/**
 * station#3444: shared by both fleet receipt queries below — same
 * terminal/transient split as `resolveMonitoringStatsRefetchInterval`. Both
 * fetchers now preserve the response status as a `StationHttpError`
 * (`fetchFleetRoutingReceiptsForStation`/`fetchFleetServeReceiptsForStation`,
 * `systemRuntimeRequests.ts`) specifically so this has something real to
 * classify — without that, a 401/403 body still parses as a generic `Error`
 * and this could never tell it apart from any other failure.
 */
export function resolveFleetReceiptsRefetchInterval(query: {
  state: { status: string; error?: unknown };
}): number | false {
  if (
    query.state.status === 'error' &&
    query.state.error instanceof StationHttpError &&
    isTerminalConnectionStatus(query.state.error.status)
  ) {
    return false;
  }
  return FLEET_RECEIPTS_POLL_MS;
}

/**
 * station#1398 slice 4 — the web half of the receipt surface. Same fetcher
 * contract as `station operate`'s pane: a failed read surfaces as an error,
 * never as an empty list.
 */
export function useFleetRoutingReceiptsQuery(
  limit?: number,
  config?: QueryConfig<FleetRoutingReceiptPage>,
) {
  return useQuery({
    queryKey: ['fleet-routing-receipts', limit ?? null],
    queryFn: () => fetchFleetRoutingReceiptsForStation(limit),
    refetchInterval: (query) => resolveFleetReceiptsRefetchInterval(query),
    retry: false,
    staleTime: config?.staleTime,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

/** The serving half of the receipt surface (security review, M-2). */
export function useFleetServeReceiptsQuery(
  limit?: number,
  config?: QueryConfig<FleetServeReceiptPage>,
) {
  return useQuery({
    queryKey: ['fleet-serve-receipts', limit ?? null],
    queryFn: () => fetchFleetServeReceiptsForStation(limit),
    refetchInterval: (query) => resolveFleetReceiptsRefetchInterval(query),
    retry: false,
    staleTime: config?.staleTime,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

export function useBrandingQuery(config?: QueryConfig<BrandingData>) {
  return useApiQuery(['branding'], () => fetchBranding(), {
    staleTime: config?.staleTime ?? 5 * 60 * 1000,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

export function useCoreUpdateStatusQuery(
  apiBase: string,
  config?: QueryConfig<CoreUpdateStatus>,
) {
  return useQuery({
    queryKey: ['core-update-check', apiBase],
    queryFn: () => requestCoreUpdateStatus(apiBase),
    enabled: !!apiBase && (config?.enabled ?? true),
    staleTime: config?.staleTime,
    gcTime: config?.gcTime,
    retry: false,
  });
}

export function useApplyCoreUpdateMutation(
  apiBase: string,
  options?: MutationOptions<any, void>,
) {
  return useMutation({
    mutationFn: async () => applyCoreUpdate(apiBase),
    onSuccess: (data) => {
      options?.onSuccess?.(data, undefined);
    },
    onError: (error) => {
      options?.onError?.(error as Error, undefined);
    },
  });
}

export function useServerCapabilitiesQuery(
  config?: QueryConfig<ServerCapabilities>,
) {
  return useApiQuery(
    ['system-capabilities'],
    () => fetchServerCapabilities(),
    config,
  );
}
