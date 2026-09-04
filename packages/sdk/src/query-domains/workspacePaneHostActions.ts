import type {
  WorkspacePaneHostActionCatalog,
  WorkspacePaneHostActionPrepareRequest,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { useMutation } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  executeWorkspacePaneHostAction,
  getWorkspacePaneHostActions,
  prepareWorkspacePaneHostAction,
} from '../client/workspace-pane-host-actions';
import { type QueryConfig, useApiQuery } from '../query-core';

export function useWorkspacePaneHostActionsQuery(
  projectSlug: string,
  config?: QueryConfig<WorkspacePaneHostActionCatalog>,
) {
  return useApiQuery(
    ['projects', projectSlug, 'pane-host-actions'],
    async () => getWorkspacePaneHostActions(await _getApiBase(), projectSlug),
    {
      staleTime: 0,
      ...config,
      enabled: Boolean(projectSlug) && (config?.enabled ?? true),
    },
  );
}

export function useWorkspacePaneHostActionMutation(projectSlug: string) {
  return useMutation({
    retry: false,
    mutationFn: async (request: WorkspacePaneHostActionPrepareRequest) => {
      const apiBase = await _getApiBase();
      const preparation = await prepareWorkspacePaneHostAction(
        apiBase,
        projectSlug,
        request,
      );
      return preparation.state === 'prepared'
        ? executeWorkspacePaneHostAction(
            apiBase,
            projectSlug,
            preparation.ticket,
          )
        : preparation;
    },
  });
}
