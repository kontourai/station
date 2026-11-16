import {
  useOrchestrationSessionsQuery,
  useTasksQuery,
} from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { projectWaitingOnYouCounts } from './project-overview-model';
import { useProjectOverviewPreview } from './projectOverviewPreview';

/**
 * Tasks Waiting on you per Project slug (#5064): one Tasks read for every
 * Project and the shared session list, placed by the Overview's own rule
 * (`projectWaitingOnYouCounts`). A read that has not answered counts
 * nothing, so no dot appears from a guess. With the `project-overview`
 * Feature Preview off there is no Tasks read at all, and no dot.
 */
export function useProjectsWaitingOnYou(): ReadonlyMap<string, number> {
  const enabled = useProjectOverviewPreview();
  const { data: tasks } = useTasksQuery(undefined, { enabled });
  const sessionsQuery = useOrchestrationSessionsQuery();
  const sessions = sessionsQuery.data;
  const sessionsKnown = sessions !== undefined && !sessionsQuery.isError;
  return useMemo(
    () =>
      enabled && tasks
        ? projectWaitingOnYouCounts({
            tasks,
            sessions: sessions ?? [],
            sessionsKnown,
          })
        : new Map<string, number>(),
    [enabled, tasks, sessions, sessionsKnown],
  );
}
