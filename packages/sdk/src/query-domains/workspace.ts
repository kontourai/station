import { useMutation, useQuery } from '@tanstack/react-query';
import { invokeAgent } from '../api';
import type { QueryConfig } from '../query-core';

export * from './workspaceConnections';
export * from './workspaceCredentialRecovery';
export * from './workspaceProjects';
export * from './workspaceWorkflows';

export function useInvokeAgent<T = any>(
  agentSlug: string,
  content: string,
  options?: { schema?: any; model?: string },
  config?: QueryConfig<T>,
) {
  return useQuery({
    queryKey: ['invoke', agentSlug, content, options],
    queryFn: () => invokeAgent(agentSlug, content, options),
    staleTime: config?.staleTime ?? 5 * 60 * 1000,
    enabled: config?.enabled ?? true,
  });
}

export function useAgentInvokeMutation(agentSlug: string) {
  return useMutation({
    mutationFn: (input: string) => invokeAgent(agentSlug, input),
  });
}
