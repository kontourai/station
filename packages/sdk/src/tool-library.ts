import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type {
  OwnAccessView,
  ToolAccessRequest,
  ToolLibraryView,
} from '@kontourai/station-contracts/tool-library';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './client/http';

export interface ToolLibraryClient {
  apiBase: string;
  principalId?: string;
  options?: ClientRequestOptions;
}
export async function readToolLibrary<T>(
  client: ToolLibraryClient,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await getJson(`${client.apiBase}/api/tool-library${path}`, {
    ...client.options,
    signal,
    maxResponseBytes: 2 * 1024 * 1024,
  });
  if (client.principalId && response.ok) {
    const envelope: { principalId?: unknown } = await response.clone().json();
    if (envelope.principalId !== client.principalId)
      throw new Error('Your account changed. Reopen this view.');
  }
  const result = await readEnvelopeOrThrow<T>(response);
  if (result === undefined) throw new Error('Tool access is unavailable.');
  return result;
}
export async function changeToolLibrary<T>(
  client: ToolLibraryClient,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<T | undefined> {
  return readEnvelopeOrThrow<T>(
    await mutateJson(
      `${client.apiBase}/api/tool-library${path}`,
      method,
      { ...client.options, maxResponseBytes: 2 * 1024 * 1024 },
      body,
    ),
  );
}
function key(client: ToolLibraryClient, path: string) {
  return [
    'tool-library',
    client.apiBase,
    client.options?.requestScope?.authorityKey ??
      client.principalId ??
      'unbound',
    path,
  ] as const;
}
export function useLibraryQuery<T>(
  client: ToolLibraryClient,
  path: string,
  enabled = true,
) {
  return useQuery({
    queryKey: key(client, path),
    queryFn: ({ signal }) => readToolLibrary<T>(client, path, signal),
    enabled,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
  });
}
export const useOwnToolAccess = (client: ToolLibraryClient, enabled = true) =>
  useLibraryQuery<OwnAccessView>(client, '/access', enabled);
export const useToolLibrary = (
  client: ToolLibraryClient,
  project?: string,
  enabled = true,
) =>
  useLibraryQuery<ToolLibraryView>(
    client,
    `/catalog${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    enabled,
  );
export const useToolRequests = (
  client: ToolLibraryClient,
  project?: string,
  enabled = true,
) =>
  useLibraryQuery<ToolAccessRequest[]>(
    client,
    `/requests${project ? `?project=${encodeURIComponent(project)}` : ''}`,
    enabled,
  );
export const useProjectAuthoredAgents = (
  client: ToolLibraryClient,
  project: string,
  enabled = true,
) =>
  useLibraryQuery<Array<{ slug: string; projectId: string; spec: AgentSpec }>>(
    client,
    `/projects/${encodeURIComponent(project)}/agents`,
    enabled,
  );
export function useToolLibraryChange(client: ToolLibraryClient) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({
      path,
      body,
      method,
    }: {
      path: string;
      body: unknown;
      method?: string;
    }) => changeToolLibrary(client, path, body, method),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['tool-library', client.apiBase],
      });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      await queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
  });
}
