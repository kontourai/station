import type { PluginInstallResult } from '@kontourai/station-contracts/plugin';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase, addProjectLayoutFromPlugin } from '../api';
import type { MutationOptions } from '../query-core';

function invalidatePluginQueries(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  queryClient.invalidateQueries({ queryKey: ['plugins'] });
  queryClient.invalidateQueries({ queryKey: ['plugin-updates'] });
}

function invalidatePluginGraphQueries(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  queryClient.invalidateQueries({ queryKey: ['layouts'] });
  queryClient.invalidateQueries({ queryKey: ['agents'] });
  queryClient.invalidateQueries({ queryKey: ['projects'] });
}

export async function reloadPlugins(): Promise<{
  success: boolean;
  loaded?: number;
}> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/plugins/reload`, {
    method: 'POST',
  });
  const result = (await response.json()) as {
    success: boolean;
    loaded?: number;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to reload plugins'));
  }
  return result;
}

/**
 * The operator's pre-install decision (station#4288), taken from the preview
 * the operator actually read. `contentDigest` is what makes it a decision
 * about BYTES rather than about a name: the server re-derives it from its own
 * staged copy and refuses — before writing anything — if the two differ.
 */
export interface PluginInstallConsent {
  permissions: string[];
  contentDigest: string;
  dependencies: string[];
  dependencyApprovals?: Array<{
    id: string;
    permissions: string[];
    contentDigest: string;
    dependencies: string[];
  }>;
}

export function usePluginInstallMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      source,
      skip,
      consent,
    }: {
      source: string;
      skip?: string[];
      consent: PluginInstallConsent;
    }): Promise<PluginInstallResult> => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/install`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, skip, consent }),
        },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(apiErrorMessage(result, 'Install failed'));
      return result;
    },
    onSuccess: () => {
      invalidatePluginQueries(queryClient);
      invalidatePluginGraphQueries(queryClient);
    },
  });
}

export function usePluginPreviewMutation() {
  return useMutation({
    mutationFn: async (source: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source }),
        },
      );
      return response.json();
    },
  });
}

/**
 * Preview a REGISTRY entry by catalog id. Registry listings carry provider
 * labels rather than source paths, so the server resolves the id through its
 * registry providers and stages the same source an install of that id would
 * use. An id the plugin registry cannot resolve answers
 * `{ valid: false, code: 'registry-plugin-not-found' }`, which is how a
 * caller learns the entry is not a plugin at all.
 */
export function usePluginRegistryPreviewMutation() {
  return useMutation({
    mutationFn: async (registryId: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ registryId }),
        },
      );
      return response.json();
    },
  });
}

export function usePluginUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/${encodeURIComponent(name)}/update`,
        { method: 'POST' },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(apiErrorMessage(result, 'Update failed'));
      return result;
    },
    onSuccess: () => {
      invalidatePluginQueries(queryClient);
    },
  });
}

export function usePluginRemoveMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      const result = await response.json();
      if (!result.success)
        throw new Error(apiErrorMessage(result, 'Remove failed'));
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      queryClient.invalidateQueries({ queryKey: ['layouts'] });
    },
  });
}

export function usePluginProviderToggleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      pluginName,
      disabled,
    }: {
      pluginName: string;
      disabled: string[];
    }) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/${encodeURIComponent(pluginName)}/overrides`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled }),
        },
      );
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

/**
 * Withdraws permissions a plugin currently holds (station#3815).
 *
 * Enforcement reads the grants store on every check, so the list this
 * invalidates is not a convenience — a stale `plugins` query would keep
 * showing a permission the plugin no longer has, which is the one kind of
 * staleness a permission review must never have.
 */
export function useRevokePluginPermissionMutation(
  options?: MutationOptions<
    PluginPermissionRevocationResult,
    { name: string; permissions: string[] }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    PluginPermissionRevocationResult,
    Error,
    { name: string; permissions: string[] }
  >({
    mutationFn: revokePluginPermissions,
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error, variables);
    },
  });
}

export interface PluginPermissionRevocationResult {
  granted: string[];
  reconciliation:
    | {
        status: 'completed';
        operationId?: string;
        generation?: number;
        effects: readonly string[];
      }
    | {
        status: 'winding-down' | 'superseded';
        operationId: string;
        generation: number;
      }
    | {
        status: 'incomplete';
        operationId?: string;
        generation?: number;
        failures: readonly string[];
      };
}

export async function revokePluginPermissions(input: {
  name: string;
  permissions: string[];
}): Promise<PluginPermissionRevocationResult> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/plugins/${encodeURIComponent(input.name)}/grant`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: input.permissions }),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    granted?: string[];
    reconciliation?: PluginPermissionRevocationResult['reconciliation'];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, 'Could not remove the permission'));
  }
  return {
    granted: result.granted ?? [],
    reconciliation: result.reconciliation ?? {
      status: 'incomplete',
      failures: ['runtime-unavailable'],
    },
  };
}

export function usePluginSettingsMutation(
  options?: MutationOptions<
    { success: boolean },
    { name: string; settings: Record<string, unknown> }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    { success: boolean },
    Error,
    { name: string; settings: Record<string, unknown> }
  >({
    mutationFn: async ({ name, settings }) => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/plugins/${encodeURIComponent(name)}/settings`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        },
      );
      const result = (await response.json()) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        throw new Error(
          apiErrorMessage(result, 'Failed to save plugin settings'),
        );
      }
      return result;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['plugin-settings', variables.name],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error, variables);
    },
  });
}

export function useReloadPluginsMutation(
  options?: MutationOptions<{ success: boolean; loaded?: number }, void>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => reloadPlugins(),
    onSuccess: (data) => {
      invalidatePluginQueries(queryClient);
      invalidatePluginGraphQueries(queryClient);
      options?.onSuccess?.(data, undefined);
    },
    onError: (error) => {
      options?.onError?.(error as Error, undefined);
    },
  });
}

export async function requestPluginRegistryInstallAction(
  id: string,
  action: 'install' | 'uninstall',
  options?: {
    /**
     * The operator's pre-install decision, taken from a preview of the
     * registry entry's resolved source (station#4288). Without it the server
     * refuses any registry plugin that contributes code (`entrypoint`,
     * `layout`, `workspacePanes`) — refusal, not a silent bundle-less
     * install, is the no-decision behavior.
     */
    consent?: PluginInstallConsent;
    /** Preview conflict components to skip, as `type:id` keys. */
    skip?: string[];
  },
): Promise<PluginInstallResult> {
  const apiBase = await _getApiBase();
  const response =
    action === 'install'
      ? await authenticatedFetch(`${apiBase}/api/registry/plugins/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            ...(options?.consent ? { consent: options.consent } : {}),
            ...(options?.skip ? { skip: options.skip } : {}),
          }),
        })
      : await authenticatedFetch(
          `${apiBase}/api/registry/plugins/${encodeURIComponent(id)}`,
          {
            method: 'DELETE',
          },
        );
  const result = await response.json();
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, result.message || `${action} failed`),
    );
  }
  return result as PluginInstallResult;
}

export function usePluginRegistryInstallMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    PluginInstallResult,
    Error,
    {
      id: string;
      action: 'install' | 'uninstall';
      consent?: PluginInstallConsent;
      skip?: string[];
    }
  >({
    mutationFn: async ({ id, action, consent, skip }) =>
      requestPluginRegistryInstallAction(id, action, { consent, skip }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registry', 'plugins'] });
      queryClient.invalidateQueries({
        queryKey: ['registry', 'plugins', 'installed'],
      });
      queryClient.invalidateQueries({ queryKey: ['registry-plugins'] });
      queryClient.invalidateQueries({ queryKey: ['plugins'] });
    },
  });
}

export function useAddLayoutFromPluginMutation(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (plugin: string) =>
      addProjectLayoutFromPlugin(projectSlug, plugin),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['projects', projectSlug, 'layouts'],
      });
    },
  });
}

export function useAddProjectLayoutFromPluginMutation(
  options?: MutationOptions<any, { projectSlug: string; plugin: string }>,
) {
  const queryClient = useQueryClient();
  return useMutation<any, Error, { projectSlug: string; plugin: string }>({
    mutationFn: async ({ projectSlug, plugin }) =>
      addProjectLayoutFromPlugin(projectSlug, plugin),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({
        queryKey: ['projects', variables.projectSlug, 'layouts'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error, variables);
    },
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import {
  revokeWorkspaceHomeRoleGrant,
  WORKSPACE_HOME_ROLE_QUERY_KEY,
} from './plugin-queries';
/**
 * Revokes the Workspace Home role (station#3122 stage 3). Removing the
 * record is the whole effect: the built-in Home needs no record to exist,
 * which is what makes it un-removable rather than merely un-removed.
 *
 * The transition to the floor is OPTIMISTIC: the moment the user revokes,
 * the cached status becomes `none` — the narrowing direction, always safe —
 * so a granted render cannot outlive the click on a slow or failing wire.
 * `onSettled` then refetches the server's derivation either way: a failed
 * revoke honestly restores `granted`; a successful one confirms the floor.
 */
export function useRevokeWorkspaceHomeRoleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revokeWorkspaceHomeRoleGrant,
    onMutate: async () => {
      await queryClient.cancelQueries({
        queryKey: [...WORKSPACE_HOME_ROLE_QUERY_KEY],
      });
      queryClient.setQueryData([...WORKSPACE_HOME_ROLE_QUERY_KEY], {
        state: 'none',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [...WORKSPACE_HOME_ROLE_QUERY_KEY],
      });
    },
  });
}
