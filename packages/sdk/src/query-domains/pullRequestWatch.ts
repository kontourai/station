import type {
  ProjectPullRequestWatchSettings,
  TaskPullRequestWatchModeInput,
  TaskPullRequestWatchView,
} from '@kontourai/station-contracts/pull-request-watch';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { hasCapability } from '../capability';
import { readPublicStationCapabilities } from '../client/publicStationCapabilities';
import {
  getTaskPullRequestWatch,
  setProjectPullRequestWatch,
  setTaskPullRequestWatch,
} from '../client/pull-request-watch';
import { type QueryConfig, useApiQuery } from '../query-core';

/**
 * #5066: whether the host serves pull request agent feedback, and so a
 * Task's pull request watch (`pullRequestFeedback`). `null`: the handshake
 * could not be read.
 */
export function usePullRequestFeedbackCapability() {
  return useApiQuery(
    ['pull-request-feedback', 'capability'],
    async () => {
      const handshake = await readPublicStationCapabilities(
        await _getApiBase(),
      );
      return handshake ? hasCapability(handshake, 'pullRequestFeedback') : null;
    },
    { staleTime: 5 * 60_000, retry: false },
  );
}

const taskWatchKey = (taskId: string) =>
  ['tasks', taskId, 'pull-request-watch'] as const;

/** #5066: what a Task watches, its fix attempts and refused agent actions. */
export function useTaskPullRequestWatchQuery(
  taskId: string,
  config?: QueryConfig<TaskPullRequestWatchView>,
) {
  return useApiQuery(
    [...taskWatchKey(taskId)],
    async () => getTaskPullRequestWatch(await _getApiBase(), taskId),
    { retry: false, ...config, enabled: !!taskId && (config?.enabled ?? true) },
  );
}

/** #5066: a person's choice for one Task: `on`, `off` (Stop watching) or `project`. */
export function useSetTaskPullRequestWatchMutation(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mode: TaskPullRequestWatchModeInput) =>
      setTaskPullRequestWatch(await _getApiBase(), taskId, mode),
    onSuccess: (view) => {
      queryClient.setQueryData([...taskWatchKey(taskId)], view);
    },
  });
}

/** #5066: whether a Project's Tasks watch their pull requests. */
export function useSetProjectPullRequestWatchMutation(projectSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: ProjectPullRequestWatchSettings) =>
      setProjectPullRequestWatch(await _getApiBase(), projectSlug, settings),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
