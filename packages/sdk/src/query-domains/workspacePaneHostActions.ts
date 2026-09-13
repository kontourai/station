import type {
  WorkspacePaneHostActionCatalog,
  WorkspacePaneHostActionPrepareRequest,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  executeWorkspacePaneHostAction,
  getWorkspacePaneHostActions,
  prepareWorkspacePaneHostAction,
} from '../client/workspace-pane-host-actions';
import {
  type ApiRequestScope,
  type QueryConfig,
  useApiQuery,
} from '../query-core';
import { conversationQueries, orchestrationQueries } from '../queryFactories';

export function useWorkspacePaneHostActionsQuery(
  projectSlug: string,
  config?: QueryConfig<WorkspacePaneHostActionCatalog> & {
    requestScope?: ApiRequestScope;
  },
) {
  return useApiQuery(
    [
      'projects',
      projectSlug,
      'pane-host-actions',
      config?.requestScope?.apiBase ?? 'default',
      config?.requestScope?.authorityKey ?? 'default',
    ],
    async () =>
      getWorkspacePaneHostActions(
        config?.requestScope?.apiBase ?? (await _getApiBase()),
        projectSlug,
        { requestScope: config?.requestScope },
      ),
    {
      staleTime: 0,
      ...config,
      enabled: Boolean(projectSlug) && (config?.enabled ?? true),
    },
  );
}

export function useWorkspacePaneHostActionMutation(
  projectSlug: string,
  requestScope?: ApiRequestScope,
) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: async (request: WorkspacePaneHostActionPrepareRequest) => {
      const apiBase = requestScope?.apiBase ?? (await _getApiBase());
      const preparation = await prepareWorkspacePaneHostAction(
        apiBase,
        projectSlug,
        request,
        { requestScope },
      );
      return preparation.state === 'prepared'
        ? executeWorkspacePaneHostAction(
            apiBase,
            projectSlug,
            preparation.ticket,
            { requestScope },
          )
        : preparation;
    },
    onSuccess: async (result) => {
      if (result.state === 'unavailable') return;
      // A new host action starts outside the composer's mutation path. Refresh
      // canonical read models before exposing Open; a stale empty list is not
      // evidence that the newly created Session is missing.
      await Promise.allSettled([
        queryClient.invalidateQueries({
          queryKey: orchestrationQueries.sessions().queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: conversationQueries.inventory().queryKey,
        }),
      ]);
    },
  });
}
