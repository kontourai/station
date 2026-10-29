import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchAgentCatalog } from '../client/agents';
import type { ApiRequestScope } from '../client/http';
import {
  type ProjectRoomAgentIntent,
  projectRoomAgentRequest,
} from '../client/project-room-agents';
import type { ProjectRoomGuards } from '../client/project-rooms';

export * from '../client/project-room-agents';

export function useProjectRoomAgent(
  scope: ApiRequestScope,
  slug: string,
  guard: ProjectRoomGuards,
  enabled: boolean,
) {
  const catalog = useQuery({
    queryKey: [
      'project-room-agents',
      scope.apiBase,
      scope.authorityKey,
      guard.expectedProjectId,
    ],
    enabled,
    retry: false,
    gcTime: 0,
    queryFn: ({ signal }) =>
      fetchAgentCatalog(scope.apiBase, { requestScope: scope, signal }),
  });
  const request = useMutation({
    retry: false,
    mutationFn: (
      operation:
        | ProjectRoomAgentIntent
        | { requestId: string; action: 'inspect' | 'reconcile' | 'cancel' },
    ) => {
      if (!enabled) throw new Error('Room Agent authority changed.');
      return projectRoomAgentRequest(scope, slug, guard, operation);
    },
  });
  return { catalog, request };
}
