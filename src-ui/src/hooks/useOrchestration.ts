import {
  useOrchestrationProvidersQuery,
  useQueryClient,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { ensureOrchestrationEventStream } from './orchestration/ensureOrchestrationEventStream';

// Guardrailed by proof:repo-governance.
// fallow-ignore-next-line unused-export
export function useOrchestration(apiBase: string) {
  // archive#1225 resolved HERE (a real hook boundary)
  // and threaded through to the reconnect-fallback refetch — see
  // `rehydrateChatSession.ts`'s file-header note for why the module-level
  // SSE stream can't call `useQueryClient` itself.
  const queryClient = useQueryClient();
  useEffect(() => {
    ensureOrchestrationEventStream(apiBase, queryClient);
  }, [apiBase, queryClient]);

  const providersQuery = useOrchestrationProvidersQuery();

  return {
    providers: providersQuery.data || [],
    isLoadingProviders: providersQuery.isLoading,
  };
}
