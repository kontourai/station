import { withNormalizedAnswerability } from '@kontourai/station-contracts/orchestration';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import type { QueryConfig } from '../query-core';
import type { OrchestrationSessionSummary } from './chatRuntimeTypes';
export interface ResolvedOpenSshHost {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityAgent: 'default' | 'configured' | 'disabled';
  proxyJump: string | null;
  strictHostKeyChecking: string;
}

export interface OpenSshDiscoveryResult {
  hosts: ResolvedOpenSshHost[];
  unavailableAliases: string[];
}

export type SshEnvironmentLaunchMode = 'attach' | 'managed';

export interface SshEnvironmentProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  hostAlias: string;
  remoteProjectPath: string;
  remotePort: number;
  /** station#1133 R2: 'attach' (default) is today's behavior; 'managed'
   * opts into the SSH launch bootstrap on a `station-unavailable` probe. */
  launchMode: SshEnvironmentLaunchMode;
  environmentId: string | null;
  hostIdentity: string | null;
  verifiedProjectPath: string | null;
  /** Remote $HOME captured by the worker probe at verification (station#1870);
   * null on profiles verified before the field existed — re-verify to record it. */
  remoteHome: string | null;
  workerProtocolVersion: number | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

export type SshEnvironmentState =
  | { phase: 'idle' }
  | { phase: 'starting'; attempt: number }
  | { phase: 'prompt'; prompt: 'password' | 'passphrase' | 'security-key' }
  | { phase: 'host-key'; reason: 'confirmation-required' | 'changed' }
  | { phase: 'agent'; reason: 'unavailable' | 'rejected' }
  | { phase: 'verifying' }
  /** station#1133 R3: the managed-launch bootstrap is running on the
   * remote host. Only reachable for `launchMode: 'managed'` profiles. */
  | { phase: 'launching' }
  | {
      phase: 'connected';
      localUrl: string;
      instanceId: string;
      sha: string;
      bootId: string;
      connectedAt: string;
      /** station#1133 R1/R4: only set for a `launchMode: 'managed'`
       * profile — 'external' for an already-running Station this feature
       * never started and will never stop; 'managed' for one this connect
       * started or reused. Omitted for `attach` profiles. */
      serverKind?: 'managed' | 'external';
    }
  | {
      phase: 'error';
      reason:
        | 'ssh-not-found'
        | 'config'
        | 'forward'
        | 'timeout'
        | 'worker-unavailable'
        | 'worker-incompatible'
        | 'station-unavailable'
        | 'project-unavailable'
        | 'identity-mismatch'
        | 'host-mismatch'
        | 'project-mismatch'
        | 'launch-node-not-found'
        | 'launch-unsupported-node-version'
        | 'launch-project-unavailable'
        | 'launch-port-in-use'
        | 'launch-readiness-timeout'
        | 'launch-requires-build'
        | 'launch-port-conflict'
        | 'launch-failed';
      action: string;
    }
  | {
      phase: 'disconnected';
      reason: 'remote-closed' | 'transport-error' | 'stopped';
    };

export interface SshEnvironmentView {
  profile: SshEnvironmentProfile;
  state: SshEnvironmentState;
}

export interface CreateSshEnvironmentInput {
  name?: string;
  hostAlias: string;
  remoteProjectPath: string;
  remotePort?: number;
  launchMode?: SshEnvironmentLaunchMode;
}

export type SshReachabilityFailureCode =
  | 'ssh-not-found'
  | 'host-unknown'
  | 'connection-refused'
  | 'timeout'
  | 'network-unreachable'
  | 'auth-rejected'
  | 'host-key'
  | 'agent'
  | 'interactive-required'
  | 'config'
  | 'unknown';

/**
 * The server's answer to "Test connection" — the readiness-evidence shape
 * applied to a computer. Every sentence here was derived server-side from
 * OpenSSH's own output; a client renders `summary`/`action` and never
 * composes its own state word from these fields.
 */
export interface SshReachabilityEvidence {
  evidenceVersion: 1;
  level: 'discovered' | 'prerequisite-ready' | 'catalog-ready' | 'smoke-passed';
  freshness: 'fresh' | 'stale' | 'unknown';
  observedAt: string;
  reachable: boolean;
  summary: string;
  action?: string;
  resolved?: {
    hostname: string;
    user: string;
    port: number;
    identityAgent: 'default' | 'configured' | 'disabled';
  };
  /**
   * Present only when this host has never been confirmed from this computer.
   * Station records no host keys, so this is what the operator needs to make
   * that decision: the fingerprint to verify and the exact command that
   * records it. `action` is composed from `trustCommand` server-side, so a
   * client must render/copy this command rather than build its own.
   */
  unknownHost?: {
    fingerprint: string;
    keyType: string;
    /** The exact `known_hosts` line whose fingerprint is above. */
    knownHostsLine: string;
    /** Appends THAT line — it re-scans nothing, so the verified key is the trusted key. */
    trustCommand: string;
  };
  remoteNodeVersion?: string;
  failure?: { code: SshReachabilityFailureCode; detail: string };
}

/** station#1097 R1/R2: one connected SSH environment's remote session read. */
export interface RemoteEnvironmentSessions {
  environmentId: string;
  environmentName: string;
  sessions: OrchestrationSessionSummary[];
}

/** A connected environment whose session read failed/timed out (R3) — never
 * a blocking error, just a name to surface in an unobtrusive note. */
export interface RemoteEnvironmentUnavailable {
  environmentId: string;
  environmentName: string;
}

/** A connected SSH tunnel needs an outbound peer bearer before it can read. */
export interface RemoteEnvironmentAuthenticationRequired {
  environmentId: string;
  environmentName: string;
  action: 'provision_peer_credential';
}

export interface RemoteSessionsResult {
  environments: RemoteEnvironmentSessions[];
  unavailable: RemoteEnvironmentUnavailable[];
  authenticationRequired: RemoteEnvironmentAuthenticationRequired[];
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const apiBase = await _getApiBase();
  // The collection itself is `/api/environments/ssh`, with no trailing slash:
  // the server registers that exact path and 404s on `.../ssh/`. Callers
  // naturally write `'/'` for "the collection", so normalize it here rather
  // than depending on every call site remembering (#799). Both the list and
  // the create mutation used `'/'`, so adding an SSH environment from the UI
  // failed outright and the overview showed a permanent "Environments could
  // not be loaded" card on an entirely healthy instance.
  const suffix = path === '/' ? '' : path;
  const response = await authenticatedFetch(
    `${apiBase}/api/environments/ssh${suffix}`,
    init,
  );
  const result = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !result.success || result.data === undefined) {
    throw new Error(apiErrorMessage(result, 'SSH environment request failed'));
  }
  return result.data;
}

export function fetchSshEnvironments(): Promise<SshEnvironmentView[]> {
  return request<SshEnvironmentView[]>('/');
}

export function fetchOpenSshHosts(): Promise<OpenSshDiscoveryResult> {
  return request<OpenSshDiscoveryResult>('/hosts');
}

/**
 * station#1097 R1: read-only orchestration session summaries aggregated
 * server-side across every currently connected SSH environment, for the
 * Home work list's remote-session badge. The server owns the SSH tunnels
 * (a connected environment's `localUrl` is a loopback address on the
 * *server's* host, not necessarily reachable from this client), so this is
 * a plain GET against the server's own aggregation endpoint rather than a
 * client-side fan-out.
 */
export async function fetchRemoteSessions(): Promise<RemoteSessionsResult> {
  const result = await request<RemoteSessionsResult>('/sessions');
  // station#1778: `request<T>` asserts `ApiEnvelope<T>` over HTTP — an
  // assertion, not a validation. This path crosses TWO version boundaries
  // (this client → its server → a remote Station), so it is the most exposed
  // of them: a server older than ADR 0012 yields summaries whose required
  // `answerability` is `undefined` at runtime.
  return {
    ...result,
    environments: result.environments.map((environment) => ({
      ...environment,
      sessions: environment.sessions.map(withNormalizedAnswerability),
    })),
    // Older servers did not distinguish a rejected SSH-tunnel bearer from a
    // transport outage. Preserve their compatible empty value at this client
    // boundary while current servers always return the explicit array.
    authenticationRequired: result.authenticationRequired ?? [],
  };
}

export const sshEnvironmentQueries = {
  list: () => ({
    queryKey: ['ssh-environments'] as const,
    queryFn: fetchSshEnvironments,
    staleTime: 5_000,
  }),
  hosts: () => ({
    queryKey: ['ssh-environments', 'hosts'] as const,
    queryFn: fetchOpenSshHosts,
    staleTime: 30_000,
  }),
  remoteSessions: () => ({
    queryKey: ['ssh-environments', 'remote-sessions'] as const,
    queryFn: fetchRemoteSessions,
    staleTime: 10_000,
  }),
};

export function useSshEnvironmentsQuery(
  config?: QueryConfig<SshEnvironmentView[]>,
) {
  return useQuery({ ...sshEnvironmentQueries.list(), ...config });
}

export function useOpenSshHostsQuery(
  config?: QueryConfig<OpenSshDiscoveryResult>,
) {
  return useQuery({ ...sshEnvironmentQueries.hosts(), ...config });
}

/**
 * station#1097 R3: this query's own loading/error state must never gate the
 * Home work list's local items — callers default `data` to
 * `{environments: [], unavailable: []}` and treat this purely as an
 * additive, independently-arriving source (see `HomeView.tsx`).
 */
export function useRemoteSessionsQuery(
  config?: QueryConfig<RemoteSessionsResult>,
) {
  return useQuery({ ...sshEnvironmentQueries.remoteSessions(), ...config });
}

export function useCreateSshEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSshEnvironmentInput) =>
      request<SshEnvironmentView>('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: sshEnvironmentQueries.list().queryKey,
      });
    },
  });
}

/**
 * "Test connection" against a host that has no profile yet (audit CI-R1).
 * A mutation rather than a query on purpose: it is an explicit user act
 * that makes an outbound connection attempt, never something a render
 * triggers, and its result is not cached across hosts.
 */
export function useProbeSshEnvironmentMutation() {
  return useMutation({
    mutationFn: (hostAlias: string) =>
      request<SshReachabilityEvidence>('/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostAlias }),
      }),
  });
}

function useSshEnvironmentAction(action: 'connect' | 'disconnect') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request<SshEnvironmentView>(`/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: sshEnvironmentQueries.list().queryKey,
      });
    },
  });
}

export function useConnectSshEnvironmentMutation() {
  return useSshEnvironmentAction('connect');
}

export function useDisconnectSshEnvironmentMutation() {
  return useSshEnvironmentAction('disconnect');
}

export function useRemoveSshEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/environments/ssh/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      const result = (await response.json()) as ApiEnvelope<never>;
      if (!response.ok || !result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to remove SSH environment'),
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: sshEnvironmentQueries.list().queryKey,
      });
    },
  });
}
