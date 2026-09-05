import { _getApiBase } from '../api';
import {
  type InstalledPluginRecord,
  listPlugins,
  type PluginRecoveryPreview,
  previewPluginRecovery,
} from '../client/plugins';
import type { QueryConfig } from '../query-core';
import { useApiQuery } from '../query-core';
import type {
  AgentHealthStatus,
  PluginChangelogData,
  PluginProviderDetail,
  PluginSettingsData,
} from './plugin-types';

async function requestPluginSettings(
  name: string,
): Promise<PluginSettingsData> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/${encodeURIComponent(name)}/settings`,
  );
  const result = (await response.json()) as PluginSettingsData & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch plugin settings'));
  }
  return result;
}

async function requestPluginChangelog(
  name: string,
): Promise<PluginChangelogData> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/${encodeURIComponent(name)}/changelog`,
  );
  const result = (await response.json()) as PluginChangelogData & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch plugin changelog'),
    );
  }
  return result;
}

async function requestPluginProviders(
  name: string,
): Promise<PluginProviderDetail[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/${encodeURIComponent(name)}/providers`,
  );
  const result = (await response.json()) as {
    providers?: PluginProviderDetail[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch plugin providers'),
    );
  }
  return result.providers || [];
}

export async function requestAgentHealth(
  slug: string,
): Promise<AgentHealthStatus> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/agents/${encodeURIComponent(slug)}/health`,
  );
  const result = (await response.json()) as AgentHealthStatus;
  if (!response.ok || result.success === false) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch agent health'));
  }
  return result;
}

export async function waitForAgentHealth(
  slug: string,
  options?: { attempts?: number; intervalMs?: number },
): Promise<AgentHealthStatus | null> {
  const attempts = options?.attempts ?? 15;
  const intervalMs = options?.intervalMs ?? 2_000;

  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    try {
      const health = await requestAgentHealth(slug);
      if (health.healthy) {
        return health;
      }
    } catch {
      // Ignore transient agent boot errors while polling for readiness.
    }
  }

  return null;
}

export function usePluginsQuery(config?: QueryConfig<InstalledPluginRecord[]>) {
  return useApiQuery(
    ['plugins'],
    async () => listPlugins(await _getApiBase()),
    config,
  );
}

export function usePluginUpdatesQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['plugin-updates'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/check-updates`,
      );
      if (!response.ok) return [];
      const result = await response.json();
      return result.updates || [];
    },
    config,
  );
}

export function usePluginSettingsQuery(
  name: string | undefined,
  config?: QueryConfig<PluginSettingsData>,
) {
  return useApiQuery(
    ['plugin-settings', name ?? 'unknown'],
    () => requestPluginSettings(name!),
    { ...config, enabled: !!name && (config?.enabled ?? true) },
  );
}

export function usePluginChangelogQuery(
  name: string | undefined,
  config?: QueryConfig<PluginChangelogData>,
) {
  return useApiQuery(
    ['plugin-changelog', name ?? 'unknown'],
    () => requestPluginChangelog(name!),
    { ...config, enabled: !!name && (config?.enabled ?? true) },
  );
}

export function usePluginProvidersQuery(
  name: string | undefined,
  config?: QueryConfig<PluginProviderDetail[]>,
) {
  return useApiQuery(
    ['plugin-providers', name ?? 'unknown'],
    () => requestPluginProviders(name!),
    { ...config, enabled: !!name && (config?.enabled ?? true) },
  );
}

export function useRegistryPluginsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['registry-plugins'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/registry/plugins`,
      );
      const result = await response.json();
      return result.success ? result.data || [] : [];
    },
    config,
  );
}

import { authenticatedFetch } from '../client/http';

// ── Workspace Home role (station#3122 stage 3) ─────────
// The grant record is server-side; this build ships the read and revoke
// legs only. The status DOES ride the shared TanStack Query cache (5-minute
// staleTime through `useApiQuery`) — the honest authority rule is not "no
// cache" but "a cached `granted` never survives the server being unable to
// affirm it": `useWorkspaceHomeRoleStatus` (src-ui) consults `isError` and
// renders the floor whenever the last read failed, and every payload is
// reparsed fail-closed through the contract, so a value no server derived
// can never mount anything. There is NO client-side write path: granting
// awaits the distinct-origin consent surface, scoped separately.

import {
  parseWorkspaceHomeRoleStatus,
  type WorkspaceHomeRoleStatus,
} from '@kontourai/station-contracts/workspace-home-role';

import { apiErrorMessage } from '../api-core';
export const WORKSPACE_HOME_ROLE_QUERY_KEY = ['workspace-home-role'] as const;

export interface WorkspaceHomeRoleCandidateRecord {
  pluginName: string;
  paneId: string;
  name: string;
  version: string | null;
}

export interface WorkspaceHomeRoleRequestRecord {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /**
   * The distinct-origin consent page, or `null` when there is no browser way
   * in to this request — the consent listener is down and the caller decides
   * natively instead (station#3731). Optional AND nullable on purpose: a
   * status response omits the field, a creation response can carry null, and
   * a caller narrowing on `!== undefined` alone would be handed a null at
   * runtime (review LOW).
   */
  reviewUrl?: string | null;
}

/**
 * The server's derived Home role standing, reparsed fail-closed by the
 * contract on the client — a malformed payload reads as `none` (the
 * built-in floor), never as a grant.
 */
export async function fetchWorkspaceHomeRoleStatus(): Promise<WorkspaceHomeRoleStatus> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/plugins/home-role`);
  const result = (await response.json()) as {
    status?: unknown;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch the Home role status'),
    );
  }
  return parseWorkspaceHomeRoleStatus(result.status);
}

export function useWorkspaceHomeRoleQuery(
  config?: QueryConfig<WorkspaceHomeRoleStatus>,
) {
  return useApiQuery(
    [...WORKSPACE_HOME_ROLE_QUERY_KEY],
    fetchWorkspaceHomeRoleStatus,
    config,
  );
}

export async function fetchWorkspaceHomeRoleCandidates(): Promise<
  WorkspaceHomeRoleCandidateRecord[]
> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/home-role/candidates`,
  );
  const result = (await response.json()) as {
    candidates?: WorkspaceHomeRoleCandidateRecord[];
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      apiErrorMessage(result, 'Failed to fetch Home role candidates'),
    );
  }
  return result.candidates ?? [];
}

export function useWorkspaceHomeRoleCandidatesQuery(
  config?: QueryConfig<WorkspaceHomeRoleCandidateRecord[]>,
) {
  return useApiQuery(
    ['workspace-home-role-candidates'],
    fetchWorkspaceHomeRoleCandidates,
    config,
  );
}

/**
 * Opens a Home role request. This mints no authority: the returned
 * `reviewUrl` is the distinct-origin consent page (station#3677), and only
 * an authenticated, user-activated decision on that page can grant. A 503
 * here is the consent surface failing CLOSED — approvals are unavailable
 * while the rest of Station stays usable.
 *
 * `reviewUrl` is ABSENT when the consent listener is down and the caller can
 * decide in native OS chrome instead (station#3731). That is not a degraded
 * response to paper over: it says "there is no browser way in to this
 * request", and a caller without the native path must treat it as a refusal
 * rather than opening a popup at nothing.
 */
export async function createWorkspaceHomeRoleRequest(input: {
  pluginName: string;
  paneId: string;
}): Promise<WorkspaceHomeRoleRequestRecord> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/home-role/requests`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  const result = (await response.json()) as {
    request?: WorkspaceHomeRoleRequestRecord;
    error?: string;
  };
  if (!response.ok || !result.request?.id) {
    throw new Error(
      apiErrorMessage(result, 'Could not open a Home role request'),
    );
  }
  return result.request;
}

export async function fetchWorkspaceHomeRoleRequest(
  id: string,
): Promise<WorkspaceHomeRoleRequestRecord> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/home-role/requests/${encodeURIComponent(id)}`,
  );
  const result = (await response.json()) as {
    request?: WorkspaceHomeRoleRequestRecord;
    error?: string;
  };
  if (!response.ok || !result.request?.id) {
    throw new Error(apiErrorMessage(result, 'Home role request not found'));
  }
  return result.request;
}

/** Revocation: the built-in Home is what remains — the fail-closed direction. */
export async function revokeWorkspaceHomeRoleGrant(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/home-role`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      apiErrorMessage(result ?? {}, 'Failed to revoke the Home role'),
    );
  }
}

export async function requestPluginRecoveryPreview(name: string) {
  return previewPluginRecovery(await _getApiBase(), name);
}

export function usePluginRecoveryPreviewQuery(
  name: string | undefined,
  config?: QueryConfig<PluginRecoveryPreview>,
) {
  return useApiQuery(
    ['plugin-recovery-preview', name ?? 'unknown'],
    () => requestPluginRecoveryPreview(name!),
    {
      ...config,
      enabled: !!name && (config?.enabled ?? true),
    },
  );
}
