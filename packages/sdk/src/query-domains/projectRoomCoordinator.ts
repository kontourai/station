import {
  coordinatorTaskHoldsSlot,
  type ProjectRoomCoordinatorSettings,
  type ProjectRoomCoordinatorView,
} from '@kontourai/station-contracts/project-room-coordinator';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { hasCapability } from '../capability';
import type { ApiRequestScope } from '../client/http';
import {
  getProjectRoomCoordinator,
  runProjectRoomStatusSweep,
  setProjectRoomCoordinatorSettings,
  startProjectRoomCoordinatorTasks,
} from '../client/project-room-coordinator';
import type { ProjectRoomGuards } from '../client/project-rooms';
import { readPublicStationCapabilities } from '../client/publicStationCapabilities';
import { useApiQuery } from '../query-core';

export * from '../client/project-room-coordinator';

/** How often an open card rechecks while a Task is starting or working. */
const ACTIVE_REFETCH_MS = 5_000;

/**
 * #5063: whether the host serves the `#general` coordinator's routes
 * (`projectRoomCoordinator`). `null`: the handshake could not be read.
 */
export function useProjectRoomCoordinatorCapability(enabled = true) {
  return useApiQuery(
    ['project-room-coordinator', 'capability'],
    async () => {
      const handshake = await readPublicStationCapabilities(
        await _getApiBase(),
      );
      return handshake
        ? hasCapability(handshake, 'projectRoomCoordinator')
        : null;
    },
    { staleTime: 5 * 60_000, retry: false, enabled },
  );
}

export function projectRoomCoordinatorKey(
  scope: ApiRequestScope,
  slug: string,
) {
  return [
    'project-room-coordinator',
    scope.apiBase,
    scope.authorityKey,
    slug,
  ] as const;
}

/** Whether a card still has work to watch: waiting, starting or working. */
export function projectRoomCoordinatorIsActive(
  view: ProjectRoomCoordinatorView | undefined,
): boolean {
  return !!view?.proposals.some((proposal) =>
    proposal.tasks.some(
      (task) =>
        task.state === 'waiting' || coordinatorTaskHoldsSlot(task.state),
    ),
  );
}

/**
 * #5063: the coordinator's cards in a Project's `#general`. Rechecks every
 * few seconds while a Task is waiting, starting or working, so the card
 * moves on as slots free and results arrive.
 */
export function useProjectRoomCoordinator(
  scope: ApiRequestScope,
  slug: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...projectRoomCoordinatorKey(scope, slug)],
    enabled: enabled && !!slug,
    retry: false,
    queryFn: ({ signal }) => getProjectRoomCoordinator(scope, slug, signal),
    refetchInterval: (query) =>
      projectRoomCoordinatorIsActive(query.state.data)
        ? ACTIVE_REFETCH_MS
        : false,
  });
}

/** #5063: Start (named rows) or Start all (none named) on one card. */
export function useStartProjectRoomCoordinatorTasks(
  scope: ApiRequestScope,
  slug: string,
  guard: ProjectRoomGuards,
) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input: { proposalId: string; rowIds?: readonly string[] }) =>
      startProjectRoomCoordinatorTasks(
        scope,
        slug,
        guard,
        input.proposalId,
        input.rowIds,
      ),
    onSuccess: (view) => {
      queryClient.setQueryData(
        [...projectRoomCoordinatorKey(scope, slug)],
        view,
      );
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: [...projectRoomCoordinatorKey(scope, slug)],
      });
    },
  });
}

/** #5063: the status sweep, posted as one message in `#general`. */
export function useProjectRoomStatusSweep(
  scope: ApiRequestScope,
  slug: string,
  guard: ProjectRoomGuards,
) {
  return useMutation({
    retry: false,
    mutationFn: () => runProjectRoomStatusSweep(scope, slug, guard),
  });
}

/** #5063: the Project's coordinator limits, from Project settings. */
export function useSetProjectRoomCoordinatorSettingsMutation(
  projectSlug: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: ProjectRoomCoordinatorSettings) =>
      setProjectRoomCoordinatorSettings(
        await _getApiBase(),
        projectSlug,
        settings,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({
        queryKey: ['project-room-coordinator'],
      });
    },
  });
}
