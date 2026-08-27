import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  type MutationOptions,
  type QueryConfig,
  useApiQuery,
} from '../query-core';

export interface FileSystemBrowseEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileSystemBrowseResult {
  path: string;
  entries: FileSystemBrowseEntry[];
}

export interface ACPConnectionInfo {
  id: string;
  name: string;
  icon?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  enabled: boolean;
  status: string;
  modes: string[];
  sessionId: string | null;
  mcpServers: string[];
  slashCommands?: AcpSlashCommandDescriptor[];
  currentModel: string | null;
  source?: 'user' | 'plugin';
  interactive?: {
    args: string[];
  };
  configOptions?: Array<{
    category: string;
    currentValue?: string;
    /**
     * ACP select options arrive as { value, name } objects (OpenCode, Kiro);
     * plain strings are tolerated for engines that send the bare form.
     */
    options?: Array<string | { value: string; name?: string }>;
  }>;
  /**
   * Explicit opt-in (docs/design/connections-onboarding.md §5): ids of
   * Station tool servers passed through to this connection's ACP sessions
   * as MCP servers. Absent/empty ⇒ passthrough is off (the default).
   */
  provideToolServers?: string[];
  /**
   * Why the connection is unavailable, from the probe's most recent failure
   * (`acp-manager-view.ts`). Absent whenever the connection is available or
   * no probe has failed. `GET /api/acp/connections` has always carried it;
   * this type finally admits it so a setup surface can say what happened
   * instead of "this provider needs more setup" (CI-R8).
   */
  lastError?: { message: string; phase: string };
}

export interface ACPConnectionRegistryEntry {
  id: string;
  name: string;
  command: string;
  args?: string[];
  icon?: string;
  cwd?: string;
  description?: string;
  tags?: string[];
  source?: 'core' | 'plugin';
  sourceName?: string;
  /** The command was found on this Station host; it is not configured yet. */
  detected?: boolean;
  installed?: boolean;
  installedSource?: 'user' | 'plugin';
  interactive?: {
    args: string[];
  };
}

export interface AcpSlashCommandDescriptor {
  name: string;
  description?: string;
  hint?: string;
}

async function requestTemplates<T = any>(type?: string): Promise<T[]> {
  const apiBase = await _getApiBase();
  const suffix = type ? `?type=${encodeURIComponent(type)}` : '';
  const response = await authenticatedFetch(
    `${apiBase}/api/templates${suffix}`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch templates'));
  }
  return (result.data || []) as T[];
}

async function requestFileSystemBrowse(
  path?: string,
): Promise<FileSystemBrowseResult> {
  const apiBase = await _getApiBase();
  const suffix = path ? `?path=${encodeURIComponent(path)}` : '';
  const response = await authenticatedFetch(
    `${apiBase}/api/fs/browse${suffix}`,
  );
  const result = await response.json();
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to browse filesystem'));
  }
  return result.data as FileSystemBrowseResult;
}

export async function fetchACPConnections(): Promise<ACPConnectionInfo[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/acp/connections`);
  const result = (await response.json()) as {
    success: boolean;
    data?: ACPConnectionInfo[];
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch ACP connections'));
  }
  return result.data ?? [];
}

export async function fetchACPConnectionRegistry(): Promise<
  ACPConnectionRegistryEntry[]
> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/acp/registry`);
  const result = (await response.json()) as {
    success: boolean;
    data?: ACPConnectionRegistryEntry[];
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch ACP registry'));
  }
  return result.data ?? [];
}

export async function createACPConnection(data: {
  id: string;
  name?: string;
  command: string;
  args?: string[] | string;
  icon?: string;
  cwd?: string;
  enabled?: boolean;
}) {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/acp/connections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...data,
      args: typeof data.args === 'string' ? data.args.split(/\s+/) : data.args,
    }),
  });
  const result = (await response.json()) as {
    success: boolean;
    data?: ACPConnectionInfo;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to create ACP connection'));
  }
  return result.data;
}

export async function updateACPConnection(
  id: string,
  updates: Record<string, unknown>,
) {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/acp/connections/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: ACPConnectionInfo;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to update ACP connection'));
  }
  return result.data;
}

export async function deleteACPConnection(id: string): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/acp/connections/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to delete ACP connection'));
  }
}

export async function reconnectACPConnection(id: string): Promise<boolean> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/acp/connections/${encodeURIComponent(id)}/reconnect`,
    {
      method: 'POST',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
  };
  if (!result.success) {
    throw new Error('Failed to reconnect ACP connection');
  }
  return true;
}

export async function installACPConnectionRegistryEntry(
  id: string,
): Promise<ACPConnectionInfo | undefined> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/acp/registry/${encodeURIComponent(id)}/install`,
    {
      method: 'POST',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: ACPConnectionInfo;
    error?: string;
  };
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to install ACP registry entry'),
    );
  }
  return result.data;
}

export function useTemplatesQuery<T = any>(
  type?: string,
  config?: QueryConfig<T[]>,
) {
  return useApiQuery(
    ['templates', type ?? 'all'],
    () => requestTemplates<T>(type),
    config,
  );
}

export function useFileSystemBrowseQuery(
  path?: string,
  config?: QueryConfig<FileSystemBrowseResult>,
) {
  return useApiQuery(
    ['fs', 'browse', path ?? '~'],
    () => requestFileSystemBrowse(path),
    config,
  );
}

export function useACPConnectionsQuery(
  config?: QueryConfig<ACPConnectionInfo[]>,
) {
  return useApiQuery(['acp-connections'], () => fetchACPConnections(), {
    staleTime: config?.staleTime ?? 5_000,
    gcTime: config?.gcTime,
    enabled: config?.enabled ?? true,
  });
}

export function useACPConnectionRegistryQuery(
  config?: QueryConfig<ACPConnectionRegistryEntry[]>,
) {
  return useApiQuery(
    ['acp-connection-registry'],
    () => fetchACPConnectionRegistry(),
    {
      staleTime: config?.staleTime ?? 30_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? true,
    },
  );
}

export function useCreateACPConnectionMutation(
  options?: MutationOptions<
    ACPConnectionInfo | undefined,
    {
      id: string;
      name?: string;
      command: string;
      args?: string[] | string;
      icon?: string;
      cwd?: string;
      enabled?: boolean;
    }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    ACPConnectionInfo | undefined,
    Error,
    {
      id: string;
      name?: string;
      command: string;
      args?: string[] | string;
      icon?: string;
      cwd?: string;
      enabled?: boolean;
    }
  >({
    mutationFn: async (data) => createACPConnection(data),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['acp-connections'] });
      queryClient.invalidateQueries({
        queryKey: ['acp-connection-registry'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useInstallACPConnectionRegistryEntryMutation(
  options?: MutationOptions<ACPConnectionInfo | undefined, string>,
) {
  const queryClient = useQueryClient();
  return useMutation<ACPConnectionInfo | undefined, Error, string>({
    mutationFn: async (id) => installACPConnectionRegistryEntry(id),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['acp-connections'] });
      queryClient.invalidateQueries({
        queryKey: ['acp-connection-registry'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdateACPConnectionMutation(
  options?: MutationOptions<
    ACPConnectionInfo | undefined,
    { id: string; updates: Record<string, unknown> }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation<
    ACPConnectionInfo | undefined,
    Error,
    { id: string; updates: Record<string, unknown> }
  >({
    mutationFn: async ({ id, updates }) => updateACPConnection(id, updates),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['acp-connections'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useDeleteACPConnectionMutation(
  options?: MutationOptions<void, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => deleteACPConnection(id),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['acp-connections'] });
      queryClient.invalidateQueries({
        queryKey: ['acp-connection-registry'],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useReconnectACPConnectionMutation(
  options?: MutationOptions<boolean, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => reconnectACPConnection(id),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['acp-connections'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
